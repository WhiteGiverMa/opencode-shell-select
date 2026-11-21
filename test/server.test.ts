import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode/plugin/effect"
import { Workspace } from "@opencode/schema/workspace"
import { Effect, Predicate, Schema, type JsonSchema } from "effect"
import type { ProbeSystem } from "../src/probe.js"
import { maxTrackedSessions, registerShellSelect } from "../src/server.js"
import { contextEvent, makeHarness, promptEvent, toolContext } from "./harness.js"
import { Session } from "@opencode/schema/session"

function fakePOSIX(initial = ["bash", "sh"]) {
  const live = new Set(initial.map((name) => `/bin/${name}`))
  let probes = 0
  const io: ProbeSystem = {
    platform: "linux",
    env: {},
    which: (name) => {
      if (["bash", "sh", "zsh"].includes(name)) probes++
      const path = `/bin/${name}`
      return live.has(path) ? path : undefined
    },
    isExecutable: (file) => live.has(file),
    isAppExecutionAlias: () => false,
  }
  return { io, live, probes: () => probes }
}

function shellEnum(input: Tool.ValueSchema): readonly string[] | undefined {
  if (!Schema.isSchema(input)) return undefined
  const json = Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" }).schema
  const properties = Predicate.isObject(json.properties) ? json.properties : {}
  const shell = properties.shell
  if (!Predicate.isObject(shell) || !Array.isArray(shell.enum)) return undefined
  return shell.enum.filter((item): item is string => typeof item === "string")
}

const setup = (pluginOptions: unknown = { shells: ["bash", "sh"], cacheTtlMs: 100 }) => {
  const probe = fakePOSIX()
  let now = 1_000
  const harness = makeHarness({ pluginOptions })
  return {
    ...probe,
    harness,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds
    },
    register: () => registerShellSelect(harness.ctx, probe.io, () => now),
  }
}

describe("plugin registration and pass-through", () => {
  test("enabled:false registers no transforms, hooks, or subscriber even with another invalid option", async () => {
    const { harness, register } = setup({ enabled: false, instructionKey: "INVALID/KEY" })
    await Effect.runPromise(Effect.scoped(register()))
    expect(harness.hookCounts()).toEqual({ session: 0, shell: 0, transforms: 0 })
    expect(shellEnum(harness.shell().input)).toBeUndefined()
  })

  test("remote workspaces do not probe or register local-shell behavior", async () => {
    const probe = fakePOSIX()
    const harness = makeHarness({ pluginOptions: { shells: ["sh"] }, workspaceID: Workspace.ID.create() })
    await Effect.runPromise(Effect.scoped(registerShellSelect(harness.ctx, probe.io, () => 0)))
    expect(harness.hookCounts()).toEqual({ session: 0, shell: 0, transforms: 0 })
    expect(probe.probes()).toBe(0)
  })

  test("registration wraps shell while preserving native metadata in direct and Code Mode forms", async () => {
    for (const codeMode of [false, true]) {
      const probe = fakePOSIX()
      const harness = makeHarness({ pluginOptions: { shells: ["bash", "sh"] }, codeMode })
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* registerShellSelect(harness.ctx, probe.io, () => 0)
            expect(shellEnum(harness.shell().input)).toEqual(["bash", "sh"])
            expect(harness.shell().output).toBe(harness.nativeShell().output)
            expect(harness.shell().freeform).toEqual({ type: "text" })
            expect(harness.shell().options).toEqual(
              codeMode ? { codemode: true, pinned: true } : { codemode: false },
            )
            expect(harness.hookCounts()).toEqual({ session: 4, shell: 1, transforms: 1 })
          }),
        ),
      )
    }
  })

  test("omitting shell delegates to the configured native default without selecting a profile", async () => {
    const { harness, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const result = yield* harness.shell().execute({ command: "printf default" }, toolContext())
          expect(result.output).toEqual({ shell: "/configured/default-shell", command: "printf default" })
          expect(result.content).toBe("/configured/default-shell")
          expect(result.metadata).toEqual({ preserved: true, shell: "default-shell" })
          expect(harness.invocations.map((invocation) => invocation.shell)).toEqual(["/configured/default-shell"])
        }),
      ),
    )
  })

  test("explicit selection records its clean profile ID and preserves native result fields", async () => {
    const { harness, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const result = yield* harness.shell().execute({ command: "printf sh", shell: "SH" }, toolContext())
          expect(result.output).toEqual({ shell: "/bin/sh", command: "printf sh" })
          expect(result.content).toBe("/bin/sh")
          expect(result.metadata).toEqual({ preserved: true, shell: "sh" })
        }),
      ),
    )
  })

  test("default pass-through strips Windows executable extensions without changing invocation.shell", async () => {
    const executable = "C:\\Program Files\\PowerShell\\7\\pwsh.EXE"
    const harness = makeHarness({ pluginOptions: { shells: ["bash", "sh"] }, defaultShell: executable })
    const probe = fakePOSIX()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* registerShellSelect(harness.ctx, probe.io, () => 0)
          const result = yield* harness.shell().execute({ command: "windows-default" }, toolContext())
          expect(result.output).toEqual({ shell: executable, command: "windows-default" })
          expect(result.metadata).toEqual({ preserved: true, shell: "pwsh" })
          expect(harness.invocations[0]?.shell).toBe(executable)
        }),
      ),
    )
  })

  test("an unknown requested shell fails clearly and never invokes the native command", async () => {
    const { harness, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const error = yield* Effect.flip(
            harness.shell().execute({ command: "must-not-run", shell: "missing" }, toolContext()),
          )
          expect(error).toBeInstanceOf(Tool.Error)
          expect(error.message).toContain('Shell "missing" is not available')
          expect(error.message).toContain("Available shells: bash, sh")
          expect(error.message).toContain("Omit the shell parameter")
          expect(harness.invocations).toEqual([])
        }),
      ),
    )
  })
})

