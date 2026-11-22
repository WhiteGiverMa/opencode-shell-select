import type { OpenCodeEvent } from "@opencode/client/promise"
import type { EventSubscribeInput } from "@opencode/client/effect/api"
import {
  Agent,
  Location,
  Model,
  Provider,
  Tool,
} from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Effect, Queue, Schema, Scope, Stream, type Types } from "effect"
import type { ShellSelectHost } from "../src/server.js"

export const NativeInput = Schema.Struct({
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  background: Schema.optionalKey(Schema.Boolean),
})
export const NativeOutput = Schema.Struct({ shell: Schema.String, command: Schema.String })

export type NativeInput = typeof NativeInput.Type
export type InstructionWrite = {
  readonly sessionID: Session.ID
  readonly key: string
  readonly value: Schema.Json
}

export const toolContext = (sessionID = Session.ID.create(), id = "call_test"): Tool.Context => ({
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.create(),
  id: Tool.CallID.make(id),
  progress: () => Effect.void,
})

export const promptEvent = (sessionID: Session.ID): SessionHooks["prompt"] => ({
  sessionID,
  messageID: SessionMessage.ID.create(),
  prompt: { text: "test" },
  delivery: "steer",
})

export const contextEvent = (tool: Tool.Info): SessionHooks["context"] => ({
  sessionID: Session.ID.create(),
  agent: Agent.ID.make("build"),
  model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test") },
  system: [],
  messages: [],
  options: {},
  tools: {
    shell: {
      description: tool.description,
      input: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
})

function registration(dispose: () => void): Effect.Effect<Registration, never, Scope.Scope> {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope
    let active = true
    const close = Effect.sync(() => {
      if (!active) return
      active = false
      dispose()
    })
    yield* Scope.addFinalizer(scope, close)
    return { dispose: close }
  })
}

type UnknownCallback = (event: unknown) => Effect.Effect<void>
type EventType = NonNullable<EventSubscribeInput["types"]>[number]

export interface Harness {
  readonly ctx: ShellSelectHost
  readonly puts: InstructionWrite[]
  readonly invocations: ShellCreateBefore[]
  readonly instructionValues: Map<string, Schema.Json>
  readonly reloads: () => number
  readonly shell: () => Tool.Info
  readonly nativeShell: () => Tool.Info<typeof NativeInput, typeof NativeOutput>
  readonly fireSession: <Name extends keyof SessionHooks>(name: Name, event: SessionHooks[Name]) => Effect.Effect<void>
  readonly fireShell: (event: ShellCreateBefore) => Effect.Effect<void>
  readonly emitDeleted: (sessionID: Session.ID) => Promise<void>
  readonly flushEvents: () => Promise<void>
  readonly hookCounts: () => { session: number; shell: number; transforms: number }
}

