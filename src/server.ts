import { Tool } from "@opencode/plugin/effect"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Semaphore, Stream, type Scope } from "effect"
import { parseConfig } from "./config.js"
import { isLive, makeProbeCache, system, type ProbeSystem, type ShellProfile } from "./probe.js"
import {
  defaultShellFromDescription,
  renderInstructionPayload,
  SelectedShellRef,
  shellDescription,
  shellShortName,
  syncToolSchema,
  wrapShellTool,
} from "./runtime.js"

export const id = "o3p.tool.shell-select"
export const maxTrackedSessions = 512
type SessionID = SessionHooks["prompt"]["sessionID"]

export type ShellSelectHost = Pick<Context, "options" | "event"> & {
  readonly location: Pick<Context["location"], "directory" | "workspaceID">
  readonly session: Pick<Context["session"], "hook" | "instructions">
  readonly shell: Context["shell"]
  readonly tool: Pick<Context["tool"], "transform" | "reload">
}

export const registerShellSelect = Effect.fnUntraced(function* (
  ctx: ShellSelectHost,
  io: ProbeSystem = system,
  now = Date.now,
): Effect.fn.Return<void, never, Scope.Scope> {
  const config = parseConfig(ctx.options)
  // Probing the server cannot describe executables in a connected remote workspace.
  // Most importantly, a disabled (or remote) instance registers no hook or transform at all.
  if (!config.enabled || ctx.location.workspaceID !== undefined) return

  const cache = makeProbeCache(config, io, now)
  let current = cache.read()
  let defaultShell: string | undefined
  let active = true
  let wrapped = false
  const ids = () => current.available.map((profile) => profile.id)
  const published = new Map<SessionID, string>()
  const instructionLock = Semaphore.makeUnsafe(1)

  const refresh = Effect.fnUntraced(function* (
    mode: "request" | "execution" | "force",
    lost = false,
  ): Effect.fn.Return<void> {
    if (!active) return
    if (mode === "force") cache.invalidate()
    const next = cache.read(mode !== "request" || config.probeOnRequest)
    const changed = next.fingerprint !== current.fingerprint
    current = next
    if (changed || lost)
      yield* ctx.tool.reload().pipe(
        Effect.catchDefect((cause) => Effect.logWarning("shell-select: tool reload failed", { cause })),
        Effect.uninterruptible,
      )
  })

  const publish = (sessionID: SessionID) =>
    instructionLock.withPermit(
      Effect.gen(function* () {
        if (!active) return
        const snapshot = current
        const observedDefault = defaultShell
        const fingerprint = `${snapshot.fingerprint}:${observedDefault ?? ""}`
        const previous = published.get(sessionID)
        if (previous !== fingerprint) {
          const written = yield* ctx.session.instructions.entry
            .put({
              sessionID,
              key: config.instructionKey,
              value: renderInstructionPayload(snapshot, observedDefault),
            })
            .pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning("shell-select: instruction update failed", { sessionID, error }).pipe(Effect.as(false)),
              ),
              Effect.catchDefect((cause) =>
                Effect.logWarning("shell-select: instruction update defect", { sessionID, cause }).pipe(Effect.as(false)),
              ),
            )
          if (!written || !active) return
        }
        // Map insertion order is a small LRU, so active sessions are not evicted by old ones.
        published.delete(sessionID)
        published.set(sessionID, fingerprint)
        if (published.size > maxTrackedSessions) {
          const oldest = published.keys().next()
          if (!oldest.done) published.delete(oldest.value)
        }
      }),
    )

  const unavailable = (requested: string, reason: string) =>
    new Tool.Error({
      message: `Shell ${JSON.stringify(requested)} ${reason}. Available shells: ${ids().join(", ") || "none"}. Omit the shell parameter to use the configured default.`,
    })

  const select = Effect.fnUntraced(function* (
    requested: string,
    sessionID: SessionID,
  ): Effect.fn.Return<ShellProfile, Tool.Error> {
    const previous = current.available.find((profile) => profile.id === requested)
    // The TTL is only a discovery optimization. Never execute a cached path without this live check.
    const lost = previous !== undefined && !isLive(io, previous.executable)
    const fingerprint = current.fingerprint
    yield* refresh(lost || !previous ? "force" : "execution", lost)
    if (current.fingerprint !== fingerprint) yield* publish(sessionID)
    if (!active) return yield* new Tool.Error({ message: "Shell selection was unloaded. Retry without the shell parameter." })
    if (lost) return yield* unavailable(requested, "is no longer executable")

    const selected = current.available.find((profile) => profile.id === requested)
    if (!selected) return yield* unavailable(requested, "is not available")
    if (selected.executable !== previous?.executable || current.fingerprint !== fingerprint) {
      if (!isLive(io, selected.executable)) {
        yield* refresh("force", true)
        yield* publish(sessionID)
        return yield* unavailable(requested, "is no longer executable")
      }
    }
    return selected
  })

  yield* ctx.shell.hook("create.before", (event) =>
    Effect.gen(function* () {
      if (!active) return
      const call = yield* SelectedShellRef
      // Unrelated terminal/process creation must remain completely untouched.
      if (!call) return
      if (call.requested) {
        event.shell = call.requested.executable
        call.resolved = call.requested.id
        return
      }
      // Omission is intentional: leave invocation.shell byte-for-byte on OpenCode's configured default.
      call.resolved = shellShortName(event.shell)
      if (defaultShell === undefined) defaultShell = call.resolved
    }),
  )

  yield* ctx.tool.transform((editor) => {
    wrapped = false
    editor.update("shell", (tool) => {
      const next = wrapShellTool(tool, ids(), select, defaultShell)
      if (!next) return
      wrapped = true
      tool.input = next.input
      tool.description = next.description
      tool.execute = next.execute
    })
  })

  const updateSession = Effect.fnUntraced(function* (
    sessionID: SessionID,
    description?: string,
  ): Effect.fn.Return<void> {
    yield* refresh("request")
    const observed = description === undefined ? undefined : defaultShellFromDescription(description)
    if (observed !== undefined) defaultShell = observed
    if (wrapped) yield* publish(sessionID)
  })

  const syncContext = Effect.fnUntraced(function* (event: SessionHooks["context"]): Effect.fn.Return<void> {
    yield* updateSession(event.sessionID, event.tools.shell?.description)
    const tool = event.tools.shell
    if (!active || !wrapped || !tool || tool.input.type !== "object") return
    const available = ids()
    tool.description = shellDescription(tool.description, available, defaultShell)
    tool.input = syncToolSchema(tool.input, available)
  })

  // SessionPrompt.prepare triggers prompt before SessionRunner calls InstructionState.prepare. Publishing
  // here puts turn one's value into its initial baseline; later changes become chronological deltas.
  yield* ctx.session.hook("prompt", (event) => updateSession(event.sessionID))
  yield* ctx.session.hook("context", syncContext)
  yield* ctx.session.hook("compaction", syncContext)
  yield* ctx.session.hook("generate", syncContext)

  yield* ctx.event.subscribe({ types: ["session.deleted"] }).pipe(
    Stream.runForEach((event) =>
      instructionLock.withPermit(Effect.sync(() => void published.delete(event.data.sessionID))),
    ),
    Effect.catch((error) => Effect.logWarning("shell-select: session subscription ended", { error })),
    Effect.forkScoped({ startImmediately: true }),
  )

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false
      published.clear()
      cache.invalidate()
    }),
  )
})

export default define({ id, effect: (ctx) => registerShellSelect(ctx) })