describe("instruction entry lifecycle", () => {
  test("prompt publishes before first-turn preparation, deduplicates, and updates changed fingerprints", async () => {
    const { harness, live, advance, register } = setup({ shells: ["bash", "sh", "zsh"], cacheTtlMs: 100 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const sessionID = Session.ID.create()
          const order: string[] = []
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          order.push(harness.puts.length === 1 ? "entry-ready" : "entry-missing")
          order.push("InstructionState.prepare")
          expect(order).toEqual(["entry-ready", "InstructionState.prepare"])
          expect(harness.puts[0]).toMatchObject({ sessionID, key: "o3p.shell-select" })
          expect(String(harness.puts[0]?.value)).toContain("- bash")
          expect(String(harness.puts[0]?.value)).not.toContain("- zsh")

          yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(harness.puts).toHaveLength(1)

          live.add("/bin/zsh")
          advance(100)
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(harness.puts).toHaveLength(2)
          expect(String(harness.puts[1]?.value)).toContain("- zsh")
          expect(harness.reloads()).toBe(1)
          expect(shellEnum(harness.shell().input)).toEqual(["bash", "sh", "zsh"])

          advance(100)
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(harness.puts).toHaveLength(2)
          expect(harness.reloads()).toBe(1)
        }),
      ),
    )
  })

  test("observing and changing the native default shell publishes chronological instruction updates", async () => {
    const { harness, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const sessionID = Session.ID.create()
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(harness.puts).toHaveLength(1)
          expect(String(harness.puts[0]?.value)).not.toContain("Default shell when `shell` is omitted:")

          const first = { ...contextEvent(harness.shell()), sessionID }
          first.tools.shell!.description = "Execute. Commands run on Linux using bash."
          yield* harness.fireSession("context", first)
          expect(harness.puts).toHaveLength(2)
          expect(String(harness.puts[1]?.value)).toContain("Default shell when `shell` is omitted: bash.")
          expect(first.tools.shell?.description).toContain("using bash by default")

          yield* harness.fireSession("context", first)
          expect(harness.puts).toHaveLength(2)
          expect(first.tools.shell?.description.match(/Set the optional/gu)).toHaveLength(1)

          const changed = { ...contextEvent(harness.shell()), sessionID }
          changed.tools.shell!.description = "Execute. Commands run on Linux using pwsh."
          yield* harness.fireSession("context", changed)
          expect(harness.puts).toHaveLength(3)
          expect(String(harness.puts[2]?.value)).toContain("Default shell when `shell` is omitted: pwsh.")
          expect(String(harness.puts[2]?.value)).not.toContain("omitted: bash.")
          expect(changed.tools.shell?.description).toContain("using pwsh by default")
        }),
      ),
    )
  })

  test("probeOnRequest:false retains the snapshot on prompt but explicit selection force-refreshes", async () => {
    const { harness, live, advance, register } = setup({
      shells: ["bash", "sh", "zsh"],
      cacheTtlMs: 100,
      probeOnRequest: false,
    })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const sessionID = Session.ID.create()
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          live.add("/bin/zsh")
          advance(1_000)
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(harness.puts).toHaveLength(1)
          expect(shellEnum(harness.shell().input)).toEqual(["bash", "sh"])
          const result = yield* harness.shell().execute({ command: "zsh-ok", shell: "zsh" }, toolContext(sessionID))
          expect(result.output).toEqual({ shell: "/bin/zsh", command: "zsh-ok" })
          expect(harness.puts).toHaveLength(2)
          expect(shellEnum(harness.shell().input)).toEqual(["bash", "sh", "zsh"])
        }),
      ),
    )
  })

  test("session deletion forgets dedup state without affecting other sessions", async () => {
    const { harness, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const deleted = Session.ID.create()
          const retained = Session.ID.create()
          yield* harness.fireSession("prompt", promptEvent(deleted))
          yield* harness.fireSession("prompt", promptEvent(retained))
          expect(harness.puts).toHaveLength(2)
          yield* Effect.promise(() => harness.emitDeleted(deleted))
          yield* Effect.promise(() => harness.flushEvents())
          yield* harness.fireSession("prompt", promptEvent(deleted))
          yield* harness.fireSession("prompt", promptEvent(retained))
          expect(harness.puts.filter((put) => put.sessionID === deleted)).toHaveLength(2)
          expect(harness.puts.filter((put) => put.sessionID === retained)).toHaveLength(1)
        }),
      ),
    )
  })

  test("the tracking map is bounded and evicts the least recently published session", async () => {
    const { harness, register } = setup({ shells: ["sh"], cacheTtlMs: 60_000 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const sessions = Array.from({ length: maxTrackedSessions + 1 }, () => Session.ID.create())
          for (const sessionID of sessions) yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(harness.puts).toHaveLength(maxTrackedSessions + 1)
          const first = sessions[0]
          const last = sessions.at(-1)
          if (!first || !last) throw new Error("session fixtures missing")
          yield* harness.fireSession("prompt", promptEvent(last))
          expect(harness.puts).toHaveLength(maxTrackedSessions + 1)
          yield* harness.fireSession("prompt", promptEvent(first))
          expect(harness.puts).toHaveLength(maxTrackedSessions + 2)
        }),
      ),
    )
  })
})

