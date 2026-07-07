# UseChat 架构

## 一句话架构

```text
Agent / 人类 CLI
  -> UseChat CLI / SDK / 工具服务
  -> connector core
  -> model provider + native helper protocol
  -> 用户本机可见的消息软件
```

UseChat 把业务状态机留在 TypeScript，把平台能力放在 native helper。

## 分层

| 层 | 负责 | 不应该负责 |
|----|------|------------|
| CLI | 命令、配置、输出、发送确认、setup 入口 | native UI 自动化细节 |
| SDK | 给外部应用 / Agent 嵌入的 API | 暗中持有全局状态 |
| Core | 连接器状态机、schema、ledger、media plan、outbound queue、trace | 平台 API、模型密钥 |
| Model provider | OpenAI-compatible VLM 调用、prompt、JSON schema 归一化 | 账号 / 计费逻辑、UI 自动化 |
| Helper protocol | JSON-RPC command contract、reasonCode、capabilities | 产品 / session 语义 |
| Native helper | 窗口、截图、OCR、输入、剪贴板、文件物化、用户活动检测 | 模型调用、ledger、去重、Agent 路由 |
| Helper runtime | 打包、manifest、安装、升级、签名 evidence | 隐式 postinstall 副作用 |

## 微信首个正式版本流程

```text
read(chat)
  -> doctor / preflight
  -> helper.ensureReady
  -> helper.search/open conversation
  -> helper.captureAndOcr 或 capture + OCR hints
  -> model.structureVisibleWindow
  -> normalize / validate
  -> 输出 markdown/json
```

```text
write(chat, text)
  -> doctor / preflight
  -> 除非 --yes，否则确认
  -> helper.ensureReady
  -> helper.search/open conversation
  -> clipboard snapshot
  -> set text
  -> paste and submit
  -> restore clipboard
  -> report status
```

## 独立模式与平台模式

### 独立模式

独立模式是第一目标。

- 不需要神念账号。
- 不需要神念 machine token。
- 不需要神念 server relay。
- 用户自配模型 provider。
- 本地配置在 `~/.usechat`。
- 本地附件和 trace 在 `~/.usechat`。

### 平台模式

平台模式是后续工作。

- 神念或其他 Agent 平台可以嵌入 UseChat。
- 平台可以提供身份、云同步、审计、远程确认、团队控制或托管模型路由。
- UseChat core 必须保持没有平台也能独立使用。

## Native helper 兼容性

首个正式版本保持与当前 Shennian helper 的 helper protocol 兼容。这样可以避免 JS 状态机和 native 自动化同时大改。

规则：

- 首个正式版本不重命名 helper commands。
- 除 additive 字段外，不改变 response shape。
- 保持稳定 reasonCode。
- Helper 只是 capability runtime，不是业务 daemon。
- 所有影响 UI 的命令必须串行化。

## 本地数据所有权

默认本地根目录：

```text
~/.usechat/
  config.json
  logs/
  traces/
  ledger/
  attachments/
    inbound/
    outbound/
  helper/
```

默认不保存原始截图、OCR 全文或剪贴板内容。read/write 结果会返回脱敏 `traceSummary`；只有显式传入 `--trace-jsonl [path]` 或 runtime trace path 时才写 JSONL trace events。诊断导出必须是用户显式动作。

## Model provider contract

Core 只依赖 provider interface：

```ts
interface VisionModelProvider {
  structureVisibleWindow(input: StructureVisibleWindowInput): Promise<StructureVisibleWindowResult>
  classifyWindow?(input: ClassifyWindowInput): Promise<ClassifyWindowResult>
}
```

第一个实现是 OpenAI-compatible chat completions 风格的视觉 endpoint。

## Connector interface

初始 TypeScript 形态：

```ts
interface MessagingConnector {
  doctor(): Promise<DoctorResult>
  read(input: ReadInput): Promise<ReadResult>
  write(input: WriteInput): Promise<WriteResult>
  watch?(input: WatchInput): AsyncIterable<ConnectorEvent>
}
```

微信是第一个实现。这个接口不应该硬编码微信概念，除非该概念确实是 connector-specific。
