import { createHash } from "node:crypto"
import { accessSync, constants, existsSync, lstatSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { posix, win32 } from "node:path"
import which from "which"
import type { Config } from "./config.js"
import { shellShortName } from "./shell-name.js"

const WINDOWS = ["bash", "pwsh", "powershell", "cmd"]
const POSIX = ["bash", "zsh", "sh", "dash", "ksh", "pwsh"]

export interface ShellProfile {
  readonly id: string
  readonly executable: string
  readonly family: "bash" | "powershell" | "cmd" | "posix"
  readonly description?: string
}

export interface ShellSnapshot {
  readonly checkedAt: number
  readonly platform: NodeJS.Platform
  readonly available: readonly ShellProfile[]
  readonly unavailable: readonly string[]
  readonly fingerprint: string
}

export interface ProbeSystem {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly which: (name: string) => string | undefined
  readonly isExecutable: (file: string) => boolean
  readonly isAppExecutionAlias: (file: string) => boolean
  readonly readFile?: (file: string) => string | undefined
  readonly home?: string
}

export const system: ProbeSystem = {
  platform: process.platform,
  env: process.env,
  home: homedir(),
  which: (name) =>
    which.sync(name, {
      nothrow: true,
      path: process.env.PATH ?? process.env.Path ?? "",
      pathExt: process.env.PATHEXT ?? process.env.PathExt,
    }) ?? undefined,
  isExecutable(file) {
    try {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false
      if (process.platform !== "win32") accessSync(file, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  isAppExecutionAlias(file) {
    try {
      return lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink() === true && existsSync(file)
    } catch {
      return false
    }
  },
  readFile(file) {
    try {
      return readFileSync(file, "utf8")
    } catch {
      return undefined
    }
  },
}

export function isLive(io: ProbeSystem, executable: string): boolean {
  return (io.platform === "win32" && io.isAppExecutionAlias(executable)) || io.isExecutable(executable)
}

const unquote = (value: string) => value.trim().replace(/^"(.*)"$/u, "$1")

function windowsPath(file: string) {
  return file.replace(/^\/(?:(?:cygdrive|mnt)\/)?([a-z]):?(?:[/\\]|$)/iu, (_, drive: string) => `${drive.toUpperCase()}:/`)
}

function resolveProfile(io: ProbeSystem, id: string, override: string | undefined): string | undefined {
  const windows = io.platform === "win32"
  const path = windows ? win32 : posix
  const livePath = (file: string) => {
    const executable = path.normalize(windows ? windowsPath(file) : file)
    return isLive(io, executable) ? executable : undefined
  }
  const find = (value: string) => {
    const name = windows ? windowsPath(unquote(value)) : value
    if (!name) return
    if (path.isAbsolute(name)) return livePath(name)
    if (path.dirname(name) !== ".") return
    const fromPath = io.which(name)
    const executable = fromPath && livePath(path.resolve(fromPath))
    if (executable) return executable
    if (!windows) return

    // Store aliases may be executable even when stat (and therefore which) fails.
    const file = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`
    const paths = (io.env.PATH ?? io.env.Path ?? "").split(win32.delimiter).map(unquote).filter(Boolean)
    if (io.env.LOCALAPPDATA) paths.push(win32.join(io.env.LOCALAPPDATA, "Microsoft", "WindowsApps"))
    return paths.map((dir) => win32.resolve(dir, file)).find((alias) => io.isAppExecutionAlias(alias))
  }

  if (override !== undefined) return find(override)
  if (windows && id === "bash") {
    const preferred = io.env.OPENCODE_GIT_BASH_PATH
    const configured = preferred && find(preferred)
    if (configured) return configured
    const git = io.which("git")
    const gitBash = git && livePath(win32.resolve(git, "..", "..", "bin", "bash.exe"))
    if (gitBash) return gitBash
  }
  if (windows && id === "cmd") return (io.env.COMSPEC && find(io.env.COMSPEC)) || find("cmd.exe")
  return find(id)
}

function family(executable: string, windows: boolean): ShellProfile["family"] {
  const name = (windows ? win32.parse(executable).name : posix.basename(executable)).toLowerCase()
  if (name === "pwsh" || name === "powershell") return "powershell"
  if (name === "bash" || name === "cmd") return name
  return "posix"
}

export function probeShells(config: Config, io: ProbeSystem, checkedAt: number): ShellSnapshot {
  const platform = io.platform
  const builtIns = platform === "win32" ? WINDOWS : POSIX
  const overrides = config.shells?.mode === "merge" ? config.shells.profiles : undefined
  const names =
    config.shells?.mode === "only" ? config.shells.names : new Set([...builtIns, ...(overrides?.keys() ?? [])])
  const available: ShellProfile[] = []
  const unavailable: string[] = []
  for (const id of names) {
    const profile = overrides?.get(id)
    if (profile?.enabled === false) continue
    const executable = resolveProfile(io, id, profile?.path)
    if (!executable) {
      unavailable.push(id)
      continue
    }
    available.push({
      id,
      executable,
      family: family(executable, platform === "win32"),
      ...(profile?.description && { description: profile.description }),
    })
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([platform, available, unavailable])).digest("hex")
  return { checkedAt, platform, available, unavailable, fingerprint }
}

const DENIED_DEFAULT_SHELLS = new Set(["fish", "nu"])

function extractJsoncShell(text: string): string | undefined {
  // Strip block and line comments outside string literals, then parse top-level `"shell": "..."`.
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && next === "/") {
      i += 1
      while (i + 1 < text.length && text[i + 1] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 1
      continue
    }
    out += ch
  }
  // Remove trailing commas before `}` or `]` for lenient JSONC parsing.
  const cleaned = out.replace(/,(\s*[}\]])/gu, "$1")
  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (typeof parsed === "object" && parsed !== null && "shell" in parsed && typeof parsed.shell === "string") {
      const value = parsed.shell.trim()
      return value || undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

function configuredShellFromFiles(io: ProbeSystem, directory?: string): string | undefined {
  if (!io.readFile) return undefined
  const windows = io.platform === "win32"
  const path = windows ? win32 : posix
  const candidates: string[] = []
  const configDir =
    io.env.OPENCODE_CONFIG_DIR ||
    (io.env.XDG_CONFIG_HOME
      ? path.join(io.env.XDG_CONFIG_HOME, "opencode")
      : io.home
        ? path.join(io.home, ".config", "opencode")
        : undefined)
  if (configDir) {
    candidates.push(path.join(configDir, "opencode.json"), path.join(configDir, "opencode.jsonc"))
  }
  if (directory) {
    const ancestors: string[] = []
    let current = path.resolve(directory)
    while (true) {
      ancestors.push(current)
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
    for (const dir of ancestors.reverse()) {
      candidates.push(
        path.join(dir, "opencode.json"),
        path.join(dir, "opencode.jsonc"),
        path.join(dir, ".opencode", "opencode.json"),
        path.join(dir, ".opencode", "opencode.jsonc"),
      )
    }
  }
  let latest: string | undefined
  for (const file of candidates) {
    const raw = io.readFile(file)
    if (raw === undefined) continue
    const configured = extractJsoncShell(raw)
    if (configured !== undefined) latest = configured
  }
  return latest
}

/**
 * Predict OpenCode's default compatible shell at plugin boot (matching ShellSelect.resolve({ priority: "compat" }))
 * so the very first session's prompt baseline already carries the default shell name.
 * Still refined/superseded whenever `session.hook("context")` observes OpenCode's native shell description.
 */
export function predictDefaultShell(io: ProbeSystem, directory?: string): string | undefined {
  const resolveCompatible = (candidate: string | undefined): string | undefined => {
    if (!candidate) return undefined
    const short = shellShortName(candidate)
    if (!short || DENIED_DEFAULT_SHELLS.has(short)) return undefined
    const executable = resolveProfile(io, short, candidate === short ? undefined : candidate)
    return executable ? shellShortName(executable) : undefined
  }

  const configured = configuredShellFromFiles(io, directory)
  const fromConfig = resolveCompatible(configured)
  if (fromConfig) return fromConfig

  // Match ShellSelect.resolve: once `configShell` is set (even if missing or denied by `compat`),
  // OpenCode falls back straight to platform defaults without consulting `process.env.SHELL`.
  if (configured === undefined) {
    const fromEnv = resolveCompatible(io.env.SHELL)
    if (fromEnv) return fromEnv
  }

  if (io.platform === "win32") {
    for (const candidate of ["pwsh", "powershell", "bash", "cmd"]) {
      const executable = resolveProfile(io, candidate, undefined)
      if (executable) return shellShortName(executable)
    }
    return undefined
  }
  if (io.platform === "darwin") return "zsh"
  return resolveProfile(io, "bash", undefined) ? "bash" : "sh"
}

export function makeProbeCache(config: Config, io = system, now = Date.now) {
  let snapshot: ShellSnapshot | undefined
  return {
    read(refreshExpired = true) {
      const checkedAt = now()
      if (
        snapshot &&
        (!refreshExpired || (checkedAt >= snapshot.checkedAt && checkedAt - snapshot.checkedAt < config.cacheTtlMs))
      )
        return snapshot
      return (snapshot = probeShells(config, io, checkedAt))
    },
    invalidate() {
      snapshot = undefined
    },
  }
}
