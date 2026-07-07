# UseChat

> **让 AI Agent 像真正坐在你电脑前一样使用微信。**<br>
> UseChat 是一个基于视觉大模型的、本地优先的消息软件 Computer Use 运行时：它把微信桌面端截图、OCR 和窗口结构理解成可读、可写、可观察、可审计的本地工具接口，让 Codex、Claude Code、Cursor、OpenCode 和任意自定义 Agent 都能在用户授权的可见桌面里处理消息。

UseChat 的第一条连接器是 **微信桌面端**，支持 macOS 和 Windows。

它不破解协议，不注入客户端，不读取本地聊天数据库，也不接管你的微信账号。UseChat 只通过系统允许的窗口、截图、OCR、鼠标、键盘、剪贴板和本机文件能力，在你自己的电脑上完成操作。

```bash
usechat read --app wechat --chat "ABC" --limit 20
usechat write --app wechat --chat "ABC" --text "收到，我稍后回复" --yes
usechat watch --app wechat --chat "ABC" --emit jsonl
usechat serve --stdio
```

## 核心能力

- **读取微信消息**：读取指定对话当前可见消息，输出 Markdown 或 JSON。
- **发送消息**：发送文本、文件、图片、视频；默认要求确认，Agent 场景可显式 `--yes`。
- **观察对话**：`watch` 持续输出 JSONL 事件，适合 Agent 监听指定对话。
- **工具服务**：`serve --stdio` 提供稳定 JSONL tool protocol，方便接入外部 Agent runtime。
- **自配视觉模型**：支持 OpenAI-compatible Chat Completions endpoint，用户自己配置模型和 key。
- **本地 Helper**：UseChat Helper 负责桌面窗口、OCR、点击、剪贴板和文件物化。
- **可诊断**：稳定 `reasonCode`、`traceSummary`、JSONL trace，失败时便于定位。

## 快速开始

### 1. 安装 CLI

需要 Node.js 18 或更高版本。

```bash
npm install -g @shennian/usechat
usechat --version
```

CLI 命令名是：

```bash
usechat
```

### 2. 初始化配置

```bash
usechat init
```

默认配置文件：

```text
~/.usechat/config.json
```

也可以指定配置文件，方便不同 Agent 使用不同配置：

```bash
usechat --config ./usechat.config.json init
```

### 3. 配置视觉大模型 Key

UseChat 的读取能力依赖视觉大模型：Helper 会截取微信桌面端的可见窗口，采集 OCR 和布局提示，然后把截图与这些 hints 一起交给支持图片输入的 OpenAI-compatible 模型。模型返回结构化 JSON 后，UseChat 再做校验、排序、去重和 Markdown / JSON 输出。

国内环境推荐使用 **阿里云百炼 / DashScope 的 Qwen-VL**：

- `qwen-vl-plus`：推荐默认选择，速度、成本和视觉理解效果比较均衡；
- `qwen-vl-max`：更强的视觉理解能力，适合复杂窗口、图片/文件/卡片较多的对话；
- `model.baseUrl` 填兼容模式根地址 `https://dashscope.aliyuncs.com/compatible-mode/v1`，不要加 `/chat/completions`，UseChat 会自动拼接。

推荐把 API key 放在环境变量里，不写入配置文件：

```bash
export DASHSCOPE_API_KEY="你的 DashScope API Key"

usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
usechat config set model.name qwen-vl-plus
usechat config set model.apiKeyEnv DASHSCOPE_API_KEY
usechat config set model.timeoutMs 60000
```

如果你使用其他 OpenAI-compatible 视觉模型，只需要替换 `baseUrl`、`model.name` 和 `model.apiKeyEnv`：

```bash
export USECHAT_MODEL_API_KEY="你的兼容服务 Key"

usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://your-endpoint.example.com/v1
usechat config set model.name "your-vision-model"
usechat config set model.apiKeyEnv USECHAT_MODEL_API_KEY
```

