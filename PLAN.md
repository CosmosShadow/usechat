# UseChat TODO

> 状态：私有执行清单。
>
> 目标：把 UseChat 做成独立、本地优先的消息软件 Computer Use 运行时。第一个连接器是微信桌面端。

## 长期规则

这些是长期规则，不是 TODO：

1. Phase 0-4 不修改现有神念仓库，只做 copy-out。
2. 首个正式版本保持 native helper 行为兼容，不重新设计 helper protocol。
3. 独立模式不依赖神念云，用户自己配置 OpenAI-compatible 视觉模型。
4. 不在 npm `postinstall` 阶段静默安装 native helper；helper setup 必须是用户显式动作。
5. 在 license、合规、签名、安全和 release 文档评审完成前，项目保持私有。
6. 不在日志或 CLI 输出里打印 `.env`、API key、token、原始剪贴板内容或完整截图。

## 目标产品检查项

- [ ] 可以通过 `@shennian/usechat` 或内部等价包安装。
- [x] CLI binary 是 `usechat`。
- [x] `usechat init` 可用。
- [x] `usechat doctor` 可用。
- [x] `usechat read --app wechat --chat "ABC" --format markdown` 可用。
- [x] `usechat write --app wechat --chat "ABC" --text "hello" --yes` 可用。

## Phase 0 — 项目章程与仓库基础

预计：0.5-1 天。

- [x] 创建私有仓库 / 项目目录。
- [x] 添加私有 root `package.json`。
- [x] 添加 pnpm workspace 文件。
- [x] 添加 root TypeScript base config。
- [x] 添加 `.gitignore`。
- [x] 添加 README，说明定位和非目标。
- [x] 添加架构文档。
- [x] 添加 helper runtime 文档。
- [x] 添加安全与合规说明。
- [x] 预留 monorepo 目录：
  - [x] `packages/core`
  - [x] `packages/cli`
  - [x] `packages/sdk`
  - [x] `packages/model-provider`
  - [x] `native/macos`
  - [x] `native/windows`
  - [x] `helper-runtime`
  - [x] `examples`
- [x] 创建初始 git commit。
- [x] 确认 Shennian 仓库没有改动。

验收：

- [x] `package.json` 是 private。
- [x] 没有修改任何 Shennian 文件。
- [x] README + TODO 能说明项目方向。

## Phase 1 — 源码 copy-out 清单

预计：1-2 天。

### 源码 copy-out

- [x] 拷贝 helper protocol 类型到 `packages/core`。
- [x] 拷贝 helper client transport 到 `packages/core`。
- [x] 拷贝 helper asset / runtime resolver 到 `packages/core` 或 `helper-runtime`。
- [x] 拷贝 macOS Swift helper 源码到 `native/macos`。
- [x] 拷贝 Windows C# helper 源码到 `native/windows`。
- [x] 拷贝 macOS helper 构建脚本到 `native/macos` 或 `helper-runtime`。
- [x] 拷贝 Windows helper 构建脚本到 `native/windows` 或 `helper-runtime`。
- [x] 拷贝 helper runtime 打包脚本到 `helper-runtime`。
- [x] 拷贝 helper manifest schema fixture 到 `helper-runtime`。
- [x] 保持 helper command 名称不变。
- [x] 保持 helper response shape 不变，只允许 additive 字段。

### 归因与 notice

- [x] 添加 `NOTICE.md`，记录 copy-out 来源。
- [x] 为 Windows native DLL 和 OCR 模型添加 third-party notice 文件。
- [x] 添加 license 决策说明；当前默认保持 private。
- [x] 记录 Shennian 源码快照 commit / path。

验收：

- [x] 新仓库包含可审计的 helper 源码。
- [x] 暂无行为变更。
- [x] helper 源码可与 Shennian 源码快照 diff。
- [x] 不修改 Shennian 仓库文件。

## Phase 2 — CLI 与本地配置

预计：2-3 天。

### 包结构

- [x] 创建 `packages/cli/package.json`。
- [x] 创建 `packages/core/package.json`。
- [x] 创建 `packages/model-provider/package.json`。
- [x] 创建 `packages/sdk/package.json`。
- [x] 添加 build scripts。
- [x] 添加 typecheck scripts。
- [x] 添加 test runner。

### CLI 基础命令