describe("request schema synchronization", () => {
  test("context, compaction, and generate hooks update descriptions and input enums", async () => {
    const { harness, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const sessionID = Session.ID.create()
          for (const name of ["context", "compaction", "generate"] as const) {
            const event = { ...contextEvent(harness.shell()), sessionID }
            event.tools.shell!.description = "Execute. Commands run on Linux using bash."
            const input: JsonSchema.JsonSchema = {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            }
            event.tools.shell!.input = input
            yield* harness.fireSession(name, event)
            const tool = event.tools.shell
            expect(tool?.description).toContain("using bash by default unless `shell` selects a profile")
            expect(tool?.description).toContain("bash, sh")
            expect(tool?.description).not.toContain("using bash.")
            expect(String(harness.puts[0]?.value)).toContain("Default shell when `shell` is omitted: bash.")
            expect(tool?.input).toMatchObject({
              additionalProperties: false,
              properties: { shell: { type: "string", enum: ["bash", "sh"] } },
            })
          }
          expect(harness.puts).toHaveLength(1)
        }),
      ),
    )
  })
})

describe("parallel execution and live disappearance", () => {
  test("parallel selected, default, and unrelated Shell.create flows have zero cross-talk", async () => {
    const { harness, register } = setup({ shells: ["bash", "sh"], cacheTtlMs: 60_000 })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const calls = Array.from({ length: 24 }, (_, index) => ({
            command: `call-${index}`,
            shell: index % 3 === 0 ? undefined : index % 2 === 0 ? "bash" : "sh",
          }))
          const unrelated = {
            command: "unrelated",
            cwd: "/work",
            timeout: 0,
            shell: "/configured/default-shell",
            env: {},
          }
          const [results] = yield* Effect.all(
            [
              Effect.all(
                calls.map((call, index) =>
                  harness.shell().execute(call, toolContext(undefined, `call_${index}`)),
                ),
                { concurrency: "unbounded" },
              ),
              harness.fireShell(unrelated),
            ],
            { concurrency: "unbounded" },
          )
          expect(results.map((result) => result.output)).toEqual(
            calls.map((call) => ({
              shell: call.shell ? `/bin/${call.shell}` : "/configured/default-shell",
              command: call.command,
            })),
          )
          expect(results.map((result) => result.metadata)).toEqual(
            calls.map((call) => ({ preserved: true, shell: call.shell ?? "default-shell" })),
          )
          expect(unrelated.shell).toBe("/configured/default-shell")
          for (const invocation of harness.invocations) {
            const call = calls.find((item) => item.command === invocation.command)
            expect(invocation.shell).toBe(call?.shell ? `/bin/${call.shell}` : "/configured/default-shell")
          }
        }),
      ),
    )
  })

  test("a vanished cached shell refreshes, reloads, publishes, and fails without fallback", async () => {
    const { harness, live, register } = setup()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          const sessionID = Session.ID.create()
          yield* harness.fireSession("prompt", promptEvent(sessionID))
          expect(String(harness.puts[0]?.value)).toContain("- bash")
          live.delete("/bin/bash")
          const error = yield* Effect.flip(
            harness.shell().execute({ command: "must-not-run", shell: "bash" }, toolContext(sessionID)),
          )
          expect(error).toBeInstanceOf(Tool.Error)
          expect(error.message).toContain('Shell "bash" is no longer executable')
          expect(error.message).toContain("Available shells: sh")
          expect(harness.invocations).toEqual([])
          expect(harness.reloads()).toBe(1)
          expect(shellEnum(harness.shell().input)).toEqual(["sh"])
          expect(harness.puts).toHaveLength(2)
          expect(String(harness.puts[1]?.value)).not.toContain("- bash")

          const fallback = yield* harness.shell().execute({ command: "default-ok" }, toolContext(sessionID))
          expect(fallback.output).toEqual({ shell: "/configured/default-shell", command: "default-ok" })
        }),
      ),
    )
  })
})

describe("scope cleanup", () => {
  test("closing the plugin scope disposes hooks and transforms and invalidates late selections", async () => {
    const { harness, register } = setup()
    let stale: Tool.Info | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* register()
          stale = harness.shell()
          expect(harness.hookCounts()).toEqual({ session: 4, shell: 1, transforms: 1 })
        }),
      ),
    )
    expect(harness.hookCounts()).toEqual({ session: 0, shell: 0, transforms: 0 })
    expect(shellEnum(harness.shell().input)).toBeUndefined()
    if (!stale) throw new Error("stale wrapper missing")
    const error = await Effect.runPromise(
      Effect.flip(stale.execute({ command: "late", shell: "bash" }, toolContext())),
    )
    expect(error.message).toContain("unloaded")
    expect(harness.invocations).toEqual([])
  })
})
