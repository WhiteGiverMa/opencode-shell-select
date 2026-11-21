import { describe, expect, test } from "bun:test"
import { Tool } from "@opencode/plugin/effect"
import { Effect, Predicate, Schema, type JsonSchema } from "effect"
import type { ShellProfile, ShellSnapshot } from "../src/probe.js"
import {
  defaultShellFromDescription,
  renderInstructionPayload,
  SelectedShellRef,
  shellDescription,
  shellInput,
  shellShortName,
  syncToolSchema,
  wrapShellTool,
} from "../src/runtime.js"
import { NativeInput, NativeOutput, toolContext } from "./harness.js"

const profile = (id: string, executable = `/bin/${id}`): ShellProfile => ({
  id,
  executable,
  family: id === "bash" ? "bash" : "posix",
})

function jsonSchema(input: Tool.ValueSchema | undefined): JsonSchema.JsonSchema {
  if (!input || !Schema.isSchema(input)) throw new Error("expected an Effect schema")
  return Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" }).schema
}

function properties(input: JsonSchema.JsonSchema): Record<string, unknown> {
  return Predicate.isObject(input.properties) ? input.properties : {}
}

describe("tool description and instructions", () => {
  test("preserves the native default-shell name and replaces stale profile suffixes idempotently", () => {
    const native = "Execute. Commands run on Windows using powershell. Quote paths."
    const first = shellDescription(native, ["bash", "pwsh"])
    expect(first).toContain("Commands run on Windows using powershell by default unless `shell` selects a profile.")
    expect(first).toContain("bash, pwsh")
    expect(defaultShellFromDescription(native)).toBe("powershell")
    expect(defaultShellFromDescription(first)).toBeUndefined()
    const second = shellDescription(first, ["sh"])
    expect(shellDescription(second, ["sh"])).toBe(second)
    expect(second).toContain("using powershell by default")
    expect(second).toContain("sh.")
    expect(second).not.toContain("bash, pwsh")
    expect(second.match(/Set the optional/gu)).toHaveLength(1)
    expect(shellDescription(native, [])).toContain("using powershell by default")
    expect(shellDescription(first, ["pwsh"], "pwsh")).toContain("using pwsh by default")
  })

  test("uses a sensible omission fallback when no native sentence is present", () => {
    expect(shellDescription("Execute.", ["bash"])).toContain("Omit `shell` to use OpenCode's configured default shell.")
    expect(shellDescription("Execute.", ["bash"], "pwsh")).toContain("Default shell when `shell` is omitted: pwsh.")
  })

  test("normalizes configured default executable paths to shell names", () => {
    expect(shellShortName("/configured/default-shell")).toBe("default-shell")
    expect(shellShortName("/bin/bash")).toBe("bash")
    expect(shellShortName("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("bash")
    expect(shellShortName("C:\\Program Files\\PowerShell\\7\\pwsh.EXE")).toBe("pwsh")
    expect(shellShortName("C:\\Windows\\System32\\cmd.exe")).toBe("cmd")
    expect(shellShortName("C:\\Tools\\CUSTOM.BAT")).toBe("custom")
  })

  test("renders available profiles, the observed default, and an explicit empty state", () => {
    const snapshot: ShellSnapshot = {
      checkedAt: 0,
      platform: "linux",
      available: [{ ...profile("bash"), description: "GNU Bash" }],
      unavailable: [],
      fingerprint: "one",
    }
    expect(renderInstructionPayload(snapshot)).toContain("tools.shell")
    expect(renderInstructionPayload(snapshot)).toContain("- bash (bash): GNU Bash")
    expect(renderInstructionPayload(snapshot, "bash")).toContain("Default shell when `shell` is omitted: bash.")
    expect(renderInstructionPayload({ ...snapshot, available: [], fingerprint: "empty" }, "bash")).toContain(
      "No explicit shell profiles",
    )
    expect(renderInstructionPayload({ ...snapshot, available: [], fingerprint: "empty" }, "bash")).toContain(
      "Default shell when `shell` is omitted: bash.",
    )
  })
})

describe("schema augmentation", () => {
  test("advertises an optional enum and retains native runtime decoding", async () => {
    const wrapped = shellInput(NativeInput, ["bash", "sh"])
    const schema = jsonSchema(wrapped)
    expect(properties(schema).shell).toEqual({
      type: "string",
      enum: ["bash", "sh"],
      description: "Shell profile for this call. Omit to use OpenCode's configured default shell.",
    })
    expect(schema.required).toEqual(["command"])
    expect(schema.additionalProperties).toBe(false)
    expect(JSON.stringify(schema)).not.toContain("exclusiveMinimum")
    expect(JSON.stringify(schema)).not.toContain("deprecated")
    if (!wrapped || !Schema.isSchema(wrapped)) throw new Error("schema missing")
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(wrapped)({ command: "echo ok", shell: "BASH" }))).toEqual({
      command: "echo ok",
      shell: "BASH",
    })
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(wrapped)({ command: "echo ok", shell: "vanished" }))).toEqual({
      command: "echo ok",
      shell: "vanished",
    })
    expect(await Effect.runPromise(Schema.decodeUnknownEffect(wrapped)({ command: "echo ok" }))).toEqual({
      command: "echo ok",
    })
    expect(() => Schema.decodeUnknownSync(wrapped)({ command: 1 })).toThrow()
    expect(() => Schema.decodeUnknownSync(wrapped)({ command: "x", shell: 1 })).toThrow()
  })

  test("a single profile still emits an enum", () => {
    expect(properties(jsonSchema(shellInput(NativeInput, ["sh"]))).shell).toMatchObject({ enum: ["sh"] })
  })

  test("empty availability hides the field without provider-hostile patternProperties", () => {
    const schema = jsonSchema(shellInput(NativeInput, []))
    expect(properties(schema).shell).toBeUndefined()
    expect(schema.patternProperties).toBeUndefined()
    expect(JSON.stringify(schema)).toContain("additionalProperties")
  })

  test("returns undefined for a non-Effect or incompatible schema", () => {
    expect(shellInput({ type: "object" }, ["sh"])).toBeUndefined()
    expect(shellInput(Schema.Struct({ value: Schema.String }), ["sh"])).toBeUndefined()
  })

  test("syncToolSchema updates context schemas and removes development markers", () => {
    const input: JsonSchema.JsonSchema = {
      type: "object",
      description: "preserved",
      properties: { command: { type: "string" }, shell: { type: "string", enum: ["old"] } },
      required: ["command"],
      additionalProperties: false,
      patternProperties: { "^shell$": false, "^other$": { type: "string" } },
    }
    expect(syncToolSchema(input, ["bash", "sh"])).toEqual({
      type: "object",
      description: "preserved",
      properties: {
        command: { type: "string" },
        shell: {
          type: "string",
          enum: ["bash", "sh"],
          description: "Shell profile for this call. Omit to use OpenCode's configured default shell.",
        },
      },
      required: ["command"],
      additionalProperties: false,
      patternProperties: { "^other$": { type: "string" } },
    })
    const empty = syncToolSchema(input, [])
    expect(properties(empty).shell).toBeUndefined()
    expect(empty.additionalProperties).toEqual({})
    expect(empty.patternProperties).toEqual({ "^other$": { type: "string" } })
  })
})

