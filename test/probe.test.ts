import { describe, expect, test } from "bun:test"
import { win32 } from "node:path"
import { parseConfig } from "../src/config.js"
import { isLive, makeProbeCache, predictDefaultShell, probeShells, system, type ProbeSystem } from "../src/probe.js"

function fakeIO(input: {
  readonly platform?: NodeJS.Platform
  readonly env?: NodeJS.ProcessEnv
  readonly paths?: ReadonlyArray<string>
  readonly aliases?: ReadonlyArray<string>
  readonly which?: Readonly<Record<string, string | undefined>>
} = {}) {
  const live = new Set(input.paths ?? [])
  const aliases = new Set(input.aliases ?? [])
  const whichCalls: string[] = []
  const io: ProbeSystem = {
    platform: input.platform ?? "linux",
    env: input.env ?? {},
    which: (name) => {
      whichCalls.push(name)
      return input.which?.[name]
    },
    isExecutable: (file) => live.has(file),
    isAppExecutionAlias: (file) => aliases.has(file),
  }
  return { io, live, aliases, whichCalls }
}

describe("shell probing", () => {
  test("discovers POSIX shells, families, missing paths, and custom descriptions", () => {
    const { io } = fakeIO({
      paths: ["/bin/bash", "/usr/bin/zsh", "/bin/sh", "/opt/fish"],
      which: { bash: "/bin/bash", zsh: "/usr/bin/zsh", sh: "/bin/sh", fish: "/opt/fish" },
    })
    const snapshot = probeShells(
      parseConfig({ shells: { fish: { description: "Friendly shell" }, dash: { enabled: false } } }),
      io,
      100,
    )
    expect(snapshot.checkedAt).toBe(100)
    expect(snapshot.available.map((profile) => [profile.id, profile.executable, profile.family])).toEqual([
      ["bash", "/bin/bash", "bash"],
      ["zsh", "/usr/bin/zsh", "posix"],
      ["sh", "/bin/sh", "posix"],
      ["fish", "/opt/fish", "posix"],
    ])
    expect(snapshot.available.at(-1)?.description).toBe("Friendly shell")
    expect(snapshot.unavailable).toEqual(["ksh", "pwsh"])
    expect(snapshot.available.some((profile) => profile.id === "dash")).toBe(false)
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/u)
  })

  test("only mode excludes every built-in not explicitly named", () => {
    const { io, whichCalls } = fakeIO({ paths: ["/bin/sh"], which: { sh: "/bin/sh" } })
    const snapshot = probeShells(parseConfig({ shells: ["sh", "missing"] }), io, 0)
    expect(snapshot.available.map((profile) => profile.id)).toEqual(["sh"])
    expect(snapshot.unavailable).toEqual(["missing"])
    expect(whichCalls).toEqual(["sh", "missing"])
  })

  test("honors OPENCODE_GIT_BASH_PATH and translates POSIX-mounted Windows paths", () => {
    const executable = win32.normalize("C:/Program Files/Git/bin/bash.exe")
    const { io } = fakeIO({
      platform: "win32",
      env: { OPENCODE_GIT_BASH_PATH: '"/mnt/c/Program Files/Git/bin/bash.exe"' },
      paths: [executable],
    })
    const snapshot = probeShells(parseConfig({ shells: ["bash"] }), io, 0)
    expect(snapshot.available).toEqual([
      { id: "bash", executable, family: "bash" },
    ])
  })

  test("derives Git Bash from git.exe and cmd from COMSPEC", () => {
    const git = win32.normalize("C:/Program Files/Git/cmd/git.exe")
    const bash = win32.normalize("C:/Program Files/Git/bin/bash.exe")
    const cmd = win32.normalize("C:/Windows/System32/cmd.exe")
    const { io } = fakeIO({
      platform: "win32",
      env: { COMSPEC: cmd },
      paths: [git, bash, cmd],
      which: { git },
    })
    const snapshot = probeShells(parseConfig({ shells: ["bash", "cmd"] }), io, 0)
    expect(snapshot.available.map((profile) => [profile.id, profile.executable, profile.family])).toEqual([
      ["bash", bash, "bash"],
      ["cmd", cmd, "cmd"],
    ])
  })

  test("detects WindowsApps App Execution Aliases even when stat-based which cannot", () => {
    const alias = win32.normalize("C:/Users/Test/AppData/Local/Microsoft/WindowsApps/pwsh.exe")
    const { io } = fakeIO({
      platform: "win32",
      env: {
        LOCALAPPDATA: win32.normalize("C:/Users/Test/AppData/Local"),
        PATH: win32.normalize("C:/Tools"),
      },
      aliases: [alias],
    })
    const snapshot = probeShells(parseConfig({ shells: ["pwsh"] }), io, 0)
    expect(snapshot.available).toEqual([{ id: "pwsh", executable: alias, family: "powershell" }])
    expect(isLive(io, alias)).toBe(true)
    liveDisappears(io, alias)
    expect(isLive(io, alias)).toBe(true)
  })

  test("supports quoted PATH entries and custom executable overrides", () => {
    const pwsh = win32.normalize("C:/Program Files/PowerShell/7/pwsh.exe")
    const { io } = fakeIO({
      platform: "win32",
      env: { PATH: `"${win32.normalize("C:/Custom Tools")}"` },
      paths: [pwsh],
      which: { corporate: pwsh },
    })
    const snapshot = probeShells(
      parseConfig({ shells: { corporate: { path: "corporate", description: "Company PowerShell" } } }),
      io,
      0,
    )
    expect(snapshot.available[0]).toEqual({
      id: "corporate",
      executable: pwsh,
      family: "powershell",
      description: "Company PowerShell",
    })
  })

  test("rejects non-executable and relative paths containing separators", () => {
    const { io } = fakeIO({ paths: ["/bin/sh"], which: { sh: "/bin/sh" } })
    const snapshot = probeShells(
      parseConfig({ shells: { sh: { enabled: false }, bad: "./bin/sh", good: "sh" } }),
      io,
      0,
    )
    expect(snapshot.available.map((profile) => profile.id)).toEqual(["good"])
    expect(snapshot.unavailable).toContain("bad")
    expect(snapshot.unavailable).not.toContain("sh")
  })

  test("disabled profiles are neither probed nor reported unavailable", () => {
    const { io, whichCalls } = fakeIO()
    const snapshot = probeShells(parseConfig({ shells: { bash: { enabled: false }, sh: { enabled: true } } }), io, 0)
    expect(snapshot.available).toEqual([])
    expect(snapshot.unavailable).toContain("sh")
    expect(snapshot.unavailable).not.toContain("bash")
    expect(whichCalls).not.toContain("bash")
  })
})

