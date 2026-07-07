# UseChat 源码来源说明

UseChat 当前处于私有 copy-out 阶段。首批 helper protocol、helper client、native helper 和 helper runtime 打包脚本来自 Shennian 项目中的微信 channel / helper runtime 实现。

## Copy-out 快照

- 来源项目：Shennian
- 来源本地路径：`/Users/lichen/Documents/code/projects/shennian`
- 来源提交：`65e5ed3db3e8f195522363cb3d20baf1d2b63657`
- Copy-out 时间：2026-07-07

## Copy-out 范围

### TypeScript helper 协议与客户端

| UseChat 路径 | Shennian 来源路径 |
|-------------|-------------------|
| `packages/core/src/wechat/helper-protocol.ts` | `packages/cli/src/channels/wechat-channel/helper-protocol.ts` |
| `packages/core/src/wechat/helper-client.ts` | `packages/cli/src/channels/wechat-channel/helper-client.ts` |
| `packages/core/src/wechat/helper-assets.ts` | `packages/cli/src/channels/wechat-channel/helper-assets.ts` |
| `packages/core/src/wechat/human-coordination.ts` | `packages/cli/src/channels/wechat-channel/human-coordination.ts` |

### Native helper 源码

| UseChat 路径 | Shennian 来源路径 |
|-------------|-------------------|
| `native/macos/ShennianWeChatChannelHelper.swift` | `packages/cli/native/wechat-channel-helper/macos/ShennianWeChatChannelHelper.swift` |
| `native/windows/*` | `packages/cli/native/wechat-channel-helper/windows/*` |

### Helper runtime 脚本、manifest 与运行资产

| UseChat 路径 | Shennian 来源路径 |
|-------------|-------------------|
| `helper-runtime/scripts/native-helper/*` | `packages/cli/native/wechat-channel-helper/scripts/*` |
| `helper-runtime/scripts/build-all.mjs` | `packages/helper-runtime/scripts/build-all.mjs` |
| `helper-runtime/scripts/build-macos-helper-app.mjs` | `packages/helper-runtime/scripts/build-macos-helper-app.mjs` |
| `helper-runtime/scripts/build-windows-helper-runtime.mjs` | `packages/helper-runtime/scripts/build-windows-helper-runtime.mjs` |
| `helper-runtime/scripts/validate-runtime-assets.mjs` | `packages/helper-runtime/scripts/validate-runtime-assets.mjs` |
| `helper-runtime/wechat-channel/macos/manifest.json` | `packages/helper-runtime/wechat-channel/macos/manifest.json` |
| `helper-runtime/wechat-channel/macos/helper-runtime-package.json` | `packages/helper-runtime/wechat-channel/macos/helper-runtime-package.json` |
| `helper-runtime/wechat-channel/windows/manifest.json` | `packages/helper-runtime/wechat-channel/windows/manifest.json` |
| `helper-runtime/wechat-channel/windows/helper-runtime-package.json` | `packages/helper-runtime/wechat-channel/windows/helper-runtime-package.json` |
| `helper-runtime/wechat-channel/macos/shennian-wechat-channel-helper` | `packages/helper-runtime/wechat-channel/macos/shennian-wechat-channel-helper` |
| `helper-runtime/wechat-channel/windows/shennian-wechat-channel-helper.exe` | `packages/helper-runtime/wechat-channel/windows/shennian-wechat-channel-helper.exe` |
| `helper-runtime/wechat-channel/windows/*.dll` | `packages/helper-runtime/wechat-channel/windows/*.dll` |
| `helper-runtime/wechat-channel/windows/models/v5/*` | `packages/helper-runtime/wechat-channel/windows/models/v5/*` |

## 当前取舍

- UseChat 首个正式版本按“全量能力 copy-out”处理：helper 源码、helper protocol、JS runtime、helper runtime 二进制、Windows native DLL 和 PP-OCRv5 模型都来自 Shennian 已有实现或运行资产。
- 本仓库不重新实现微信自动化、OCR、协议或客户端控制能力；只做路径、包名、私有 release、文档和独立项目接线适配。
- helper runtime zip 和 release evidence 由 UseChat release 脚本重新生成，生成过程必须记录 sha256、manifest、签名状态和来源说明。
- 首个正式版本保持 helper command 名称和 response shape 兼容。
- 后续如修改 helper protocol，需要同步更新架构文档、测试和兼容说明。
