# opencode-shell-select

English | [简体中文](README.md)

Per-call shell selection plugin (`o3p.tool.shell-select`) for OpenCode v2's built-in `shell` tool. Works for both direct tool calls and `tools.shell` inside `full_codemode`, without altering OpenCode's configured default shell.

## Features

- Adds an optional `shell` parameter to the built-in `shell` tool, with an enum generated from shells actually detected on the host.
- **Full pass-through when omitted**: preserves the default shell in `opencode.jsonc` along with native `output`, `content`, `freeform`, `options`, and structured output.
- Records the actual shell in `result.metadata.shell` on every execution: explicit selections record the canonical profile ID, while pass-through calls record the short executable name (e.g. `bash` / `pwsh`), preserving all other native metadata.
- Supports Git Bash (including `OPENCODE_GIT_BASH_PATH`), PowerShell, CMD, and WindowsApps App Execution Aliases on Windows; supports Bash, Zsh, sh, dash, ksh, pwsh, and custom profiles on POSIX.
- Uses a per-call fiber-local `Context.Reference` state box with the native `shell.create.before` hook so concurrent explicit calls, default calls, and unrelated `Shell.create` invocations never cross-contaminate `event.shell` or result metadata.
- Re-checks target availability before every explicit execution; if a shell disappears, refreshes the cache, reloads the tool definition, and returns a `Tool.Error` listing currently available shells instead of silently falling back to the default shell.
- Publishes available shells and the default shell via native `session.instructions.entry`: predicts the default shell at load time using OpenCode's config/env rules so a fresh session includes the full list in its initial instruction baseline (avoiding spurious `Instructions updated` notices on turn 1), while reconciling against the `context` hook and publishing an update only when the available set or default actually changes. Deduplicates per session by fingerprint, preserves persisted entries across hot reloads, and bounds the tracking map.
- Synchronizes tool descriptions and JSON Schema across `context`, `compaction`, and `generate` while retaining the native default shell name; mid-session config changes automatically publish a new instruction entry.
- Skips registration on remote workspaces, since the server cannot probe executables on a remote host.
- Optional `./tui` entrypoint sharing the same plugin ID; automatically renders shell headers and live display settings on TUI hosts that expose plugin settings and tool-card decoration APIs.

## TUI Tool Card Display (Optional)

Server-side behavior works **100% standalone on official OpenCode v2 with no frontend patches required**. Once the server plugin is active, TUI hosts supporting `ui.settings.register` and `ui.tools.decorate` discover `./tui` automatically; unpatched official TUIs silently skip the TUI side as a complete no-op without affecting server functionality.

When supported by the host, a **Shell** category appears in the Settings dialog:

| Setting | Default | Description |
| --- | --- | --- |
| `Header` | `on` | Show the short shell name in the shell tool card header |
| `Header spacing` | `off` | Insert a blank line between the header and the command |
| `Workdir` | `header` | `header` renders `# pwsh in <dir>` and omits the `cd` prefix; `command` keeps the native `$ cd <dir> && <cmd>` prefix |

Turning `Header` off still allows a standalone workdir header (`# in <dir>`); setting `Workdir = command` as well restores the fully native card rendering.

## Installation & Build

Requires Bun and OpenCode v2 (source-audited and host-verified against OpenCode `2.3.2`+).

```bash
bun install
bun run build
```

Register this directory in OpenCode v2's `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/path/to/opencode-shell-select",
      "options": {
        "enabled": true,
        "shells": ["bash", "sh", "pwsh"],
        "cacheTtlMs": 60000
      }
    }
  ]
}
```

Direct tool call example:

```json
{
  "command": "printf 'bash-ok\\n'",
  "shell": "bash"
}
```

Code Mode example:

```ts
const result = await tools.shell({
  command: "printf 'sh-ok\\n'",
  shell: "sh"
})
return result
```

Omitting `shell` leaves interpreter selection to OpenCode's native configuration.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | When `false`, registers no transforms, hooks, or event subscriptions |
| `shells` | Auto-detect | String array acts as an **allowlist** replacing built-in candidates; an object merges with built-in candidates to override paths, descriptions, or disable entries |
| `cacheTtlMs` | `60000` | Probe cache TTL in ms; `0` re-probes on every non-sticky read (pre-execution liveness checks always run regardless of TTL) |
| `instructionKey` | `"o3p.shell-select"` | Native instruction entry key; must match `^[a-z0-9][a-z0-9._-]*$` |
| `probeOnRequest` | `true` | Whether to read and refresh expired probe cache during prompt / model context preparation |

Full object-form example:

```jsonc
{
  "shells": {
    // Override built-in bash; on Windows can also be C:/Program Files/Git/bin/bash.exe
    "bash": {
      "path": "/bin/bash",
      "description": "GNU Bash"
    },
    "pwsh": { "enabled": true },
    "zsh": { "enabled": false },
    "corporate-sh": {
      "path": "/opt/company/bin/sh",
      "description": "Company-managed shell"
    }
  }
}
```

Fields degrade independently: an invalid value falls back only for that field without resetting other valid options such as `enabled: false`.

## Verification

```bash
bun run typecheck
bun test
bun run build
bun run smoke
bun run test:host
```

- `smoke` imports the built `dist/server.js` and `dist/tui.js`, verifies exports, TUI dependency isolation, silent degradation on official frontends, and runs real detected shells through selection/pass-through/disabled modes.
- `test:host` loads OpenCode's `Tool.runtime`, `PluginHooks`, and Effect Layer directly to verify schema transforms, decoding, concurrent isolation, and missing-shell handling; set `OPENCODE_SOURCE_DIR=/path/to/opencode`.

Quick manual check in OpenCode v2: open a new session with the plugin loaded, have the model run one call with `"shell": "bash"` (or another detected ID), one call omitting `shell`, and one with a nonexistent ID (which should return a tool error listing available shells). With `full_codemode` enabled, verify the same through `tools.shell` inside `execute`.

## License

[MIT](LICENSE)