- [x] 实现 `usechat --version`。
- [x] 实现 `usechat --help`。
- [x] 实现 `usechat init`。
- [x] 实现 `usechat config get [key]`。
- [x] 实现 `usechat config set <key> <value>`。
- [x] 实现 `usechat config list`。

### 配置 schema

- [x] 配置默认写到 `~/.usechat/config.json`。
- [x] 支持 `model.provider`。
- [x] 支持 `model.baseUrl`。
- [x] 支持 `model.name`。
- [x] 支持 `model.apiKeyEnv`。
- [x] 支持可选 `model.timeoutMs`。
- [x] 支持 `helper.path` override。
- [x] 支持 `output.defaultFormat`。
- [x] 支持 `wechat.sendRequiresConfirm`。
- [x] 支持 `dataDir`。
- [x] 校验配置并给出可执行错误提示。

### 密钥处理

- [x] 优先使用 `apiKeyEnv`，不鼓励保存明文 key。
- [x] 永不打印 API key 值。
- [x] JSON 输出中脱敏 secret-like 字段。

验收：

- [x] CLI 不需要神念账号、machine token 或 daemon 即可运行。
- [x] 配置输出永不打印 API key。
- [x] 配置优先使用 `apiKeyEnv`。
- [x] `pnpm test` 或等价测试通过。

## Phase 3 — Helper runtime 发现与 doctor

预计：3-5 天。

### Helper resolver

- [x] 支持显式 `USECHAT_HELPER_DIR`。
- [x] 支持配置 `helper.path`。
- [x] 检测已安装的 Shennian Helper runtime。
- [x] 检测本仓库本地构建的 UseChat helper runtime。
- [x] 预留未来官方 UseChat helper 安装路径。
- [x] 校验 helper manifest。
- [x] 校验 helper executable 存在。
- [x] 校验 helper version。
- [x] 校验 protocol version。
- [x] 校验 required capabilities。

### Doctor 命令

- [x] 实现 `usechat doctor` 人类可读输出。
- [x] 实现 `usechat doctor --json` 机器可读输出。
- [x] 检查平台支持。
- [x] 检查 helper 是否存在。
- [x] 检查 helper health。
- [x] 检查 helper version 和 protocol。
- [x] 检查 required capabilities。
- [x] 检查 macOS 权限。
- [x] 检查 Windows 可见桌面条件。
- [x] 检查微信进程。
- [x] 检查可见微信窗口。
- [x] 检查模型配置。
- [x] 返回稳定 reason codes。

### Reason codes

- [x] `unsupported_platform`。
- [x] `helper_missing`。
- [x] `helper_manifest_missing`。
- [x] `helper_invalid_manifest`。
- [x] `helper_version_mismatch`。
- [x] `helper_protocol_mismatch`。
- [x] `helper_capability_missing`。
- [x] `permission_missing`。
- [x] `wechat_not_running`。
- [x] `wechat_window_not_found`。
- [x] `model_not_configured`。

验收：

- [x] Doctor 返回带稳定 reasonCode 的 JSON。
- [x] Doctor 有人类可读输出。
- [x] helper 缺失时指向显式 setup 说明，不依赖 npm postinstall magic。
- [x] Doctor 不执行危险 UI 动作。

## Phase 4 — 用户自配模型 provider

预计：3-5 天。

### Provider 接口

- [x] 定义 `VisionModelProvider` interface。
- [x] 定义 `structureVisibleWindow` input schema。
- [x] 定义 `structureVisibleWindow` output schema。
- [x] 定义可选 `classifyWindow` input/output schema。
- [x] 将 provider 错误归一为稳定 reasonCode。

### OpenAI-compatible provider

- [x] 实现 Chat Completions-compatible 请求。
- [x] 支持 `model.baseUrl`。
- [x] 支持 `model.name`。
- [x] 从 `model.apiKeyEnv` 读取 API key。
- [x] 支持 timeout。
- [x] 支持 JSON response parsing。
- [x] 去掉 markdown JSON fence。
- [x] 校验返回 JSON。
- [x] 归一化 visible messages。

### Prompt 与 schema

- [x] 添加 visible-window message structuring prompt。
- [x] 必要时添加 window classifier prompt。
- [x] 添加 text message schema 测试。
- [x] 添加 image message schema 测试。
- [x] 添加 file message schema 测试。
- [x] 添加 video-file vs video-card 区分测试。
- [x] 添加 invalid JSON 测试。
- [x] 添加 empty model response 测试。

