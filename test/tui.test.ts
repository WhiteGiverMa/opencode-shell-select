import { describe, expect, test } from "bun:test"
import plugin, {
  setupShellSelect,
  type SettingItem,
  type ShellSelectTuiContext,
  type ShellSelectTuiUI,
  type ToolDecorationContext,
  type ToolDecorator,
} from "../src/tui.js"

interface HarnessOptions {
  readonly settings?: boolean
  readonly tools?: boolean
}

function makeHarness(options: HarnessOptions = {}) {
  const settings: SettingItem[] = []
  const decorators = new Map<string, ToolDecorator>()
  const storeKeys: string[] = []
  const initialValues: object[] = []
  const disposed: string[] = []
  const ui: ShellSelectTuiUI = {
    ...(options.settings === false
      ? {}
      : {
          settings: {
            register(setting) {
              settings.push(setting)
              return () => {
                disposed.push(`setting:${setting.id}`)
              }
            },
          },
        }),
    ...(options.tools === false
      ? {}
      : {
          tools: {
            decorate(tool, decorator) {
              decorators.set(tool, decorator)
              return () => {
                disposed.push(`tool:${tool}`)
              }
            },
          },
        }),
  }
  const ctx: ShellSelectTuiContext = {
    storage: {
      store<Value extends object>(key: string, options: { readonly initial: Value }) {
        storeKeys.push(key)
        initialValues.push(options.initial)
        const value = options.initial
        return [
          value,
          async (mutation: (draft: Value) => void): Promise<void> => {
            mutation(value)
          },
        ] as const
      },
    },
    ui,
  }
  return { ctx, settings, decorators, storeKeys, initialValues, disposed }
}

type Harness = ReturnType<typeof makeHarness>

function setting(harness: Harness, id: string): SettingItem {
  const found = harness.settings.find((item) => item.id === id)
  if (!found) throw new Error(`setting ${id} was not registered`)
  return found
}

function decorator(harness: Harness): ToolDecorator {
  const found = harness.decorators.get("shell")
  if (!found) throw new Error("shell decorator was not registered")
  return found
}

function decorate(harness: Harness, overrides: Partial<ToolDecorationContext> = {}) {
  return decorator(harness)({
    tool: "shell",
    status: "completed",
    input: {},
    metadata: {},
    ...overrides,
  })
}

function runningShell(shell: string): NonNullable<ToolDecorationContext["shell"]> {
  return {
    id: "shell-test",
    status: "running",
    command: "echo test",
    cwd: "/work",
    shell,
    file: shell,
    metadata: {},
    time: { started: 0 },
  }
}

describe("official frontend compatibility", () => {
  test("shares the server plugin ID and silently no-ops without settings or tool decorators", () => {
    const harness = makeHarness({ settings: false, tools: false })
    expect(plugin.id).toBe("o3p.tool.shell-select")
    expect(setupShellSelect(harness.ctx)).toBeUndefined()
    expect(harness.storeKeys).toEqual([])
    expect(harness.settings).toEqual([])
    expect(harness.decorators.size).toBe(0)
    expect(harness.disposed).toEqual([])
  })
})

describe("persistent reactive settings", () => {
  test("registers the three Shell settings with their defaults and metadata", () => {
    const harness = makeHarness()
    expect(setupShellSelect(harness.ctx)).toBeTypeOf("function")
    expect(harness.storeKeys).toEqual(["settings"])
    expect(harness.initialValues).toEqual([{ header: true, headerGap: false, workdir: "header" }])
    expect(
      harness.settings.map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        description: item.description,
        values: item.values,
        labels: item.labels,
        keywords: item.keywords,
        value: item.value(),
      })),
    ).toEqual([
      {
        id: "header",
        title: "Header",
        category: "Shell",
        description: "Whether the shell tool card shows the shell name in a header",
        values: [false, true],
        labels: ["off", "on"],
        keywords: ["shell header", "shell title", "pwsh", "bash"],
        value: true,
      },
      {
        id: "header_gap",
        title: "Header spacing",
        category: "Shell",
        description: "Whether a blank line separates the shell header from the command",
        values: [false, true],
        labels: ["off", "on"],
        keywords: ["shell gap", "blank line", "spacing"],
        value: false,
      },
      {
        id: "workdir",
        title: "Workdir",
        category: "Shell",
        description: "Whether the shell working directory is shown in the header or as a cd prefix",
        values: ["header", "command"],
        labels: ["header", "command (cd)"],
        keywords: ["directory", "cwd", "cd", "copy"],
        value: "header",
      },
    ])
  })

  test("writes through the storage store and keeps getters and decoration reactive", async () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    const header = setting(harness, "header")
    const headerGap = setting(harness, "header_gap")
    const workdir = setting(harness, "workdir")

    const change = header.onChange(false)
    expect(change).toBeInstanceOf(Promise)
    await change
    await headerGap.onChange(true)
    await workdir.onChange("command")
    expect([header.value(), headerGap.value(), workdir.value()]).toEqual([false, true, "command"])
    expect(decorate(harness, { metadata: { shell: "bash" }, workdir: "/work" })).toBeUndefined()

    await header.onChange(true)
    await workdir.onChange("header")
    expect(decorate(harness, { metadata: { shell: "bash" }, workdir: "/work" })).toEqual({
      path: { label: "# bash in", value: "/work" },
      gap: 1,
      commandPrefix: "",
    })
  })
})