查看配置：

```bash
usechat config list
```

UseChat 不会把 API key 打印到 CLI 输出、日志或 trace 中。`model.apiKeyEnv` 应该是环境变量名，不是 key 明文。

### 4. 安装 UseChat Helper

UseChat Helper 是本机原生运行时。它负责：

- 查找微信窗口；
- 截图和 OCR；
- 点击、输入、粘贴、发送；
- 剪贴板保护；
- 文件、图片、视频附件发送；
- 当前可见媒体的本机物化。

Helper 不随 npm 包静默安装。下载对应平台的 release zip 后，显式安装：

```bash
# macOS
usechat setup-helper --from ./UseChat-Helper-Runtime-macos.zip --force

# Windows PowerShell
usechat setup-helper --from .\UseChat-Helper-Runtime-windows.zip --force
```

默认安装位置：

```text
macOS:   ~/Library/Application Support/UseChat/Helper/UseChat Helper.app
Windows: %LOCALAPPDATA%\Programs\UseChat Helper
```

源码用户也可以自己构建 Helper：

```bash
pnpm install

# macOS
pnpm helper-runtime:build:native:mac
pnpm helper-runtime:build:mac

# Windows，需要在 Windows 构建机执行
pnpm helper-runtime:build:native:win
pnpm helper-runtime:build:win
```

Helper 源码在仓库中；大型 runtime zip、Windows DLL、ONNX Runtime、PP-OCRv5 模型作为 release artifact 分发，不进入 npm 包，也不建议进入 git 历史。

### 5. 授权并检查

macOS 首次使用需要给 `UseChat Helper.app` 授权：

- 屏幕录制；
- 辅助功能；
- 输入监听；
- 自动化 / Apple Events（如系统弹窗提示）。

Windows 需要在已经登录的可见桌面会话中运行微信。SSH 的 Session 0 不能操作微信窗口。

运行检查：

```bash
usechat doctor
usechat doctor --json
```

常见 `reasonCode`：

| reasonCode | 含义 |
|---|---|
| `helper_missing` | 还没有安装 UseChat Helper。 |
| `permission_missing` | macOS 权限未给全。 |
| `wechat_not_running` | 微信没有运行。 |
| `wechat_window_not_found` | 没有可用微信窗口。 |
| `wechat_login_required` | 微信停在重新登录 / 扫码登录 / 安全验证状态。 |
| `model_not_configured` | 模型配置不完整。 |
| `model_request_failed` | 模型请求失败。 |

## 使用方法

### 读取消息

```bash
usechat read --app wechat --chat "ABC" --limit 20
```

JSON 输出：

```bash
usechat read --app wechat --chat "ABC" --limit 20 --format json
```

自动尝试解析当前可见媒体 / 附件：

```bash
usechat read --app wechat --chat "ABC" --limit 20 --format json --download auto
```

### 发送文本

默认会要求确认：

```bash
usechat write --app wechat --chat "ABC" --text "你好，我稍后回复"
```

非交互 Agent 场景必须显式使用 `--yes`：

```bash
usechat write --app wechat --chat "ABC" --text "收到" --yes --json
```

演练，不真正发送：

```bash
usechat write --app wechat --chat "ABC" --text "测试" --dry-run --json
```

### 发送文件、图片、视频

```bash
usechat write --app wechat --chat "ABC" --file ./report.pdf --yes --json
usechat write --app wechat --chat "ABC" --image ./image.png --yes --json
usechat write --app wechat --chat "ABC" --video ./demo.mp4 --yes --json
```

每次 `write` 只接收一个附件参数。需要发送多份内容时，建议让上层 Agent 分多次调用并记录每次返回结果。

### 观察指定对话

```bash
usechat watch --app wechat --chat "ABC" --emit jsonl
```

调整轮询间隔：

```bash
usechat watch --app wechat --chat "ABC" --emit jsonl --poll-interval-ms 3000
```

一次性输出 baseline，适合 smoke / 调试：

