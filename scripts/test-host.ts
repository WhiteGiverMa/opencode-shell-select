import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Tool } from "@opencode/plugin/effect"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { Context, Effect, Layer, Predicate, Schema, type JsonSchema, type Scope } from "effect"
import { registerShellSelect } from "../src/server.js"
import { wrapShellTool } from "../src/runtime.js"
import type { ProbeSystem } from "../src/probe.js"
import { makeHarness, NativeOutput, toolContext } from "../test/harness.js"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`test:host: ${message}`)
}

type HostDefinition = {
  readonly inputSchema: JsonSchema.JsonSchema
  readonly outputSchema?: JsonSchema.JsonSchema
}
type HostResult = {
  readonly output?: unknown
  readonly content: ReadonlyArray<Tool.Content>
  readonly metadata?: Tool.Metadata
}
type HostRuntimeModule = {
  readonly definition: (tool: Tool.Info) => HostDefinition
  readonly execute: (tool: Tool.Info, input: unknown, context: Tool.Context) => Effect.Effect<HostResult, Tool.Error>
}
interface RealHooks {
  readonly register: (
    domain: "shell",
    name: "create.before",
    callback: (event: ShellCreateBefore) => Effect.Effect<void>,
  ) => Effect.Effect<Registration, never, Scope.Scope>
  readonly trigger: (
    domain: "shell",
    name: "create.before",
    event: ShellCreateBefore,
  ) => Effect.Effect<ShellCreateBefore>
}
type HostHooksModule = {
  readonly PluginHooks: {
    readonly Service: Context.Service<RealHooks, RealHooks>
    readonly node: unknown
  }
}
type HostLayerModule = {
  readonly LayerNode: {
    readonly compile: (node: unknown) => Layer.Layer<RealHooks>
  }
}

const root = process.env.OPENCODE_SOURCE_DIR
if (!root) {
  console.log("test:host: skipped (set OPENCODE_SOURCE_DIR to a local OpenCode v2.3.2 checkout)")
  process.exit(0)
}
const load = async (relative: string): Promise<unknown> => import(pathToFileURL(join(root, relative)).href)
const runtime = (await load("packages/core/src/tool/runtime.ts")) as HostRuntimeModule
const hostHooks = (await load("packages/core/src/plugin/hooks.ts")) as HostHooksModule
const hostLayers = (await load("packages/util/src/effect/layer-node.ts")) as HostLayerModule
const packageJSON = JSON.parse(await readFile(join(root, "packages/core/package.json"), "utf8")) as {
  readonly version?: unknown
}
assert(packageJSON.version === "2.3.2", `expected OpenCode core 2.3.2, found ${String(packageJSON.version)}`)

const shellSource = await readFile(join(root, "packages/core/src/shell.ts"), "utf8")
assert(
  shellSource.includes('yield* hooks.trigger("shell", "create.before", invocation)'),
  "Shell.create no longer triggers create.before in the caller effect",
)
const promptSource = await readFile(join(root, "packages/core/src/session/prompt.ts"), "utf8")
const runnerSource = await readFile(join(root, "packages/core/src/session/runner/llm.ts"), "utf8")
assert(promptSource.includes('hooks.trigger("session", "prompt"'), "prompt admission hook is missing")
assert(runnerSource.includes("InstructionState.prepare"), "runner instruction baseline preparation is missing")

const live = new Set(["/bin/bash", "/bin/sh"])
const io: ProbeSystem = {
  platform: "linux",
  env: {},
  which: (name) => {
    const path = `/bin/${name}`
    return live.has(path) ? path : undefined
  },
  isExecutable: (file) => live.has(file),
  isAppExecutionAlias: () => false,
}

function shellIDs(schema: JsonSchema.JsonSchema): readonly string[] {
  const properties = Predicate.isObject(schema.properties) ? schema.properties : {}
  const shell = properties.shell
  assert(Predicate.isObject(shell) && Array.isArray(shell.enum), "shell enum is missing")
  return shell.enum.filter((item): item is string => typeof item === "string")
}

function compatible(schema: JsonSchema.JsonSchema) {
  const text = JSON.stringify(schema)
  assert(!text.includes("exclusiveMinimum"), "schema contains exclusiveMinimum")
  assert(!text.includes("deprecated"), "schema contains deprecated")
  assert(!text.includes("patternProperties"), "schema contains provider-hostile patternProperties")
}

function outputShell(result: HostResult): unknown {
  return Predicate.isObject(result.output) ? result.output.shell : undefined
}

