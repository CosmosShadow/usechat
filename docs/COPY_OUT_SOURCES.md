# Copy-out 来源

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

packages/cli/src/channels/wechat-channel/anchor.ts
  -> packages/core/src/wechat/anchor.ts

packages/cli/src/channels/wechat-channel/pacing.ts
  -> packages/core/src/wechat/pacing.ts

packages/cli/src/channels/wechat-channel/outbound-ledger.ts
  -> packages/core/src/wechat/outbound-ledger.ts

packages/cli/src/channels/wechat-channel/outbound-sender.ts
  -> packages/core/src/wechat/outbound-sender.ts

packages/cli/src/commands/external-attachments.ts
  -> packages/core/src/wechat/attachment.ts


packages/cli/src/channels/wechat-channel/core/schema.ts
  -> packages/core/src/wechat/core/schema.ts

packages/cli/src/channels/wechat-channel/core/media-action-plan.ts
  -> packages/core/src/wechat/core/media-action-plan.ts

packages/cli/src/channels/wechat-channel/message-key.ts
  -> packages/core/src/wechat/message-key.ts

packages/cli/src/channels/wechat-channel/ledger.ts
  -> packages/core/src/wechat/ledger.ts

packages/cli/src/channels/wechat-channel/media-cache-resolver.ts
  -> packages/core/src/wechat/media-cache-resolver.ts


packages/cli/src/channels/wechat-channel/media-resolver.ts
  -> packages/core/src/wechat/media-resolver.ts


packages/cli/src/channels/wechat-channel/observer.ts `resolveObservedMessageMedia` 相关候选识别 / mediaMetadata 合并逻辑
  -> packages/core/src/wechat/inbound-media.ts

packages/cli/src/channels/base.ts `ExternalMessageAttachment`
  -> packages/core/src/wechat/types.ts `ExternalMessageAttachment`

packages/cli/src/__tests__/wechat-channel-media-resolver.test.ts
  -> packages/core/src/__tests__/wechat-media-resolver.test.ts

packages/cli/src/channels/wechat-channel/cooldown.ts
  -> packages/core/src/wechat/cooldown.ts

packages/cli/src/channels/wechat-channel/vector-store.ts
  -> packages/core/src/wechat/vector-store.ts

packages/cli/src/__tests__/wechat-channel-core-schema.test.ts
  -> packages/core/src/__tests__/wechat-core-schema.test.ts

packages/cli/src/__tests__/wechat-channel-media-action-plan.test.ts
  -> packages/core/src/__tests__/wechat-media-action-plan.test.ts

packages/cli/src/__tests__/wechat-channel-message-key.test.ts
  -> packages/core/src/__tests__/wechat-message-key.test.ts

packages/cli/src/__tests__/wechat-channel-ledger.test.ts
  -> packages/core/src/__tests__/wechat-ledger.test.ts

packages/cli/src/__tests__/wechat-channel-vector-store.test.ts
  -> packages/core/src/__tests__/wechat-vector-store.test.ts

packages/cli/src/__tests__/wechat-channel-cooldown.test.ts
  -> packages/core/src/__tests__/wechat-cooldown.test.ts

scripts/wechat-rpa-lab/fixtures/visible-window-structure/download-ground-truth.json
  -> scripts/wechat-rpa-lab/fixtures/visible-window-structure/download-ground-truth.json

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


## UseChat 路径适配说明

本轮 copy-out 只做路径、包名和本地存储约定适配，不重写微信能力：

- `client.ts` 中的 `WeChatChannelObservedMessage` / `WeChatChannelVisualBlock` 类型，在 UseChat 中对应 `packages/core/src/wechat/types.ts`。
- `WECHAT_CHANNEL_RECENT_MESSAGE_WINDOW` 沿用 Shennian 原值 `20`，由 UseChat `packages/core/src/wechat/runtime.ts` 导出，供 ledger / vector store 复用。
- 测试 fixture 保留 Shennian 原始 `download-ground-truth.json`，测试中的读取路径只做 monorepo cwd 兼容。
- 入站媒体 resolver 与 `read --download auto` 接入已从 Shennian observer 相关逻辑 copy-out；watch / serve 仍待后续接入。
- Windows 单测只做 copy-out 兼容适配：`file://` 测试路径改用 Node 标准 `pathToFileURL()`，与 Shennian Windows helper 的 `new Uri(filePath).AbsoluteUri` 和 macOS helper 的 `URL(fileURLWithPath:)` 输出形态保持一致；不改变 resolver 行为。
- 针对“不要把截图 preview 冒充视频原件”的测试，显式锁定非 Windows 平台，避免混入 Shennian 原有 Windows WeChat cache fallback 默认扫描分支；Windows cache fallback 由独立 cache 测试覆盖。
- Trace phase 词表、media resolve trace 和 helper request trace hook 已从 Shennian copy-out；UseChat 新增薄层 trace recorder 负责 summary / JSONL / redaction，本身不重新实现微信 RPA。
- Watch 等仍待后续从 Shennian 对应模块继续 copy-out。
