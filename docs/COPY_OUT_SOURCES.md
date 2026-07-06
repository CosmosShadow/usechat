# Copy-out Sources

本文件记录 UseChat Phase 1 从 Shennian copy-out 的源码来源，便于后续 diff、归因和协议兼容检查。

- Shennian commit：`65e5ed3db3e8f195522363cb3d20baf1d2b63657`
- Copy-out 日期：2026-07-07
- Copy-out 模式：只读复制，不修改 Shennian 仓库。

## 文件清单

```text
packages/cli/src/channels/wechat-channel/helper-protocol.ts
  -> packages/core/src/wechat/helper-protocol.ts

packages/cli/src/channels/wechat-channel/helper-client.ts
  -> packages/core/src/wechat/helper-client.ts

packages/cli/src/channels/wechat-channel/helper-assets.ts
  -> packages/core/src/wechat/helper-assets.ts

packages/cli/src/channels/wechat-channel/human-coordination.ts
  -> packages/core/src/wechat/human-coordination.ts

packages/cli/native/wechat-channel-helper/macos/ShennianWeChatChannelHelper.swift
  -> native/macos/ShennianWeChatChannelHelper.swift

packages/cli/native/wechat-channel-helper/windows/*
  -> native/windows/*

packages/cli/native/wechat-channel-helper/scripts/*
  -> helper-runtime/scripts/native-helper/*

packages/helper-runtime/scripts/*
  -> helper-runtime/scripts/*

packages/helper-runtime/wechat-channel/{macos,windows}/manifest.json
packages/helper-runtime/wechat-channel/{macos,windows}/helper-runtime-package.json
  -> helper-runtime/wechat-channel/{macos,windows}/
```

## 未复制内容

```text
packages/helper-runtime/wechat-channel/**/helper binary
packages/helper-runtime/wechat-channel/windows/*.dll
packages/helper-runtime/dist/**/*.zip
packages/helper-runtime/dist/**/helper-runtime-evidence.json
packages/helper-runtime/dist/**/install-helper-runtime.ps1
```

这些二进制和发布产物后续需要在 UseChat 自己的构建、签名、notice 和 release 流程中重新生成。
