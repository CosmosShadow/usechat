# Signing / Notarization / SmartScreen 方案

UseChat helper runtime 首个私有 release 可以分发未正式签名产物，但 evidence 必须明确标记 `signed: false` / `notarized: false`。公开 release 前必须完成签名链路。

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

## 当前私有 release 状态

- macOS ad-hoc codesign 可验证，但 Gatekeeper assessment 未通过，公开前必须 Developer ID + notarization。
- Windows helper 当前可构建/运行，但私有 evidence 标记 `signed: false`，公开前必须 Authenticode + SmartScreen 方案落地。
