import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { parseConfig } from "../src/config.js"
import { probeShells, system, type ShellProfile } from "../src/probe.js"
import { id, registerShellSelect } from "../src/server.js"
import { makeHarness, toolContext } from "../test/harness.js"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`smoke: ${message}`)
}

type BuiltModule = {
  readonly default: Plugin
  readonly id: string
  readonly registerShellSelect: typeof registerShellSelect
}

const artifactURL = new URL("../dist/server.js", import.meta.url)
const artifact = await readFile(artifactURL, "utf8").catch(() => {
  throw new Error("smoke: dist/server.js is missing; run `bun run build` first")
})
assert(/from\s*["']effect["']/u.test(artifact), "effect must remain an external ESM import")
assert(/from\s*["']@opencode\/plugin\//u.test(artifact), "@opencode/plugin must remain external")
assert(!/from\s*["']which["']|require\(["']which["']\)/u.test(artifact), "which should be bundled")

const built = (await import(artifactURL.href)) as unknown as BuiltModule
assert(built.id === "o3p.tool.shell-select", "named plugin ID is incorrect")
assert(built.default.id === id, "default export has the wrong plugin ID")
assert(typeof built.default.effect === "function", "default export has no Effect setup function")
assert(typeof built.registerShellSelect === "function", "registration helper is missing")

const names = process.platform === "win32" ? ["cmd", "powershell", "pwsh", "bash"] : ["sh", "bash", "zsh"]
const options = { shells: names, cacheTtlMs: 60_000 }
const snapshot = probeShells(parseConfig(options), system, Date.now())
const selected: ShellProfile | undefined = snapshot.available[0]
assert(selected, `none of the smoke-test shells is available: ${names.join(", ")}`)

const harness = makeHarness({ pluginOptions: options })
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* built.registerShellSelect(harness.ctx)
      const chosen = yield* harness.shell().execute(
        { command: "echo o3p-shell-select-smoke", shell: selected.id.toUpperCase() },
        toolContext(),
      )
      assert(chosen.output?.shell === selected.executable, "explicit selection did not reach create.before")
      assert(chosen.metadata?.shell === selected.id, "explicit selection did not record result.metadata.shell")
      assert(chosen.metadata?.preserved === true, "explicit selection dropped native metadata")
      const fallback = yield* harness.shell().execute({ command: "echo default" }, toolContext())
      assert(fallback.output?.shell === "/configured/default-shell", "omission changed the configured default")
      assert(fallback.metadata?.shell === "default-shell", "omission did not record result.metadata.shell")
      assert(fallback.metadata?.preserved === true, "omission dropped native metadata")
    }),
  ),
)

const disabled = makeHarness({ pluginOptions: { enabled: false } })
await Effect.runPromise(Effect.scoped(built.registerShellSelect(disabled.ctx)))
assert(
  disabled.hookCounts().session === 0 && disabled.hookCounts().shell === 0 && disabled.hookCounts().transforms === 0,
  "disabled plugin registered host behavior",
)

const command = "echo o3p-shell-select-smoke"
const args =
  selected.family === "cmd"
    ? ["/c", command]
    : selected.family === "powershell"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command]
const executed = spawnSync(selected.executable, args, { encoding: "utf8", timeout: 15_000 })
assert(!executed.error, `selected executable failed to start: ${String(executed.error)}`)
assert(executed.status === 0, `selected executable exited ${String(executed.status)}: ${executed.stderr}`)
assert(executed.stdout.includes("o3p-shell-select-smoke"), "selected executable returned unexpected output")
console.log(`smoke: export shape, harness, disabled mode, and real ${selected.id} execution passed`)
