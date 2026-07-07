# Agent 接入说明

UseChat 面向外部 Agent 提供两层入口：

1. 直接调用 CLI：`usechat doctor`、`usechat read`、`usechat write`。
2. 长驻工具服务：`usechat serve --stdio`，通过 stdin/stdout JSONL 调用工具。

两种入口都复用 UseChat 当前从 Shennian copy-out 的微信 runtime、helper protocol、native helper 和 read/write 状态机；Agent 接口只做参数包装，不重新实现微信 RPA。

## `serve --stdio` 协议

启动：

```bash
usechat serve --stdio
```

stdin 每一行是一个 JSON request，stdout 每一行是一个 JSON response。空行会被忽略。

### Request

```json
{
  "id": "request-id",
  "tool": "read",
  "input": {}
}
```

字段：

- `id`：可选，字符串或数字；响应会原样带回。
- `tool` / `method`：工具名，支持 `doctor`、`read`、`write`，也接受 `usechat.doctor` 这种前缀形式。
- `input` / `params`：工具参数对象。

### Response

成功：

```json
{
  "id": "request-id",
  "ok": true,
  "tool": "read",
  "result": {}
}
```

失败：

```json
{
  "id": "request-id",
  "ok": false,
  "tool": "read",
  "reasonCode": "model_not_configured",
  "message": "model_not_configured: ..."
}
```

安全约定：

- 响应会经过 UseChat secret redaction，不输出 API key / token / password 等 secret-like 字段。
- 默认不保存原始截图。
- `write` 在 stdio 模式下必须显式传 `yes: true` 或 `dryRun: true`；否则返回 `confirmation_required`，避免 Agent 无意发送。

## 工具

### doctor

检查 helper、权限、微信窗口和模型配置。

```json
{"id":"d1","tool":"doctor","input":{"checkModel":true}}
```

### read

读取当前可见窗口中的微信消息。

```json
{"id":"r1","tool":"read","input":{"app":"wechat","chat":"ABC","limit":20,"format":"json","download":"never"}}
```

参数：

- `app`：目前只支持 `wechat`。
- `chat`：目标会话名，必填。
- `limit`：可选，正整数。
- `format`：`json` 或 `markdown`；工具服务默认建议 `json`。
- `download`：`never` 或 `auto`。

### write

发送文本或单个本机附件。

```json
{"id":"w1","tool":"write","input":{"app":"wechat","chat":"ABC","text":"hello","yes":true}}
```

附件示例：

```json
{"id":"w2","tool":"write","input":{"app":"wechat","chat":"ABC","file":"/Users/me/report.pdf","yes":true}}
```

参数：

- `text`：要发送的文本。
- `file` / `image` / `video`：三选一，本机路径。
- `yes`：必须显式为 `true` 才会真实发送。
- `dryRun`：为 `true` 时只返回计划，不执行 UI 动作。

## Codex 使用方式

在 Codex 里最稳的方式是直接用 shell 调 CLI：

```bash
usechat read --app wechat --chat "ABC" --format json --limit 20
usechat write --app wechat --chat "ABC" --text "收到，我稍后处理" --yes --json
```

如果要长驻工具进程，可以让 Codex 启动：

```bash
usechat serve --stdio
```

然后逐行写入 JSON request。建议 Codex 在发送前先调用 `doctor`，并在 `write` 前向用户确认或只在用户授权场景传 `yes:true`。

## Claude Code 使用方式

Claude Code 可通过 Bash 工具直接调用 CLI：

```bash
usechat doctor --json
usechat read --app wechat --chat "ABC" --format json
```

发送消息时不要让模型自行决定越权发送；推荐提示词要求：只有用户明确要求发送时才调用：

```bash
usechat write --app wechat --chat "ABC" --text "..." --yes --json
```

## Cursor / OpenCode 使用方式

Cursor / OpenCode 与 Codex 类似，优先把 UseChat 当作本地 CLI 工具：

```bash
usechat read --app wechat --chat "ABC" --format json --download never
```

如果 Agent 框架支持持久子进程，则可以接入 `usechat serve --stdio`，把 `doctor/read/write` 映射为工具。

## Custom Agent JSON 示例

Node.js Agent 可用 stdio 子进程调用：

```js
import { spawn } from 'node:child_process'

const child = spawn('usechat', ['serve', '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] })
child.stdout.on('data', (chunk) => {
  for (const line of chunk.toString('utf8').trim().split(/\r?\n/)) {
    if (line) console.log(JSON.parse(line))
  }
})

child.stdin.write(JSON.stringify({
  id: 'read-abc',
  tool: 'read',
  input: { app: 'wechat', chat: 'ABC', format: 'json', limit: 20 },
}) + '\n')
```

## 未来 MCP-compatible 映射

当前 `serve --stdio` 不是完整 MCP server，但工具边界按 MCP 风格预留：

| UseChat stdio tool | 未来 MCP tool | 说明 |
|---|---|---|
| `doctor` | `usechat_doctor` | 检查本机运行条件 |
| `read` | `usechat_read` | 读取消息 |
| `write` | `usechat_write` | 发送消息 |

未来如果接入 MCP，只应在协议层增加 MCP adapter，底层仍复用现有 UseChat runtime，不复制或重写微信 RPA 行为。
