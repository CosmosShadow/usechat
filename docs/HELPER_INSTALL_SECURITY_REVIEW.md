# Helper Install / Zip Extraction 安全评审

UseChat 不在 npm `postinstall` 阶段静默安装 GUI helper。helper runtime 安装必须由用户显式运行：

```bash
usechat setup-helper --from <helper-runtime.zip|app|dir> [--target <path>] [--force]
```

## 安全边界

- 只接受本地路径，不从 URL 下载。
- 解压到新建临时目录，再从临时目录中识别 `UseChat Helper.app` 或 `UseChat Helper` runtime root；同时兼容历史 `Shennian Helper` runtime root。
- 只复制识别出的 helper runtime root 到目标路径。
- 目标路径已存在时必须显式 `--force`。
- Windows 替换前会停止 `shennian-wechat-channel-helper.exe`，沿用 Shennian installer 的行为，避免 DLL 占用导致半安装。
- 安装后必须存在平台 manifest：
  - macOS：`Contents/Resources/wechat-channel/macos/manifest.json`
  - Windows：`resources/wechat-channel/windows/manifest.json`
- npm package 不携带 postinstall 安装副作用。

## 仍需公开前加强

- 对公开下载产物增加 release-level sha256 校验说明。
- 对 Windows zip 增加 Authenticode / checksum verification UX。
- 对 macOS zip 增加 notarization / Gatekeeper 验证 UX。

## 当前结论

私有 release 可接受：安装动作显式、目标可见、默认路径稳定、失败时不会执行微信 UI 动作。公开 release 前需要把签名校验体验做成用户可理解的安装流程。