### Reason codes

- [x] `model_not_configured`。
- [x] `model_request_failed`。
- [x] `model_invalid_json`。
- [x] `model_no_messages`。
- [x] `model_timeout`。

验收：

- [x] 不需要调用神念服务端 VLM。
- [x] 用户可以指向 OpenAI、DashScope-compatible endpoint 或其他 OpenAI-compatible provider。
- [x] Prompt 和 schema 都在本仓库。
- [x] 单元测试覆盖成功和失败场景。

## Phase 5 — 微信 read 首个正式版本

预计：4-7 天。

### 命令

- [x] 实现 `usechat read --app wechat --chat <name>`。
- [x] 支持 `--limit <n>`。
- [x] 支持 `--format markdown`。
- [x] 支持 `--format json`。
- [ ] 首个正式版本支持 `--download never`。
- [x] 添加人类可读失败输出。
- [x] 添加 JSON 失败输出。

### Runtime 流程

- [x] UI 动作前运行 preflight。
- [x] 确保微信窗口 ready。
- [x] 通过搜索打开对话。
- [ ] 尽可能确认目标对话标题。
- [x] 截取当前可见窗口。
- [x] 可用时收集 OCR/layout hints。
- [x] 调用 model provider。
- [x] 归一化消息。
- [ ] 校验消息顺序和 bbox 基本合理性。
- [x] 按 `--limit` 截取。
- [x] 输出 Markdown。
- [x] 输出 JSON。

### 测试与 smoke

- [x] 单元测试 read output formatting。
- [ ] 单元测试 model-to-message normalization。
- [ ] Mock helper read flow 测试。
- [x] macOS smoke：读取 `文件传输助手`。
- [ ] Windows smoke：读取一个已知对话。

验收：

- [x] `usechat read --app wechat --chat "文件传输助手"` 在 macOS 可用。
- [ ] Windows read smoke 通过，或产出明确 platform blocker。
- [x] preflight 失败后不执行危险点击或输入。
- [x] 默认不保存原始截图。

## Phase 6 — 微信 write 首个正式版本

预计：3-5 天。

### 命令

- [x] 实现 `usechat write --app wechat --chat <name> --text <text>`。
- [x] 默认发送前确认。
- [x] 支持 `--yes` 给非交互 Agent 使用。
- [x] 支持 `--json` 输出。
- [x] 支持 `--dry-run`。

### Runtime 流程

- [x] UI 动作前运行 preflight。
- [x] 确保微信窗口 ready。
- [x] 通过搜索打开对话。
- [ ] 尽可能确认目标对话标题。
- [x] snapshot 剪贴板。
- [x] 设置剪贴板文本。
- [x] 粘贴到消息输入框。
- [x] 提交消息。
- [x] restore 剪贴板。
- [x] 返回发送状态。
- [x] unknown status 后不自动重发。

### 测试与 smoke

- [ ] 单元测试确认逻辑。
- [ ] 单元测试 `--yes` 行为。
- [ ] 单元测试 dry run。
- [ ] Mock helper write flow 测试。
- [x] macOS smoke：写入 `文件传输助手`。
- [ ] Windows smoke：写入一个已知对话。

验收：

- [x] 文本发送在 macOS 可用。
- [ ] Windows write smoke 通过，或产出明确 platform blocker。
- [x] crash 或 unknown status 后不自动重发。
- [x] 剪贴板 restore 失败只作为 warning，不触发重发。

## Phase 7 — 完整连接器能力

预计：首个 read/write 版本后 1-2 周。

### 出站附件

- [ ] 支持 `usechat write --file <path>`。
- [ ] 支持 `usechat write --image <path>`。
- [ ] 支持 `usechat write --video <path>`。
- [ ] 校验本机文件存在。
- [ ] 校验文件大小限制。
- [ ] 使用剪贴板文件操作。
- [ ] 发送后 restore 剪贴板。

### 入站媒体

- [ ] 识别当前可见媒体候选。
- [ ] 生成 media action plan。
- [ ] 右键媒体 bbox。
- [ ] OCR 菜单候选选择。
- [ ] 读取剪贴板 file URL / bitmap。
- [ ] 尽可能物化本机原始文件。
- [ ] 入站附件保存到 `~/.usechat/attachments/inbound/`。
- [ ] 区分原始文件和 preview crop。
- [ ] 无法确认原件时返回 `pending-download` / `metadata-only`，不要假成功。

