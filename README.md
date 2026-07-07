# UseChat

> **私有正式项目，暂不开源。**
>
> UseChat 是面向消息软件智能体的 **Computer Use** 能力层。它让 AI Agent 通过可见、可授权、可审计的桌面自动化方式使用本机消息软件。第一个连接器是微信桌面端。

## 定位

UseChat 不是机器人平台，不是协议破解工具，也不是群发营销工具。它是一个本地优先的消息软件 Computer Use 运行时：

```text
AI Agent
  -> UseChat CLI / SDK / 工具服务
  -> UseChat connector core
  -> native helper runtime
  -> 用户本机可见的消息软件
```

第一个正式目标：

```bash
usechat doctor
usechat read --app wechat --chat "ABC" --limit 10
usechat write --app wechat --chat "ABC" --text "hello" --yes
usechat read --app wechat --chat "ABC" --format json --trace-jsonl
usechat watch --app wechat --chat "ABC" --emit jsonl
usechat serve --stdio
```

真实设备回归可以直接跑：

```bash
pnpm build
pnpm smoke:wechat:abc
```

Windows 远程测试必须在已登录的可见桌面会话中执行；SSH Session 0 不能操作微信窗口。可用交互式计划任务入口：

```powershell
pnpm smoke:wechat:abc:windows-task
```

## 为什么做 UseChat

真实工作仍然大量发生在消息软件里。多数 AI Agent 能写代码、读文件、调用 API，但不能安全地使用用户自己的本机聊天软件。UseChat 要把这件事做成明确、本地、可审计、可授权的能力。

原则：

- **本地优先**：用户的软件、账号、屏幕、文件和系统权限都留在用户电脑上。
- **可见 Computer Use**：不破解协议，不注入客户端，不读取本地数据库。
- **面向 Agent**：先提供 CLI，再提供 SDK，后续提供工具服务 / MCP 风格接口。
- **用户自配模型**：用户配置 OpenAI-compatible 视觉模型；UseChat 独立使用时不依赖神念云。
- **Helper 源码入库**：原生 helper 源码会放在本仓库，方便审计和自编译。
- **人类保持控制**：发送默认需要确认；只有用户显式使用 `--yes` 或配置自动化策略后才跳过确认。

## 第一阶段范围

UseChat 第一阶段支持 macOS 和 Windows 上的微信桌面端。

### 首个正式版本命令

```bash
usechat init
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY

usechat doctor
usechat read --app wechat --chat "文件传输助手" --limit 10
usechat write --app wechat --chat "文件传输助手" --text "hello" --yes
```

### 首个正式版本能力

- 发现并校验 native helper runtime。
- 检查平台权限和微信可用状态。
- 打开指定微信对话。
- 截取当前可见聊天窗口。
- 使用用户配置的视觉模型结构化当前可见消息。
- 输出 Markdown 或 JSON。
- 发送文本消息，默认确认，支持 `--yes` 跳过确认。
- 输出 `traceSummary`，并可通过 `--trace-jsonl [path]` 显式保存脱敏 JSONL trace events。
- `watch --emit jsonl` 可持续轮询指定对话，输出 baseline、message、error、paused 事件。

## 真实设备 smoke

macOS 或 Windows 本机可用：

```bash
pnpm smoke:wechat:abc
```

它会创建临时 UseChat 配置、使用 `ocr-only` 本地 provider、依次执行 `doctor`、读取 ABC、发送一条 `UseChat smoke ...` marker、再读取并确认 marker 是否可见。脚本只输出结构化摘要，不输出完整聊天内容。

Windows 如果通过 SSH 调用，请先保证当前用户已经登录 Windows 桌面和微信，然后使用：

```powershell
pnpm smoke:wechat:abc:windows-task
```

该命令会注册并触发一个交互式计划任务，让 smoke 在可见桌面会话中运行。

如果摘要里出现：

```json
{
  "blockerReasonCode": "wechat_login_required"
}
```

表示 UseChat 已经看到微信窗口，但微信桌面端当前停在“重新登录 / 扫码登录 / 安全验证”状态。此时 UseChat 会停止后续搜索、点击、粘贴和发送，避免在错误窗口里误操作。请先在 Windows 可见桌面会话中手动完成微信登录，并确认能看到 ABC 群对话，再重新运行：

```powershell
pnpm smoke:wechat:abc:windows-task
```

### 后续能力

- 发送文件、图片、视频。
- 下载当前可见媒体并物化为本机附件。
- 本机 ledger、baseline、去重、echo suppression。
- `watch` 模式输出 JSONL 事件，复用本机 ledger 做 baseline 和去重。
- 面向 Codex、Claude Code、Cursor、OpenCode 和自定义 Agent 的 `serve --stdio` 工具服务；未来可增加 MCP adapter。
- 微信之后接入更多消息软件连接器。

## 仓库结构

```text
usechat/
  packages/core/             # 连接器状态机、ledger、schema、trace、outbound 逻辑
  packages/cli/              # `usechat` 命令行入口
  packages/sdk/              # 可嵌入 TypeScript API
  packages/model-provider/   # OpenAI-compatible 视觉模型 provider 和 schema prompt
  native/macos/              # macOS helper 源码和构建说明
  native/windows/            # Windows helper 源码和构建说明
  helper-runtime/            # Helper 打包、manifest、安装、升级、release artifact
  docs/                      # 架构、计划、helper runtime、合规说明
  examples/                  # Agent 集成示例
```

## 与神念的关系

UseChat 是从神念体系中独立出来的新私有项目。初期抽取过程中不修改现有神念仓库。

短期关系：

- 只在需要时从神念 copy-out 设计和实现。
- 第一阶段不让神念反向依赖 UseChat。
- 保持 helper protocol 与当前神念 helper 兼容。
- 先让 UseChat 独立跑通，再讨论是否回接神念。

长期关系：

- UseChat 可以成为可复用的消息软件 Computer Use 能力层。
- 神念未来可以把 UseChat 作为 Agent 控制面里的一个连接器能力来消费。

## 非目标

- 不逆向微信协议。
- 不注入微信进程。
- 不读取微信本地数据库。
- 不扫描缓存或 Downloads 猜附件。
- 不做群发、营销自动化、防封宣传或多账号群控。
- 不在 npm `postinstall` 阶段静默安装 GUI helper。
- 首个独立版本不隐藏依赖神念云。

## 当前状态

当前状态：**私有正式项目基础阶段**。

下一步按 [PLAN.md](./PLAN.md) 执行 Phase 1：在不修改神念仓库的前提下，把现有 helper 源码和 connector 逻辑 copy-out 到本项目。
