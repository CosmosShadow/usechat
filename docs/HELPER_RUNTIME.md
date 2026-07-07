# Helper Runtime

UseChat 包含 native helper 源码，并为普通用户使用 helper runtime artifact。

## 为什么需要 Helper

纯 Node.js 包无法稳定提供 macOS 和 Windows 上的所有桌面能力：

- 稳定的系统权限身份；
- 窗口发现和聚焦；
- 窗口截图；
- 本地 OCR / layout hints；
- 鼠标、键盘、右键、滚动；
- 剪贴板文本和文件操作；
- 文件、图片、视频物化；
- 用户活动和接管检测。

UseChat 把这些能力放在 native helper，把产品逻辑留在 TypeScript。

## 首个正式版本兼容目标

初始 helper 源码和 protocol 从当前 Shennian helper 实现 copy-out，并保持行为兼容。

首个正式版本的命令仍使用 JSON-RPC 风格，包括：

- `health.check`
- `permissions.check`
- `windows.ensureReady`
- `windows.capture`
- `windows.captureAndOcr`
- `wechat.searchConversation`
- `wechat.focusMessageInput`
- `wechat.pasteAndSubmit`
- `mouse.click`
- `mouse.rightClick`
- `keyboard.shortcut`
- `clipboard.snapshot`
- `clipboard.restore`
- `clipboard.setText`
- `clipboard.setFiles`
- `clipboard.readFileUrls`
- `activity.snapshot`
- `automation.lease.*`

## 源码目录

```text
native/macos/      # Swift helper 源码
native/windows/    # C#/.NET helper 源码
helper-runtime/    # 打包、manifest、安装、release 工具
```

## 用户路径

### 普通用户

```bash
usechat setup-helper
usechat doctor
```

普通用户应该使用预编译 helper runtime artifact。setup 动作必须显式触发，不能在 npm install 时静默执行。

### 开发者

```bash
pnpm helper-runtime:build:native:mac
pnpm helper-runtime:build:mac
pnpm helper-runtime:build:native:win
pnpm helper-runtime:build:win
usechat config set helper.path /path/to/helper
```

开发者可以自编译，并让 UseChat 指向自己的 helper。

macOS helper 从 `native/macos/ShennianWeChatChannelHelper.swift` 构建；Windows helper 从 `native/windows/Shennian.WeChatChannel.Helper.Win.csproj` 构建。两者都是 Shennian copy-out 源码，UseChat 只做目录、包名和 release evidence 适配。

完整私有 release 流程见 `docs/RELEASE.md`。

## Windows 可见桌面要求

Windows 的微信 UI 自动化必须运行在已登录的可见桌面会话中。通过 SSH 直接启动命令通常处于 Session 0，不能可靠读取或操作用户桌面窗口。

远程回归请使用交互式计划任务入口：

```powershell
pnpm smoke:wechat:abc:windows-task
```

该入口会把 `scripts/wechat-abc-smoke.mjs` 放到当前用户可见桌面会话里执行，并把摘要写入：

```text
.usechat-smoke/windows/summary.json
```

如果摘要返回 `wechat_login_required`，表示微信桌面端当前需要用户重新登录或完成安全验证。UseChat 在这个状态下会 fail closed：停止 read/write 后续步骤，write 不会继续点击、粘贴或发送。处理方式是先在 Windows 桌面上手动登录微信，确认目标对话可见或可搜索，然后重新运行 smoke。

## Release artifact 要求

每个 helper runtime release 应包含：

- helper version；
- protocol version；
- platform 和 architecture；
- manifest JSON；
- sha256 校验和；
- 必要时包含签名 / notarization / Authenticode evidence；
- third-party notices；
- source revision。

Windows runtime 还必须包含 Shennian 既定的本地 OCR 运行资产：RapidOcrNet / ONNX Runtime 相关 native DLL 和 PP-OCRv5 模型。不能改成云 OCR，也不能为了精简包体替换成另一套实现。

## 安全规则

- Helper 不做业务 scheduler。
- Helper 不做隐藏网络调用。
- Helper 内不放 model provider。
- 不直接读取微信数据库。
- 不注入进程。
- 权限、窗口、截图、剪贴板或用户接管状态不确定时 fail closed。