```bash
usechat watch --app wechat --chat "ABC" --emit jsonl --once --limit 5
```

### Trace 与诊断

JSON 输出默认包含 `traceSummary`。

显式写入 JSONL trace：

```bash
usechat read --app wechat --chat "ABC" --format json --trace-jsonl
usechat write --app wechat --chat "ABC" --text "hello" --yes --json --trace-jsonl ./trace.jsonl
```

Trace 会脱敏 secret-like 字段，默认不保存原始截图、长文本、剪贴板全文或 API key。

## 给其他 Agent 使用

### 方式一：直接调用 CLI

任何可以执行 shell 命令的 Agent 都可以直接调用 UseChat：

```bash
usechat doctor --json
usechat read --app wechat --chat "ABC" --limit 20 --format json
usechat write --app wechat --chat "ABC" --text "回复内容" --yes --json
```

建议给 Agent 的约束：

1. 发送前必须明确目标对话和完整内容。
2. 默认先 `--dry-run` 或让用户确认；只有用户明确授权时才使用 `--yes`。
3. 失败时读取 `reasonCode`，不要盲目重复点击、粘贴或发送。
4. 不要求 UseChat 读取数据库、破解协议、隐藏发送或批量群发。

### 方式二：stdio 工具服务

启动：

```bash
usechat serve --stdio
```

请求是一行 JSON，响应是一行 JSONL。工具名：

- `doctor`
- `read`
- `write`

示例请求：

```json
{"id":"1","tool":"doctor","input":{}}
{"id":"2","tool":"read","input":{"app":"wechat","chat":"ABC","limit":20,"format":"json"}}
{"id":"3","tool":"write","input":{"app":"wechat","chat":"ABC","text":"收到","yes":true}}
```

适合需要长期持有本地工具进程的 Agent runtime。

### 方式三：安装成 Agent Skill

如果你的 Agent 支持 `SKILL.md` 风格的本地技能，可以创建一个 `usechat` skill。

Codex 路径示例：

```text
~/.codex/skills/usechat/SKILL.md
```

`SKILL.md` 示例：

````markdown
# UseChat

当用户要求读取、总结、观察或发送微信消息时使用本技能。UseChat 通过本机可见桌面操作微信，不破解协议、不读取数据库、不隐藏发送行为。

## 前置条件

- 已安装 `@shennian/usechat`，命令为 `usechat`。
- 已运行 `usechat init`。
- 已配置视觉模型：`model.baseUrl`、`model.name`、`model.apiKeyEnv`。
- 已显式安装 UseChat Helper，并完成系统权限授权。
- 微信桌面端已经登录，目标对话可由用户账号访问。

## 安全规则

- 发送消息前，必须确认目标对话和完整内容。
- 除非用户明确要求自动发送，否则不要使用 `--yes`。
- 如果 `doctor` 或命令返回失败，读取 `reasonCode` 并向用户说明，不要盲目重试。
- 不帮助用户做群发营销、多账号群控、防封、协议破解、数据库读取或隐藏发送。
- 不输出 API key、token、完整剪贴板内容或原始截图。

## 常用命令

检查：

```bash
usechat doctor --json
```

读取：

```bash
usechat read --app wechat --chat "<对话名>" --limit 20 --format json
```

发送：

```bash
usechat write --app wechat --chat "<对话名>" --text "<内容>" --yes --json
```

观察：

```bash
usechat watch --app wechat --chat "<对话名>" --emit jsonl
```
````

Claude Code、Cursor、OpenCode 或自定义 Agent 如果没有 skill 目录，也可以把下面这段放进项目 instructions：

```markdown
当需要使用本机微信时，调用 `usechat`。先运行 `usechat doctor --json`。读取用 `usechat read --app wechat --chat "<对话名>" --format json`。发送前确认目标和内容；只有用户明确授权才使用 `--yes`。失败时读取 reasonCode，不做盲目重试。禁止群发营销、防封、协议破解、数据库读取或隐藏发送。
```