export function makeHarness(options: {
  readonly pluginOptions?: unknown
  readonly codeMode?: boolean
  readonly nativeDescription?: string
  readonly defaultShell?: string
  readonly workspaceID?: PluginContext["location"]["workspaceID"]
  readonly create?: (event: ShellCreateBefore) => Effect.Effect<void>
} = {}): Harness {
  const puts: InstructionWrite[] = []
  const invocations: ShellCreateBefore[] = []
  const instructionValues = new Map<string, Schema.Json>()
  const sessionCallbacks = new Map<keyof SessionHooks, Set<UnknownCallback>>()
  const shellCallbacks = new Set<(event: ShellCreateBefore) => Effect.Effect<void>>()
  const transforms = new Set<(editor: import("@opencode/plugin/effect/tool").ToolEditor) => void>()
  const queue = Effect.runSync(Queue.unbounded<OpenCodeEvent>())
  let reloads = 0
  let shell: Tool.Info | undefined

  const fireSession = <Name extends keyof SessionHooks>(name: Name, event: SessionHooks[Name]) =>
    Effect.forEach(sessionCallbacks.get(name) ?? [], (callback) => callback(event), { discard: true })
  const fireShell = (event: ShellCreateBefore) =>
    Effect.forEach(shellCallbacks, (callback) => callback(event), { discard: true })

  const nativeShell = (): Tool.Info<typeof NativeInput, typeof NativeOutput> => ({
    name: "shell",
    description: options.nativeDescription ?? "Execute a shell command. Commands run on Linux using bash.",
    input: NativeInput,
    output: NativeOutput,
    freeform: { type: "text" },
    options: options.codeMode ? { codemode: true, pinned: true } : { codemode: false },
    execute: (input) =>
      Effect.gen(function* () {
        const invocation: ShellCreateBefore = {
          command: input.command,
          cwd: input.workdir ?? "/work",
          timeout: input.timeout ?? 0,
          shell: options.defaultShell ?? "/configured/default-shell",
          env: {},
        }
        yield* fireShell(invocation)
        if (options.create) yield* options.create(invocation)
        invocations.push({ ...invocation, env: { ...invocation.env } })
        return {
          output: { shell: invocation.shell, command: invocation.command },
          content: invocation.shell,
          metadata: { preserved: true },
        }
      }),
  })

  const editor: import("@opencode/plugin/effect/tool").ToolEditor = {
    list: () => (shell ? [{ ...shell, id: "shell" }] : []),
    get: (id) => (id === "shell" && shell ? { ...shell, id: "shell" } : undefined),
    namespace: () => undefined,
    add: (tool) => {
      if (tool.name === "shell") shell = tool
    },
    update: (id, update) => {
      if (id !== "shell" || !shell) return
      const mutable = { ...shell, options: shell.options && { ...shell.options } } as Types.Mutable<Tool.Info>
      update(mutable)
      shell = mutable
    },
    remove: (id) => {
      if (id === "shell") shell = undefined
    },
  }
  const rebuild = () => {
    shell = nativeShell()
    for (const transform of transforms) transform(editor)
  }
  rebuild()

  const sessionHook = (<Name extends keyof SessionHooks>(
    name: Name,
    callback: (event: SessionHooks[Name]) => Effect.Effect<void>,
  ) => {
    const wrapped: UnknownCallback = (event) => callback(event as SessionHooks[Name])
    const callbacks = sessionCallbacks.get(name) ?? new Set<UnknownCallback>()
    callbacks.add(wrapped)
    sessionCallbacks.set(name, callbacks)
    return registration(() => callbacks.delete(wrapped))
  }) as ShellSelectHost["session"]["hook"]

  const shellHook: ShellSelectHost["shell"]["hook"] = (<
    Name extends "create.before",
  >(name: Name, callback: (event: ShellCreateBefore) => Effect.Effect<void>) => {
    if (name !== "create.before") throw new Error("unsupported shell hook")
    shellCallbacks.add(callback)
    return registration(() => shellCallbacks.delete(callback))
  }) as ShellSelectHost["shell"]["hook"]

  const subscribe = (<Type extends EventType>(input?: { readonly types?: ReadonlyArray<Type> }) =>
    Stream.fromQueue(queue).pipe(
      Stream.filter((event) => {
        const types = input?.types as ReadonlyArray<string> | undefined
        return types === undefined || types.includes(event.type)
      }),
    )) as unknown as ShellSelectHost["event"]["subscribe"]

  const ctx: ShellSelectHost = {
    options: options.pluginOptions as PluginContext["options"],
    location: {
      directory: Schema.decodeUnknownSync(Location.Ref.fields.directory)("/work"),
      ...(options.workspaceID !== undefined ? { workspaceID: options.workspaceID } : {}),
    },
    event: { subscribe },
    session: {
      hook: sessionHook,
      instructions: {
        entry: {
          list: (input) =>
            Effect.sync(() => {
              const prefix = `${input.sessionID}/`
              return [...instructionValues.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([key, value]) => ({ key: key.slice(prefix.length), value })) as never
            }),
          remove: () => Effect.die("unused instruction remove"),
          put: (input) =>
            Effect.sync(() => {
              const write: InstructionWrite = {
                sessionID: input.sessionID,
                key: input.key,
                value: input.value,
              }
              puts.push(write)
              instructionValues.set(`${input.sessionID}/${input.key}`, input.value)
            }),
        },
      },
    },
    shell: { hook: shellHook },
    tool: {
      transform: (callback) => {
        transforms.add(callback)
        rebuild()
        return registration(() => {
          transforms.delete(callback)
          rebuild()
        })
      },
      reload: () =>
        Effect.sync(() => {
          reloads++
          rebuild()
        }),
    },
  }

  return {
    ctx,
    puts,
    invocations,
    instructionValues,
    reloads: () => reloads,
    shell: () => {
      if (!shell) throw new Error("shell tool missing")
      return shell
    },
    nativeShell,
    fireSession,
    fireShell,
    emitDeleted: async (sessionID) => {
      const event = { type: "session.deleted", data: { sessionID } } as unknown as OpenCodeEvent
      await Effect.runPromise(Queue.offer(queue, event))
    },
    flushEvents: () => Effect.runPromise(Effect.sleep("10 millis")),
    hookCounts: () => ({
      session: [...sessionCallbacks.values()].reduce((count, callbacks) => count + callbacks.size, 0),
      shell: shellCallbacks.size,
      transforms: transforms.size,
    }),
  }
}