describe("shell tool decoration", () => {
  test("uses metadata.shell before input.shell and puts a valid workdir in the header by default", () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    expect(
      decorate(harness, {
        metadata: { shell: "bash" },
        input: { shell: "pwsh" },
        workdir: "/work/project",
      }),
    ).toEqual({
      path: { label: "# bash in", value: "/work/project" },
      gap: 0,
      commandPrefix: "",
    })
  })

  test("normalizes a streaming input.shell Windows executable before metadata exists", () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    expect(
      decorate(harness, {
        status: "streaming",
        input: { shell: "C:\\Program Files\\PowerShell\\7\\PWSH.EXE" },
        workdir: "C:\\work",
      }),
    ).toEqual({
      path: { label: "# pwsh in", value: "C:\\work" },
      gap: 0,
      commandPrefix: "",
    })
  })

  test("falls back to the running ShellInfo executable", () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    expect(
      decorate(harness, {
        status: "running",
        shell: runningShell("C:\\Program Files\\Git\\bin\\BASH.EXE"),
        workdir: "/work",
      }),
    ).toEqual({
      path: { label: "# bash in", value: "/work" },
      gap: 0,
      commandPrefix: "",
    })
  })

  test("renders only a shell title without a valid directory", () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    expect(decorate(harness, { metadata: { shell: "pwsh" } })).toEqual({ title: "# pwsh", gap: 0 })
    expect(decorate(harness, { metadata: { shell: "pwsh" }, workdir: "." })).toEqual({
      title: "# pwsh",
      gap: 0,
    })
    expect(decorate(harness, { workdir: "." })).toBeUndefined()
  })

  test("uses the generic shell label when a directory exists but no shell is known", () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    expect(decorate(harness, { workdir: "/work" })).toEqual({
      path: { label: "# shell in", value: "/work" },
      gap: 0,
      commandPrefix: "",
    })
  })

  test("keeps the native cd prefix in command mode and applies header spacing", async () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    await setting(harness, "workdir").onChange("command")
    await setting(harness, "header_gap").onChange(true)
    const decoration = decorate(harness, { metadata: { shell: "bash" }, workdir: "/work" })
    expect(decoration).toEqual({ title: "# bash", gap: 1 })
    expect(decoration?.commandPrefix).toBeUndefined()
  })

  test("can omit the shell name while retaining the workdir header", async () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    await setting(harness, "header").onChange(false)
    expect(decorate(harness, { metadata: { shell: "bash" }, workdir: "/work" })).toEqual({
      path: { label: "# in", value: "/work" },
      gap: 0,
      commandPrefix: "",
    })
  })

  test("returns to 100% native rendering with no header in command mode", async () => {
    const harness = makeHarness()
    setupShellSelect(harness.ctx)
    await setting(harness, "header").onChange(false)
    await setting(harness, "workdir").onChange("command")
    expect(decorate(harness, { metadata: { shell: "bash" }, workdir: "/work" })).toBeUndefined()
  })
})

describe("cleanup", () => {
  test("disposes all settings and the shell decorator", () => {
    const harness = makeHarness()
    const cleanup = setupShellSelect(harness.ctx)
    expect(cleanup).toBeTypeOf("function")
    if (!cleanup) throw new Error("cleanup is missing")
    cleanup()
    expect(harness.disposed).toEqual([
      "setting:header",
      "setting:header_gap",
      "setting:workdir",
      "tool:shell",
    ])
  })
})