## 技术架构

UseChat 的核心不是“读数据库”，而是 **Computer Use + 视觉大模型**：

1. `usechat read` / `watch` 先通过 Helper 找到并聚焦目标微信窗口；
2. Helper 截取当前可见窗口，并返回系统 OCR、候选布局、可见会话指纹等边端 hints；
3. `@shennian/usechat-model-provider` 调用用户配置的视觉大模型，把截图和 hints 转成稳定的结构化消息 JSON；
4. `@shennian/usechat-core` 对模型结果做 schema 校验、消息归一化、排序、去重、ledger 和 trace；
5. `usechat write` 使用同一套窗口定位和安全 preflight，再通过剪贴板、键盘、鼠标等系统能力把文本或附件发送到可见微信窗口。

这意味着 UseChat 可以适配微信这类没有开放个人消息 API 的桌面应用，同时保持边界清晰：它只操作用户授权的可见桌面，不破解协议、不注入进程、不读取聊天数据库。

```text
AI Agent / 用户脚本
  ↓
@shennian/usechat CLI / stdio tool server / SDK
  ↓
@shennian/usechat-core
  - 微信连接器状态机
  - read / write / watch
  - ledger / dedupe / local echo suppression
  - trace / reasonCode / 安全失败策略
  ↓
@shennian/usechat-model-provider
  - OpenAI-compatible 视觉模型调用
  - 可见窗口结构化 prompt / schema
  ↓
UseChat Helper native runtime
  - macOS: Swift + Accessibility / ScreenCapture / Vision / Clipboard / Input
  - Windows: C#/.NET + UI Automation / OCR / Clipboard / Input
  ↓
用户本机可见的微信桌面端窗口
```

包结构：

```text
packages/core/             微信连接器核心、runtime、ledger、trace、read/write/watch
packages/cli/              usechat 命令行和 stdio tool server
packages/sdk/              TypeScript SDK
packages/model-provider/   OpenAI-compatible 视觉模型 provider
native/macos/              macOS Helper 源码
native/windows/            Windows Helper 源码
helper-runtime/            Helper manifest、构建脚本、安装与 release artifact 生成
docs/                      架构、安装、安全、合规、发布文档
```

## 开发与构建

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

Helper 构建：

```bash
# macOS
pnpm helper-runtime:build:native:mac
pnpm helper-runtime:build:mac

# Windows
pnpm helper-runtime:build:native:win
pnpm helper-runtime:build:win
```

npm 包打包 / 发布：

```bash
pnpm release:npm:pack
pnpm release:npm:dry-run
pnpm release:npm:publish
```

真实设备 smoke：

```bash
pnpm smoke:wechat:abc
pnpm smoke:wechat:abc:attachments
```

Windows 远程测试需要在已登录的可见桌面会话中运行，可使用计划任务入口：

```powershell
pnpm smoke:wechat:abc:windows-task
pnpm smoke:wechat:abc:attachments:windows-task
```

## 安全边界

UseChat 面向个人助理、单账号、本机授权和可见桌面自动化场景。

UseChat 不做这些事：

- 不逆向微信协议；
- 不注入或修改微信进程；
- 不读取微信本地数据库；
- 不扫描缓存目录猜测消息内容；
- 不隐藏发送行为；
- 不做群发营销、多账号群控或规避平台规则；
- 不在 npm `postinstall` 阶段静默安装 GUI Helper。

更多文档：

- [技术架构](./docs/ARCHITECTURE.md)
- [安装与首次配置](./docs/INSTALL.md)
- [BYO Model 配置](./docs/BYO_MODEL.md)
- [Helper Runtime](./docs/HELPER_RUNTIME.md)
- [安全与边界](./docs/SECURITY_AND_COMPLIANCE.md)
- [故障排查](./docs/TROUBLESHOOTING.md)
- [发布流程](./docs/RELEASE.md)
