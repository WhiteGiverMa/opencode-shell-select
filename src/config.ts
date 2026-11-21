import { Option, Predicate, Schema } from "effect"

export const instructionKeyPattern = /^[a-z0-9][a-z0-9._-]*$/u
export const defaultInstructionKey = "o3p.shell-select"
export const defaultCacheTtlMs = 60_000

export const normalizeShellID = (name: string) => name.trim().toLowerCase()

const Path = Schema.Trim.check(Schema.isPattern(/^[^\0]+$/u))
const Description = Schema.Trim.check(Schema.isNonEmpty())
const InstructionKey = Schema.String.check(Schema.isPattern(instructionKeyPattern))
const CacheTtl = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

function decode<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S, input: unknown): S["Type"] | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(input))
}

export interface ShellProfileConfig {
  readonly path?: string
  readonly description?: string
  readonly enabled?: boolean
}

export interface Config {
  readonly enabled: boolean
  readonly shells?:
    | { readonly mode: "only"; readonly names: readonly string[] }
    | { readonly mode: "merge"; readonly profiles: ReadonlyMap<string, ShellProfileConfig> }
  readonly cacheTtlMs: number
  readonly instructionKey: string
  readonly probeOnRequest: boolean
}

function validID(name: string): boolean {
  return instructionKeyPattern.test(name)
}

function profile(input: unknown): ShellProfileConfig {
  const path = decode(Path, input)
  if (path !== undefined) return { path }
  if (!Predicate.isObject(input)) return {}
  const description = decode(Description, input.description)
  const enabled = decode(Schema.Boolean, input.enabled)
  const override = decode(Path, input.path)
  return {
    ...(override !== undefined ? { path: override } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  }
}

function shells(input: unknown): Config["shells"] {
  if (Array.isArray(input)) {
    const names = input.flatMap((name) => {
      if (typeof name !== "string") return []
      const id = normalizeShellID(name)
      return validID(id) ? [id] : []
    })
    return { mode: "only", names: [...new Set(names)] }
  }
  if (!Predicate.isObject(input)) return
  const profiles = new Map<string, ShellProfileConfig>()
  for (const [name, raw] of Object.entries(input)) {
    const id = normalizeShellID(name)
    if (validID(id)) profiles.set(id, profile(raw))
  }
  return { mode: "merge", profiles }
}

/** Decode each option independently: one bad value must not reset the others. */
export function parseConfig(input: unknown): Config {
  const options = Predicate.isObject(input) ? input : {}
  const ttl = decode(CacheTtl, options.cacheTtlMs)
  return {
    enabled: decode(Schema.Boolean, options.enabled) ?? true,
    shells: shells(options.shells),
    cacheTtlMs: Math.floor(ttl ?? defaultCacheTtlMs),
    instructionKey: decode(InstructionKey, options.instructionKey) ?? defaultInstructionKey,
    probeOnRequest: decode(Schema.Boolean, options.probeOnRequest) ?? true,
  }
}
