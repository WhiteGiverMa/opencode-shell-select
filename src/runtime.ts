import { Tool } from "@opencode/plugin/effect"
import { Context, Effect, Predicate, Schema, SchemaParser, SchemaTransformation, type JsonSchema } from "effect"
import { normalizeShellID } from "./config.js"
import type { ShellProfile, ShellSnapshot } from "./probe.js"

export { shellShortName } from "./shell-name.js"

export interface ShellCallContext {
  readonly requested?: { readonly id: string; readonly executable: string }
  resolved?: string
}

/** A fresh fiber-local box for every wrapped call, including default pass-through. */
export const SelectedShellRef = Context.Reference<ShellCallContext | undefined>("o3p.tool.shell-select/SelectedShell", {
  defaultValue: () => undefined,
})

const fieldDescription = "Shell profile for this call. Omit to use OpenCode's configured default shell."
const descriptionPrefix = " Set the optional `shell` parameter to choose a shell for this call: "
const defaultInstruction = "Omit `shell` to use OpenCode's configured default shell."
const blockedShellKey = "^shell$"
const nativeDefault = /Commands run on ([^.]+) using ([^.]+)\./u
const rewrittenDefault = /Commands run on ([^.]+) using ([^.]+) by default unless `shell` selects a profile\./u
const rewrittenMarker = "unless `shell` selects a profile"

const defaultLine = (shell: string) => `Default shell when \`shell\` is omitted: ${shell}.`
const defaultSentence = (os: string, shell: string) =>
  `Commands run on ${os} using ${shell} by default unless \`shell\` selects a profile.`

/** Read only OpenCode's native sentence, never our already-rewritten suffix. */
export function defaultShellFromDescription(description: string): string | undefined {
  const shell = nativeDefault.exec(description)?.[2]?.trim()
  if (!shell || shell.includes(rewrittenMarker)) return
  return shell
}

function describedDefaultShell(description: string): string | undefined {
  return rewrittenDefault.exec(description)?.[2]?.trim() || defaultShellFromDescription(description)
}

export function shellDescription(description: string, ids: readonly string[], defaultShell?: string) {
  const index = description.indexOf(descriptionPrefix)
  const previous = index === -1 ? description : description.slice(0, index)
  const observed = defaultShell ?? describedDefaultShell(previous)
  const match = nativeDefault.exec(previous)
  const native = match?.[1]
    ? previous.replace(nativeDefault, () => defaultSentence(match[1], observed ?? "OpenCode's configured default shell"))
    : previous
  const omission = match || observed === undefined ? defaultInstruction : defaultLine(observed)
  return ids.length ? `${native}${descriptionPrefix}${ids.join(", ")}. ${omission}` : native
}

export function renderInstructionPayload(snapshot: ShellSnapshot, defaultShell?: string): string {
  const { available } = snapshot
  const omission = defaultShell === undefined ? defaultInstruction : defaultLine(defaultShell)
  if (available.length === 0)
    return [
      omission,
      "No explicit shell profiles are currently available. Use the built-in `shell` tool without a `shell` parameter.",
    ].join("\n")
  return [
    "The built-in `shell` tool (`tools.shell` in Code Mode) can choose a shell per call.",
    omission,
    "Available shell profiles (use these IDs when the tool exposes the `shell` parameter):",
    ...available.map(({ id, family, description }) => `- ${id} (${family})${description ? `: ${description}` : ""}`),
  ].join("\n")
}

type Struct = Schema.Struct<Record<string, Schema.Codec<unknown, unknown>>>

function isStruct(input: unknown): input is Struct {
  return (
    Schema.isSchema(input) &&
    input.ast._tag === "Objects" &&
    "fields" in input &&
    Predicate.isObject(input.fields) &&
    Schema.isSchema(input.fields.command) &&
    Object.values(input.fields).every(Schema.isSchema)
  )
}

export function shellInput(input: Tool.ValueSchema, ids: readonly string[]): Tool.ValueSchema | undefined {
  if (!isStruct(input)) return
  // Runtime decoding deliberately accepts any string. An enum captured by a request can be stale by the
  // time it executes; the wrapper must see it and return the live, actionable Tool.Error instead.
  const runtime = input.mapFields((fields) => ({ ...fields, shell: Schema.optional(Schema.String) }))
  const [first] = ids
  const advertised =
    first === undefined
      // Keep a stale explicit selection visible to our executor instead of letting Core's input-repair
      // hook strip it as an unknown key. This open fallback exists only while no enum can be advertised.
      ? Schema.StructWithRest(input, [Schema.Record(Schema.String, Schema.Unknown)])
      : input.mapFields((fields) => ({
          ...fields,
          shell: Schema.optionalKey(ids.length === 1 ? Schema.Literal(first) : Schema.Literals(ids)).annotate({
            description: fieldDescription,
          }),
        }))

  type Input = typeof runtime.Type
  return Schema.declareConstructor<Input>()(
    [],
    () => (value, _self, options) => SchemaParser.decodeUnknownEffect(runtime)(value, options),
    {
      toCodecJson: () =>
        Schema.link<Input>()(advertised, SchemaTransformation.passthrough<Input, typeof advertised.Type>({ strict: false })),
    },
  )
}

/** Keep the request-time JSON Schema in sync with the registry schema after a live probe changes. */
export function syncToolSchema(input: JsonSchema.JsonSchema, ids: readonly string[]): JsonSchema.JsonSchema {
  const properties = Predicate.isObject(input.properties) ? input.properties : {}
  const { shell: _shell, ...nativeProperties } = properties
  const patterns = Predicate.isObject(input.patternProperties) ? { ...input.patternProperties } : {}
  // Remove the pre-0.1 development draft's marker if a request carried it across a hot reload.
  if (patterns[blockedShellKey] === false) delete patterns[blockedShellKey]
  const { properties: _properties, patternProperties: _patternProperties, ...base } = input
  return {
    ...base,
    type: "object",
    additionalProperties: ids.length ? false : {},
    ...(Object.keys(patterns).length ? { patternProperties: patterns } : {}),
    properties: {
      ...nativeProperties,
      ...(ids.length ? { shell: { type: "string", enum: [...ids], description: fieldDescription } } : {}),
    },
  }
}

export type SelectShell = (id: string, sessionID: Tool.Context["sessionID"]) => Effect.Effect<ShellProfile, Tool.Error>

export function wrapShellTool(
  tool: Tool.Info,
  ids: readonly string[],
  select: SelectShell,
  defaultShell?: string,
): Tool.Info | undefined {
  const schema = shellInput(tool.input, ids)
  if (schema === undefined) return
  const execute = tool.execute
  const run = (input: unknown, context: Tool.Context, requested?: ShellCallContext["requested"]) => {
    const call: ShellCallContext = requested ? { requested } : {}
    return Effect.provideService(Effect.suspend(() => execute(input, context)), SelectedShellRef, call).pipe(
      Effect.map((result) =>
        call.resolved === undefined
          ? result
          : { ...result, metadata: { ...result.metadata, shell: call.resolved } },
      ),
    )
  }
  return {
    ...tool,
    input: schema,
    description: shellDescription(tool.description, ids, defaultShell),
    execute: (input: unknown, context) => {
      if (!Predicate.isObject(input) || !Object.hasOwn(input, "shell")) return run(input, context)
      const { shell, ...rest } = input
      if (shell === undefined) return run(rest, context)
      const id = typeof shell === "string" ? normalizeShellID(shell) : ""
      return select(id, context.sessionID).pipe(
        Effect.flatMap(({ id, executable }) => run(rest, context, { id, executable })),
      )
    },
  }
}