describe("shell tool wrapper", () => {
  function baseTool(delay = false) {
    const seen: Array<{ input: NativeInput; selected: string | undefined }> = []
    const tool: Tool.Info<typeof NativeInput, typeof NativeOutput> = {
      name: "shell",
      description: "Commands run on Linux using bash.",
      input: NativeInput,
      output: NativeOutput,
      freeform: { type: "text" },
      options: { codemode: true, pinned: true },
      execute: (input) =>
        Effect.gen(function* () {
          if (delay) yield* Effect.sleep("2 millis")
          const call = yield* SelectedShellRef
          const selected = call?.requested?.executable
          const shell = selected ?? "/configured/default-shell"
          if (call) call.resolved = call.requested?.id ?? shellShortName(shell)
          seen.push({ input, selected })
          return {
            output: { shell, command: input.command },
            content: "ok",
            metadata: { preserved: true, native: "kept" },
          }
        }),
    }
    return { tool, seen }
  }

  test("preserves output, freeform, options, and omission pass-through object identity", async () => {
    const { tool, seen } = baseTool()
    const wrapped = wrapShellTool(tool, ["bash", "sh"], (id) => Effect.succeed(profile(id)))
    if (!wrapped) throw new Error("wrapper missing")
    expect(wrapped.output).toBe(tool.output)
    expect(wrapped.freeform).toEqual(tool.freeform)
    expect(wrapped.options).toEqual(tool.options)
    const input: NativeInput = { command: "printf default", workdir: "/work" }
    const result = await Effect.runPromise(wrapped.execute(input, toolContext()))
    expect(seen).toEqual([{ input, selected: undefined }])
    expect(seen[0]?.input).toBe(input)
    expect(result.output).toEqual({ shell: "/configured/default-shell", command: "printf default" })
    expect(result.content).toBe("ok")
    expect(result.metadata).toEqual({ preserved: true, native: "kept", shell: "default-shell" })
  })

  test("selects case-insensitively and strips the plugin-only argument", async () => {
    const { tool, seen } = baseTool()
    const requested: string[] = []
    const wrapped = wrapShellTool(tool, ["bash"], (id) => {
      requested.push(id)
      return Effect.succeed(profile(id, "/usr/local/bin/bash"))
    })
    if (!wrapped) throw new Error("wrapper missing")
    const result = await Effect.runPromise(
      wrapped.execute({ command: "echo ok", timeout: 5, shell: " BASH " }, toolContext()),
    )
    expect(requested).toEqual(["bash"])
    expect(seen).toEqual([{ input: { command: "echo ok", timeout: 5 }, selected: "/usr/local/bin/bash" }])
    expect(result.output).toEqual({ shell: "/usr/local/bin/bash", command: "echo ok" })
    expect(result.content).toBe("ok")
    expect(result.metadata).toEqual({ preserved: true, native: "kept", shell: "bash" })
  })

  test("an explicit undefined behaves as omission", async () => {
    const { tool, seen } = baseTool()
    const wrapped = wrapShellTool(tool, ["bash"], (id) => Effect.succeed(profile(id)))
    if (!wrapped) throw new Error("wrapper missing")
    const result = await Effect.runPromise(wrapped.execute({ command: "x", shell: undefined }, toolContext()))
    expect(seen).toEqual([{ input: { command: "x" }, selected: undefined }])
    expect(result.metadata?.shell).toBe("default-shell")
  })

  test("propagates Tool.Error without invoking the native executor", async () => {
    const { tool, seen } = baseTool()
    const wrapped = wrapShellTool(tool, [], (id) =>
      Effect.fail(new Tool.Error({ message: `Shell ${id} is unavailable` })),
    )
    if (!wrapped) throw new Error("wrapper missing")
    const error = await Effect.runPromise(Effect.flip(wrapped.execute({ command: "x", shell: "gone" }, toolContext())))
    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toContain("unavailable")
    expect(seen).toEqual([])
  })

  test("parallel calls keep fiber-local selections isolated, including default calls", async () => {
    const { tool, seen } = baseTool(true)
    const wrapped = wrapShellTool(tool, ["bash", "sh", "zsh"], (id) =>
      Effect.sleep("1 millis").pipe(Effect.as(profile(id))),
    )
    if (!wrapped) throw new Error("wrapper missing")
    const inputs = ["bash", "sh", "zsh", undefined, "bash", "sh"] as const
    const results = await Effect.runPromise(
      Effect.all(
        inputs.map((shell, index) =>
          wrapped.execute({ command: `call-${index}`, ...(shell ? { shell } : {}) }, toolContext(undefined, `call_${index}`)),
        ),
        { concurrency: "unbounded" },
      ),
    )
    expect(results.map((result) => result.output)).toEqual(
      inputs.map((shell, index) => ({
        shell: shell ? `/bin/${shell}` : "/configured/default-shell",
        command: `call-${index}`,
      })),
    )
    expect(results.map((result) => result.metadata)).toEqual(
      inputs.map((shell) => ({ preserved: true, native: "kept", shell: shell ?? "default-shell" })),
    )
    expect(seen).toHaveLength(inputs.length)
    expect(new Set(seen.map((entry) => entry.selected))).toEqual(
      new Set(["/bin/bash", "/bin/sh", "/bin/zsh", undefined]),
    )
  })
})
