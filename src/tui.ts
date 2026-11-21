import { Plugin } from "@opencode/plugin/tui"
import type { ShellInfo } from "@opencode/client"
import { shellShortName } from "./shell-name.js"

export interface SettingItem {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly value: () => unknown
  readonly values?: readonly unknown[]
  readonly labels?: readonly string[]
  readonly step?: number
  readonly min?: number
  readonly max?: number
  readonly format?: (value: unknown) => string
  readonly onChange: (next: unknown) => void | Promise<void>
}

export interface ToolDecorationContext {
  readonly tool: string
  readonly status: "streaming" | "running" | "completed" | "error"
  readonly input: Readonly<Record<string, unknown>>
  readonly metadata: Readonly<Record<string, unknown>>
  readonly workdir?: string
  readonly shell?: ShellInfo
}

export interface ToolDecoration {
  readonly title?: string
  readonly path?: { readonly label: string; readonly value: string }
  readonly gap?: number
  readonly commandPrefix?: string
}

export type ToolDecorator = (context: ToolDecorationContext) => ToolDecoration | undefined

/** Optional host capabilities added after the published OpenCode 2.3.0 TUI API. */
export interface ShellSelectTuiUI {
  readonly settings?: {
    register(setting: SettingItem): () => void
  }
  readonly tools?: {
    decorate(tool: string, decorator: ToolDecorator): () => void
  }
}

export interface ShellSelectTuiContext {
  readonly storage: Pick<Plugin.Context["storage"], "store">
  readonly ui: ShellSelectTuiUI
}

export interface ShellSelectSettings {
  header: boolean
  headerGap: boolean
  workdir: "header" | "command"
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

export function decoratedShellName(context: ToolDecorationContext): string | undefined {
  const executable =
    nonEmptyString(context.metadata.shell) ??
    nonEmptyString(context.input.shell) ??
    nonEmptyString(context.shell?.shell)
  if (executable === undefined) return
  return shellShortName(executable) || undefined
}

export function decorateShell(
  context: ToolDecorationContext,
  settings: Readonly<ShellSelectSettings>,
): ToolDecoration | undefined {
  const shellName = decoratedShellName(context)
  const validDir = context.workdir && context.workdir !== "." ? context.workdir : undefined
  const gap = settings.headerGap ? 1 : 0
  if (settings.workdir === "header" && validDir) {
    return {
      path: { label: settings.header ? `# ${shellName ?? "shell"} in` : "# in", value: validDir },
      gap,
      commandPrefix: "",
    }
  }
  if (settings.header && shellName) return { title: `# ${shellName}`, gap }
}

export function setupShellSelect(ctx: ShellSelectTuiContext): (() => void) | undefined {
  const { ui } = ctx
  // Official OpenCode frontends have neither capability. Do not even allocate
  // the durable store there: this entrypoint must be a silent, complete no-op.
  if (!ui.settings?.register && !ui.tools?.decorate) return

  const [settings, setSettings] = ctx.storage.store<ShellSelectSettings>("settings", {
    initial: { header: true, headerGap: false, workdir: "header" },
  })
  const disposers: Array<() => void> = []

  if (ui.settings?.register) {
    disposers.push(
      ui.settings.register({
        id: "header",
        title: "Header",
        category: "Shell",
        description: "Whether the shell tool card shows the shell name in a header",
        value: () => settings.header,
        values: [false, true],
        labels: ["off", "on"],
        keywords: ["shell header", "shell title", "pwsh", "bash"],
        onChange: (next) => setSettings((draft) => {
          draft.header = next === true
        }),
      }),
      ui.settings.register({
        id: "header_gap",
        title: "Header spacing",
        category: "Shell",
        description: "Whether a blank line separates the shell header from the command",
        value: () => settings.headerGap,
        values: [false, true],
        labels: ["off", "on"],
        keywords: ["shell gap", "blank line", "spacing"],
        onChange: (next) => setSettings((draft) => {
          draft.headerGap = next === true
        }),
      }),
      ui.settings.register({
        id: "workdir",
        title: "Workdir",
        category: "Shell",
        description: "Whether the shell working directory is shown in the header or as a cd prefix",
        value: () => settings.workdir,
        values: ["header", "command"],
        labels: ["header", "command (cd)"],
        keywords: ["directory", "cwd", "cd", "copy"],
        onChange: (next) => setSettings((draft) => {
          draft.workdir = next === "command" ? "command" : "header"
        }),
      }),
    )
  }

  if (ui.tools?.decorate) {
    disposers.push(ui.tools.decorate("shell", (context) => decorateShell(context, settings)))
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

export default Plugin.define({
  id: "o3p.tool.shell-select",
  setup(ctx) {
    return setupShellSelect({ storage: ctx.storage, ui: ctx.ui as ShellSelectTuiUI })
  },
})
