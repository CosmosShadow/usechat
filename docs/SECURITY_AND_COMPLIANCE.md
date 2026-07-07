# 安全与边界

UseChat 是一个本地优先的消息软件 Computer Use 项目。它帮助 AI Agent 在用户授权下，通过用户自己电脑上的可见桌面应用完成读取、整理、草拟和发送等操作。第一阶段支持微信桌面端。

## UseChat 是什么

UseChat 的核心定位是：

> 让 AI Agent 像一个坐在你电脑前的助理一样，在你的授权和可见边界内使用你的消息软件。

它运行在用户自己的电脑上，使用用户自己已经登录的桌面客户端，并通过系统允许的截图、OCR、鼠标、键盘和剪贴板能力完成操作。

UseChat 适合这些场景：

- 让 Agent 帮你读取指定对话的当前可见消息。
- 让 Agent 帮你总结消息内容。
- 让 Agent 根据上下文草拟回复。
- 在你确认后，把指定内容发送到指定对话。
- 将本机消息软件作为 Agent 的一个本地消息通道。

## 工作方式

UseChat 采用本地 Computer Use 架构：

```text
用户 / AI Agent
  -> UseChat CLI / SDK / 工具服务
  -> UseChat TypeScript connector core
  -> Native Helper Runtime
  -> 用户本机可见的消息软件窗口
```

其中：

- CLI / SDK 负责命令、配置、输出和 Agent 集成。
- Connector core 负责状态机、消息结构化、发送策略、ledger 和 trace。
- Model provider 负责调用用户配置的 OpenAI-compatible 视觉模型。
- Native Helper 负责窗口、截图、OCR、点击、键盘、剪贴板和本机文件能力。

UseChat 默认不托管用户账号，不接管用户的消息软件服务端，也不要求用户把消息软件迁移到云端。

## 安全边界

UseChat 使用公开、可见、用户态的桌面自动化能力。项目边界如下：

- 不逆向消息软件协议。
- 不注入或修改消息软件进程。
- 不 patch 客户端。
- 不读取本地消息数据库。
- 不通过扫描缓存目录来猜测消息内容。
- 不绕过系统权限机制。
- 不隐藏发送行为。
- 不在用户未授权的情况下操作消息软件。

所有涉及桌面 UI 的动作都应在当前用户的可见桌面会话中完成。窗口、权限、标题、输入框、剪贴板或用户活动状态不确定时，UseChat 应停止当前动作并返回可诊断错误，而不是继续点击或发送。

## 用户控制

UseChat 的默认设计是用户保持控制：

- 读取消息需要用户或 Agent 明确指定目标应用和对话。
- 发送消息默认需要确认目标对话和发送内容。
- 非交互场景必须显式使用 `--yes` 或配置自动化策略。
- 用户可以通过本地配置决定模型 provider、helper 路径、输出格式和发送确认策略。
- 未来的 watch / 自动化能力也应以明确绑定、明确范围和可停止为前提。

## 隐私原则

UseChat 采用本地优先和最小化数据原则：

- 用户的消息软件账号仍在用户本机客户端中。
- 用户自配模型，API key 从环境变量读取，默认不写入配置文件。
- 截图只用于当前识别流程，默认不长期保存。
- 剪贴板内容不写日志。
- OCR 全文默认不写日志。
- Trace 默认只记录 phase、reasonCode、latency、hash 和计数；`dataBase64`、截图、长文本和 secret-like 字段会被省略或脱敏。
- 附件默认保存在用户本机目录。
- 诊断导出应由用户主动触发，并清楚说明包含哪些内容。

默认本地数据目录：

```text
~/.usechat/
  config.json
  traces/
  ledger/
  attachments/
```

## 模型与密钥

UseChat 独立模式由用户配置 OpenAI-compatible 模型 provider：

```bash
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY
```

推荐使用 `apiKeyEnv`，让 API key 留在环境变量中。UseChat 不应在日志、trace、错误输出或诊断包中打印 API key、token 或 `.env` 明文内容。`--trace-jsonl` 是显式诊断能力，仍会经过脱敏。

## Helper Runtime

Native Helper 是 UseChat 的本机能力层。它负责平台相关能力，例如窗口截图、OCR、点击、键盘、剪贴板和文件物化。

Helper 的设计原则：

- Helper 只提供本机能力，不承载业务调度。
- Helper 不保存消息历史。
- Helper 不内置模型 provider。
- Helper 不进行隐藏网络调用。
- Helper 与 TypeScript core 通过稳定 JSON-RPC 协议通信。
- 普通用户通过显式 setup 安装 helper；npm `postinstall` 不静默安装 GUI runtime。

## 合规使用建议

UseChat 面向个人助理、单账号、本机授权和可见桌面自动化场景。用户应在自己有权使用的账号、设备和对话范围内使用 UseChat，并遵守相关软件的用户协议和当地法律法规。

UseChat 的公开文档和示例应聚焦于：

- 个人助理；
- 本地授权；
- 消息整理；
- 草拟回复；
- 人类确认；
- Agent 使用用户自己的桌面应用。

UseChat 不面向批量营销、多账号群控或规避平台规则的用途。
