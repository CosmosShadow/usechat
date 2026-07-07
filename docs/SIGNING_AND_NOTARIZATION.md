# Signing / Notarization / SmartScreen 方案

UseChat Helper runtime 是本机 GUI 自动化能力层。公开分发时，release evidence 必须明确记录签名、notarization、Gatekeeper 或 Authenticode 验证状态。

## macOS

构建脚本：

```bash
USECHAT_HELPER_APP_SIGN=1 \
USECHAT_HELPER_APP_SIGN_IDENTITY="Developer ID Application: ..." \
pnpm helper-runtime:build:mac

USECHAT_HELPER_APP_SIGN=1 \
USECHAT_HELPER_APP_NOTARIZE=1 \
USECHAT_NOTARYTOOL_PROFILE=<keychain-profile> \
pnpm helper-runtime:build:mac
```

要求：

- Developer ID Application 证书；
- hardened runtime；
- `codesign --verify --deep --strict` 通过；
- notarization submit + staple；
- `spctl --assess --type execute` 通过；
- evidence 写入 `helper-runtime-evidence.json`。

## Windows

构建脚本支持两种方式：

```powershell
$env:USECHAT_HELPER_WINDOWS_SIGN="1"
$env:SIGNTOOL="signtool.exe"
pnpm helper-runtime:build:win
```

或外部 EV / 云签名后打包：

```powershell
$env:USECHAT_HELPER_WINDOWS_EXTERNAL_SIGNED="1"
pnpm helper-runtime:build:win
```

要求：

- Authenticode 签名；
- RFC3161 timestamp；
- `signtool verify /pa /v` 或 PE security directory evidence；
- SmartScreen 预热策略和下载域名 reputation 方案；
- evidence 写入 `helper-runtime-evidence.json`。

## 当前状态

- macOS helper 已支持 Developer ID 签名和 notarization 流程；公开 artifact 应优先使用 notarized zip。
- Windows helper 已支持外部 EV / 云签名后打包，并在 evidence 中记录 PE security directory 检测结果。
- 如果某个测试 artifact 未 notarized 或未完成 SmartScreen 预热，必须在 evidence 和 release notes 中显式标记。
