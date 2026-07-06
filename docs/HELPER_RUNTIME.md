# Helper Runtime

UseChat includes native helper source and uses helper runtime artifacts for normal users.

## Why a helper exists

A pure Node.js package cannot reliably provide all required desktop capabilities across macOS and Windows:

- stable permission identity;
- window discovery and focus;
- window capture;
- local OCR / layout hints;
- mouse, keyboard, right-click, scroll;
- clipboard text and file operations;
- file/image/video materialization;
- user activity and takeover detection.

UseChat keeps these capabilities in a native helper and keeps product logic in TypeScript.

## First release compatibility target

The initial helper source and protocol should be copied from the current Shennian helper implementation and kept behavior-compatible.

First release commands remain JSON-RPC style, including:

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

## Source layout

```text
native/macos/      # Swift helper source
native/windows/    # C#/.NET helper source
helper-runtime/    # packaging, manifest, install, release tools
```

## User paths

### Normal users

```bash
usechat setup-helper
usechat doctor
```

Normal users should receive a prebuilt helper runtime artifact. The setup action must be explicit and must not run silently during npm install.

### Developers

```bash
pnpm build:helper:mac
pnpm build:helper:win
usechat config set helper.path /path/to/helper
```

Developers can self-build and point UseChat at their local helper.

## Release artifact requirements

Each helper runtime release should include:

- helper version;
- protocol version;
- platform and architecture;
- manifest JSON;
- sha256 checksums;
- signing / notarization / Authenticode evidence where applicable;
- third-party notices;
- source revision.

## Safety rules

- No helper business scheduler.
- No hidden network calls from helper.
- No model provider inside helper.
- No direct reading of WeChat databases.
- No process injection.
- Fail closed on permission, window, screenshot, clipboard, or user takeover uncertainty.