function liveDisappears(io: ProbeSystem, file: string) {
  // Alias liveness deliberately follows the alias check; this helper makes that contract explicit.
  expect(io.isExecutable(file)).toBe(false)
}

describe("probe cache", () => {
  test("hits before TTL, expires at the boundary, honors sticky reads, and invalidates", () => {
    const { io, whichCalls } = fakeIO({ paths: ["/bin/sh"], which: { sh: "/bin/sh" } })
    let now = 1_000
    const cache = makeProbeCache(parseConfig({ shells: ["sh"], cacheTtlMs: 100 }), io, () => now)
    const first = cache.read()
    now += 99
    expect(cache.read()).toBe(first)
    expect(whichCalls).toHaveLength(1)
    now += 1
    const expired = cache.read()
    expect(expired).not.toBe(first)
    expect(expired.checkedAt).toBe(1_100)
    expect(whichCalls).toHaveLength(2)
    now += 1_000
    expect(cache.read(false)).toBe(expired)
    expect(whichCalls).toHaveLength(2)
    cache.invalidate()
    expect(cache.read(false).checkedAt).toBe(2_100)
    expect(whichCalls).toHaveLength(3)
  })

  test("zero TTL re-probes every non-sticky read and fingerprints ignore timestamps", () => {
    const { io, whichCalls } = fakeIO({ paths: ["/bin/sh"], which: { sh: "/bin/sh" } })
    let now = 0
    const cache = makeProbeCache(parseConfig({ shells: ["sh"], cacheTtlMs: 0 }), io, () => now)
    const first = cache.read()
    now++
    const second = cache.read()
    expect(whichCalls).toHaveLength(2)
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.checkedAt).not.toBe(second.checkedAt)
  })

  test("live executable disappearance is visible independently of the cache", () => {
    const { io, live } = fakeIO({ paths: ["/bin/sh"] })
    expect(isLive(io, "/bin/sh")).toBe(true)
    live.delete("/bin/sh")
    expect(isLive(io, "/bin/sh")).toBe(false)
  })
})

describe("predictDefaultShell", () => {
  test("reads global and project opencode.jsonc with project precedence", () => {
    const files: Record<string, string> = {
      "C:\\Users\\demo\\.config\\opencode\\opencode.jsonc": `{\n  // comment\n  "shell": "bash",\n}`,
      "C:\\repo\\opencode.json": `{"shell": "pwsh"}`,
    }
    const { io } = fakeIO({
      platform: "win32",
      env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
      which: {
        git: "C:\\Program Files\\Git\\cmd\\git.exe",
        pwsh: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      },
      paths: [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\Windows\\System32\\cmd.exe",
      ],
    })
    const withFiles: ProbeSystem = {
      ...io,
      home: "C:\\Users\\demo",
      readFile: (file) => files[file],
    }
    expect(predictDefaultShell(withFiles, "C:\\other")).toBe("bash")
    expect(predictDefaultShell(withFiles, "C:\\repo\\sub")).toBe("pwsh")
  })

  test("falls back past denied or missing configured shells directly to platform defaults", () => {
    const { io } = fakeIO({
      platform: "linux",
      env: { SHELL: "/usr/bin/zsh" },
      which: { zsh: "/usr/bin/zsh", bash: "/bin/bash" },
      paths: ["/usr/bin/zsh", "/bin/bash"],
    })
    const withFish: ProbeSystem = {
      ...io,
      home: "/home/demo",
      readFile: (file) => (file === "/home/demo/.config/opencode/opencode.json" ? `{"shell":"fish"}` : undefined),
    }
    expect(predictDefaultShell(withFish, "/work")).toBe("bash")
    expect(predictDefaultShell(io, "/work")).toBe("zsh")
  })
})

test("real host probes /bin/sh", () => {
  if (process.platform === "win32") return
  const snapshot = probeShells(parseConfig({ shells: ["sh"] }), system, Date.now())
  expect(snapshot.available.some((profile) => profile.id === "sh")).toBe(true)
})