### Ledger 与去重

- [ ] 在 `~/.usechat/ledger/` 实现本机 ledger。
- [ ] 实现 baseline scan。
- [ ] 实现 dedupe。
- [ ] 实现 local echo suppression。
- [ ] 实现 recent window retention。

### Trace

- [ ] 输出 trace summary JSON。
- [ ] 输出 JSONL trace events。
- [ ] 脱敏敏感字段。
- [x] 默认不保存原始截图。

验收：

- [ ] 文本、文件、图片、视频发送在 macOS 和 Windows smoke 通过。
- [ ] 文件 / 视频成功必须拿到真实本机原件，不允许 preview crop 冒充成功。
- [ ] 本机 ledger 避免重复 read event。
- [ ] Trace 可定位 phase failure，默认不泄露内容。

## Phase 8 — Agent 接口

预计：1 周。

### Watch 模式

- [ ] 实现 `usechat watch --app wechat --chat <name> --emit jsonl`。
- [ ] 输出 initial baseline event。
- [ ] 输出 new message event。
- [ ] 输出 error / paused event。
- [ ] 支持 poll interval config。
- [ ] 支持 graceful shutdown。

### 工具服务

- [ ] 设计 `usechat serve --stdio` protocol。
- [ ] 实现 `doctor` tool。
- [ ] 实现 `read` tool。
- [ ] 实现 `write` tool。
- [ ] 返回稳定 JSON contract。
- [ ] 文档化未来 MCP-compatible mapping。

### Agent 文档

- [ ] 添加 Codex 使用说明。
- [ ] 添加 Claude Code 使用说明。
- [ ] 添加 Cursor / OpenCode 使用说明。
- [ ] 添加 custom agent JSON 示例。

验收：

- [ ] 外部 Agent 可以通过 CLI 调用 read/write。
- [ ] 程序化模式有稳定 JSON contract。
- [ ] 面向 Agent 的人类确认策略已文档化。

## Phase 9 — 私有正式 release

预计：1 周。

### Packaging

- [ ] 确定内部 package registry / GitHub package 路径。
- [ ] 构建 CLI package。
- [ ] 如果 SDK 已准备好，构建 SDK package。
- [ ] 如果 model-provider 单独发包，构建 model-provider package。
- [ ] 生成 package provenance notes。

### Helper artifacts

- [ ] 添加 macOS helper 构建说明。
- [ ] 添加 Windows helper 构建说明。
- [ ] 构建 macOS helper runtime。
- [ ] 构建 Windows helper runtime。
- [ ] 可选：签名 macOS helper。
- [ ] 可选：签名 Windows helper。
- [ ] 生成 helper runtime manifests。
- [ ] 生成 helper runtime evidence。

### 私有 release 检查

- [ ] clean-machine macOS install。
- [ ] clean-machine macOS doctor。
- [ ] clean-machine macOS read。
- [ ] clean-machine macOS write。
- [ ] clean-machine Windows install。
- [ ] clean-machine Windows doctor。
- [ ] clean-machine Windows read。
- [ ] clean-machine Windows write。
- [ ] BYO model setup 文档已验证。
- [ ] Troubleshooting 文档已验证。

验收：

- [ ] 能从 package 安装。
- [ ] 能配置 BYO model。
- [ ] 能在 macOS 和 Windows 运行 doctor/read/write。
- [ ] 文档足够内部测试用户使用。

## 公开开源前 release gates

- [ ] License review。
- [ ] Third-party notices 完整。
- [ ] Helper 源码和二进制 provenance 已文档化。
- [ ] macOS signing / notarization 方案已确定。
- [ ] Windows signing / SmartScreen 方案已确定。
- [ ] helper install / zip extraction 安全评审完成。
- [ ] 合规文案评审完成。
- [ ] 文档中没有防封 / 群发 / 营销话术。
- [ ] Public README 改写成面向外部用户的版本。
- [ ] 创建 contribution 和 issue templates。
- [ ] 添加 responsible disclosure policy。

## 时间线摘要

- [ ] 首个正式版本（`doctor + read + write + BYO model`）：目标 **3-4 周**。
- [ ] 完整微信连接器 release：目标 **6-8 周**。
- [ ] 公开开源候选：需要额外完成法律、安全、签名、release 和社区文档评审。
