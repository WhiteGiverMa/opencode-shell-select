# opencode-shell-select

OpenCode v2 内置 `shell` 工具的逐次调用 Shell 选择插件（`o3p.tool.shell-select`）。同时支持直接工具调用与 `full_codemode` 中的 `tools.shell`，不改变 OpenCode 原有的默认 Shell 配置。

## 功能

- 为 `shell` 增加可选 `shell` 参数，枚举值来自当前实际可执行的 Shell 探测结果。
- **省略参数即完全透传**：保留 `opencode.jsonc` 的默认 Shell、原生 `output`、`content`、`freeform`、`options` 与结构化输出。
- 每次执行都在 `result.metadata.shell` 记录实际 Shell：显式选择记录规范 profile ID，默认透传记录可执行文件短名（如 `bash` / `pwsh`），同时保留原生的其他 metadata。
- Windows 支持 Git Bash（含 `OPENCODE_GIT_BASH_PATH`）、PowerShell、CMD 和 WindowsApps App Execution Alias；POSIX 支持 Bash、Zsh、sh、dash、ksh、pwsh及自定义配置。
- 使用每次调用独立的 fiber-local `Context.Reference` 状态盒与原生 `shell.create.before` hook；显式选择、默认调用及无关 `Shell.create` 并行时，`event.shell` 和结果 metadata 均互不串扰。
- 每次显式选择都在执行前检查目标是否仍然存在；失效后会刷新缓存、重载工具并返回列出当前可用项的 `Tool.Error`，**不会静默退回默认 Shell**。
- 通过原生 `session.instructions.entry` 发布可用项和已观察到的默认 Shell：首轮 prompt 前进入初始指令基线，后续变化进入原生指令增量；按会话指纹去重并限制跟踪表大小。
  - **预期行为提示**：服务端冷启动（或插件初次加载）后的**第一个全新会话**会在首轮结束/第二轮前出现一次 `Instructions updated: api/o3p.shell-select`——这是因为默认 Shell 名称在首次 `context` 钩子从原生工具描述里观察到，随后会把 `Default shell when shell is omitted: <name>.` 补齐进指令 entry。观察完成后，同一服务端进程下的后续新会话首轮即写入完整基线，插件热重载也不会覆盖已有持久化 entry；之后仅当可用 Shell 列表或默认 Shell 配置真正变化时才会再次触发该提示。
- 在 `context` / `compaction` / `generate` 中同步工具描述与 JSON Schema，保留原生默认 Shell 名称；配置中途变更会自动发布新的指令 entry。
- 远程 workspace 不注册本插件，因为服务端无法探测远端机器的可执行文件。
- 可选 `./tui` 入口与服务端共用插件 ID；在支持 TUI 设置与工具卡片装饰接口的宿主中自动提供 Shell 卡片标题和实时显示设置。

## TUI 卡片显示（可选）

服务端行为在官方 OpenCode v2 上 **100% 独立工作，无需任何前端补丁**。服务端插件激活后，支持 `ui.settings.register` 与 `ui.tools.decorate` 的 TUI 宿主会自动发现 `./tui`；官方未补丁 TUI 缺少这些接口时会完全静默地跳过 TUI 设置，不影响服务端功能。

支持相应接口时，Settings 对话框会出现 **Shell** 分类：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `Header` | `on` | 在 Shell 工具卡片标题中显示 Shell 短名 |
| `Header spacing` | `off` | 在标题与命令之间显示一个空行 |
| `Workdir` | `header` | `header` 显示 `# pwsh in <dir>` 并省略命令前的 `cd`；`command` 保留原生命令前缀 `$ cd <dir> && <cmd>` |

关闭 `Header` 后仍可单独保留 workdir 标题（`# in <dir>`）；同时选择 `Workdir = command` 则恢复完全原生的卡片渲染。

## 安装与构建

需要 Bun 与 OpenCode v2；源码审计及真实宿主验证基线为 OpenCode `2.3.2`。

```bash
bun install
bun run build
```

在 OpenCode v2 的 `opencode.jsonc` 中挂载本目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/绝对路径/opencode-shell-select",
      "options": {
        "enabled": true,
        "shells": ["bash", "sh", "pwsh"],
        "cacheTtlMs": 60000
      }
    }
  ]
}
```

直接工具调用示例：

```json
{
  "command": "printf 'bash-ok\\n'",
  "shell": "bash"
}
```

Code Mode 示例：

```ts
const result = await tools.shell({
  command: "printf 'sh-ok\\n'",
  shell: "sh"
})
return result
```

不传 `shell` 时仍由 OpenCode 原生配置决定解释器。

## 配置

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不注册任何 transform、hook 或事件订阅 |
| `shells` | 自动探测 | 字符串数组为**允许列表**，替代内置候选；对象则与内置候选合并，可覆盖路径、描述或禁用项 |
| `cacheTtlMs` | `60000` | 探测缓存 TTL，`0` 表示每次非粘性读取都重新探测；显式执行前的存活检查不受 TTL 影响 |
| `instructionKey` | `"o3p.shell-select"` | 原生指令 entry key，须匹配 `^[a-z0-9][a-z0-9._-]*$` |
| `probeOnRequest` | `true` | 是否在 prompt / 模型上下文准备时读取并刷新过期探测缓存 |

对象形式的完整示例：

```jsonc
{
  "shells": {
    // 覆盖内置 bash；Windows 也可设为 C:/Program Files/Git/bin/bash.exe
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

配置字段独立容错：某个值无效只回退该字段，不会把 `enabled: false` 等其他有效配置一起重置。

## 验证

```bash
bun run typecheck
bun test
bun run build
bun run smoke
bun run test:host
```

- `smoke` 导入实际构建的 `dist/server.js` 与 `dist/tui.js`，检查导出、TUI 依赖隔离及官方前端上的静默降级，并在 harness 中验证选择/透传与禁用模式，用探测到的真实 Shell 执行命令。
- `test:host` 直接加载 OpenCode 2.3.2 的 `Tool.runtime`、`PluginHooks` 与 Effect Layer，验证真实 Schema 转换、解码、并发隔离和 Shell 消失处理；需要设置 `OPENCODE_SOURCE_DIR=/path/to/opencode`。

在 OpenCode v2 中快速手测：挂载插件后打开一个新会话，让模型分别执行一次带 `"shell":"bash"`（或当前枚举中的其他值）和一次省略 `shell` 的调用；再请求一个不存在的 ID，应看到列出当前可用 Shell 的工具错误。开启 `full_codemode` 时，可在 `execute` 中调用 `tools.shell` 做同样验证。

## 许可

[MIT](LICENSE)