const layer = hostLayers.LayerNode.compile(hostHooks.PluginHooks.node)
const program = Effect.gen(function* () {
  const hooks = yield* hostHooks.PluginHooks.Service
  const harness = makeHarness({
    pluginOptions: { shells: ["bash", "sh"], cacheTtlMs: 60_000 },
    create: (invocation) => hooks.trigger("shell", "create.before", invocation),
  })
  const host: typeof harness.ctx = {
    ...harness.ctx,
    shell: {
      hook: (_name, callback) => hooks.register("shell", "create.before", callback),
    },
  }
  yield* registerShellSelect(host, io, () => 1_000)

  const direct = runtime.definition(harness.shell())
  assert(shellIDs(direct.inputSchema).join(",") === "bash,sh", "direct enum differs from the live probe")
  assert(direct.outputSchema !== undefined, "native structured output schema was dropped")
  compatible(direct.inputSchema)

  const fallback = yield* runtime.execute(harness.shell(), { command: "default" }, toolContext(undefined, "default"))
  assert(outputShell(fallback) === "/configured/default-shell", "real runtime changed default pass-through")
  assert(fallback.metadata?.shell === "default-shell", "default pass-through did not record its short shell name")
  assert(fallback.metadata?.preserved === true, "default pass-through dropped native metadata")
  const selected = yield* runtime.execute(
    harness.shell(),
    { command: "selected", shell: "SH" },
    toolContext(undefined, "selected"),
  )
  assert(outputShell(selected) === "/bin/sh", "Context.Reference did not reach the real PluginHooks callback")
  assert(selected.metadata?.shell === "sh", "explicit selection did not record its clean profile ID")
  assert(selected.metadata?.preserved === true, "native metadata was not preserved")

  const calls = ["bash", "sh", undefined, "sh", "bash"] as const
  const unrelated: ShellCreateBefore = {
    command: "unrelated",
    cwd: "/work",
    timeout: 0,
    shell: "/configured/default-shell",
    env: {},
  }
  const [results] = yield* Effect.all(
    [
      Effect.all(
        calls.map((shell, index) =>
          runtime.execute(
            harness.shell(),
            { command: `parallel-${index}`, ...(shell ? { shell } : {}) },
            toolContext(undefined, `parallel_${index}`),
          ),
        ),
        { concurrency: "unbounded" },
      ),
      hooks.trigger("shell", "create.before", unrelated),
    ],
    { concurrency: "unbounded" },
  )
  assert(results, "parallel host results are missing")
  for (const [index, result] of results.entries()) {
    const expected = calls[index] ? `/bin/${calls[index]}` : "/configured/default-shell"
    assert(outputShell(result) === expected, `parallel call ${index} crossed shell contexts`)
    assert(result.metadata?.shell === (calls[index] ?? "default-shell"), `parallel call ${index} crossed metadata`)
    assert(result.metadata?.preserved === true, `parallel call ${index} dropped native metadata`)
  }
  assert(unrelated.shell === "/configured/default-shell", "unrelated Shell.create inherited a selection")

  const invalid = yield* Effect.flip(
    runtime.execute(harness.shell(), { command: 42 }, toolContext(undefined, "invalid")),
  )
  assert(invalid.message.includes("Invalid arguments"), "real decoder did not reject invalid native input")

  const stale = harness.shell()
  live.delete("/bin/bash")
  const disappeared = yield* Effect.flip(
    runtime.execute(stale, { command: "must-not-run", shell: "bash" }, toolContext(undefined, "disappeared")),
  )
  assert(disappeared.message.includes("no longer executable"), "stale enum did not reach live selection")
  assert(disappeared.message.includes("Available shells: sh"), "live error does not list refreshed shells")
  assert(!harness.invocations.some((invocation) => invocation.command === "must-not-run"), "lost shell was executed")
  assert(shellIDs(runtime.definition(harness.shell()).inputSchema).join(",") === "sh", "reload retained lost enum")

  const codeInput = Schema.Struct({
    command: Schema.String,
    workdir: Schema.optionalKey(Schema.String),
    timeout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  })
  const codeTool: Tool.Info<typeof codeInput, typeof NativeOutput> = {
    ...harness.nativeShell(),
    input: codeInput,
    options: { codemode: true, pinned: true },
    execute: () => Effect.die("definition-only Code Mode tool"),
  }
  const wrappedCode = wrapShellTool(codeTool, ["sh"], () => Effect.die("definition-only selection"))
  assert(wrappedCode, "Code Mode wrapper was not created")
  const codeDefinition = runtime.definition(wrappedCode)
  assert(shellIDs(codeDefinition.inputSchema).join(",") === "sh", "full_codemode schema is incompatible")
  assert(wrappedCode.options?.pinned === true, "full_codemode pinned option was dropped")
  compatible(codeDefinition.inputSchema)

  const empty = wrapShellTool(harness.nativeShell(), [], () => Effect.die("definition-only selection"))
  assert(empty, "empty-availability wrapper was not created")
  compatible(runtime.definition(empty).inputSchema)
})

await Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(layer)))
console.log("test:host: OpenCode 2.3.2 Tool.runtime + PluginHooks + fiber isolation passed")
