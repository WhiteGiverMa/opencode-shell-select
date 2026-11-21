import { createHash } from "node:crypto"
import { accessSync, constants, existsSync, lstatSync, statSync } from "node:fs"
import { posix, win32 } from "node:path"
import which from "which"
import type { Config } from "./config.js"

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
}

export const system: ProbeSystem = {
  platform: process.platform,
  env: process.env,
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
