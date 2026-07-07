# Release 流程

UseChat 当前按公开 npm package + 显式 helper runtime artifact 的方式发布。微信能力必须来自 Shennian copy-out 的源码、脚本和运行时资产；release 脚本只负责构建、打包、校验和记录 provenance，不重新实现微信 RPA。

## Release 产物

一次私有 release 至少包含两类产物：

1. 公开 npm package：
   - `@shennian/usechat-core`
   - `@shennian/usechat-model-provider`
   - `@shennian/usechat-sdk`
   - `@shennian/usechat`
2. native helper runtime：
   - macOS：`UseChat Helper.app` + `helper-runtime-package.json` + `helper-runtime-evidence.json` + zip。
   - Windows：`UseChat Helper` runtime 目录 + `install-helper-runtime.ps1` + `helper-runtime-package.json` + `helper-runtime-evidence.json` + zip。

Helper 名称暂时保持 `Shennian Helper`，因为首个 UseChat release 要兼容 Shennian 已有 helper protocol、权限身份和用户端安装路径。UseChat CLI resolver 同时支持 UseChat 和 Shennian helper 路径。

## 包发布路径

当前默认发布路径：

- npm registry：`https://registry.npmjs.org/`；scope：`@shennian/*`；access：`public`。
- CLI 包名：`@shennian/usechat`。
- CLI binary：`usechat`。

正式执行前需要确定：

- registry URL；
- scope 权限；
- 谁可以 publish；
- 谁可以 install；
- 是否需要 provenance attestation 或私有 CI 构建日志。

## 构建公开 npm 包

在仓库根目录运行：

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm release:npm:pack
pnpm release:npm:dry-run
pnpm release:npm:publish
```

输出目录：

```text
dist/release/packages/
  shennian-usechat-core-<version>.tgz
  shennian-usechat-model-provider-<version>.tgz
  shennian-usechat-sdk-<version>.tgz
  shennian-usechat-<version>.tgz
  package-provenance.json
```

`package-provenance.json` 记录：

- git commit / branch / dirty 状态；
- Node 和 pnpm 版本；
- 每个 tarball 的 sha256、大小和文件清单；
- release notes，说明微信能力来自 Shennian copy-out，而非 release 脚本重写。

## 构建 macOS helper runtime

macOS helper 从 `native/macos/ShennianWeChatChannelHelper.swift` 构建，源码来自 Shennian copy-out。

```bash
pnpm helper-runtime:build:native:mac
pnpm helper-runtime:validate
pnpm helper-runtime:build:mac
```

输出目录：

```text
helper-runtime/dist/macos/
  UseChat Helper.app/
  UseChat-Helper-Runtime-macos.zip
  helper-runtime-package.json
  helper-runtime-evidence.json
```

可选签名 / notarization：

```bash
USECHAT_HELPER_APP_SIGN=1 \
USECHAT_HELPER_APP_SIGN_IDENTITY="Developer ID Application: ..." \
pnpm helper-runtime:build:mac

USECHAT_HELPER_APP_SIGN=1 \
USECHAT_HELPER_APP_NOTARIZE=1 \
USECHAT_NOTARYTOOL_PROFILE=<keychain-profile> \
pnpm helper-runtime:build:mac
```

不要在命令输出或文档中打印 Apple 密码、profile secret 或 `.env` 内容。

## 构建 Windows helper runtime

Windows helper 从 `native/windows/Shennian.WeChatChannel.Helper.Win.csproj` 构建，源码来自 Shennian copy-out。

Windows 构建机运行：

```powershell
pnpm helper-runtime:build:native:win
pnpm helper-runtime:validate
pnpm helper-runtime:build:win
```

输出目录：

```text
helper-runtime/dist/windows/
  Shennian Helper/
  UseChat-Helper-Runtime-windows.zip
  install-helper-runtime.ps1
  helper-runtime-package.json
  helper-runtime-evidence.json
```

Windows OCR 运行时必须使用 Shennian 已确定的本地路线：`RapidOcrNet + PP-OCRv5 + ONNX Runtime/.NET`。模型和 native DLL 属于 helper runtime assets，不能换成新的云 OCR 或另起一套 OCR 实现。

可选签名：

```powershell
$env:USECHAT_HELPER_WINDOWS_SIGN="1"
$env:SIGNTOOL="signtool.exe"
pnpm helper-runtime:build:win
```

如果使用外部签名系统先签好 exe，再打 runtime：

```powershell
$env:USECHAT_HELPER_WINDOWS_EXTERNAL_SIGNED="1"
pnpm helper-runtime:build:win
```

## Clean-machine 验收

每个平台 release 后都要在干净机器上验证：

1. 安装 Node.js / pnpm。
2. 从公开 npm 安装 `@shennian/usechat`。
3. 显式安装 helper runtime，不能依赖 npm `postinstall` 静默安装。
4. 配置 BYO model 或 `ocr-only` smoke provider。
5. 运行：

```bash
usechat init
usechat doctor --json
usechat read --app wechat --chat "ABC" --format json --download never
usechat write --app wechat --chat "ABC" --text "UseChat release smoke ..." --yes --json
```

附件 smoke：

```bash
pnpm smoke:wechat:abc:attachments
```

Windows 远程测试必须在已登录的可见桌面会话中运行：

```powershell
pnpm smoke:wechat:abc:windows-task
pnpm smoke:wechat:abc:attachments:windows-task
```

## Release gate

私有 release 可以允许未 notarized / 未 SmartScreen 预热，但必须在 evidence 中明确标记。公开开源前必须完成：

- license review；
- third-party notices；
- helper 源码和二进制 provenance；
- macOS signing / notarization；
- Windows signing / SmartScreen；
- helper install / zip extraction 安全评审；
- 合规文案评审；
- public README 和社区模板。
