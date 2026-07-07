# UseChat

UseChat is a local-first Computer Use runtime for messaging agents.

It lets AI agents use the messaging apps already running on your own computer through visible, permissioned desktop automation. The first connector is WeChat Desktop on macOS and Windows.

## What it does

- Check local helper, permissions, visible desktop, and app state.
- Read the currently visible messages from a specified chat.
- Send text, files, images, and videos when explicitly authorized.
- Watch a specified chat and emit JSONL events.
- Expose CLI / SDK / stdio tool interfaces for agents.
- Keep model configuration local; users bring their own OpenAI-compatible vision model.

## What it does not do

- It does not reverse engineer messaging protocols.
- It does not inject into messaging apps.
- It does not read local message databases.
- It does not hide sending behavior.
- It is not a bulk marketing or multi-account control tool.

## Install

```bash
npm install -g @shennian/usechat
usechat setup-helper --from ./UseChat-Helper-Runtime-macos.zip --force
usechat init
usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY
usechat doctor
```

## Use

```bash
usechat read --app wechat --chat "ABC" --format json
usechat write --app wechat --chat "ABC" --text "hello" --yes --json
usechat watch --app wechat --chat "ABC" --emit jsonl
usechat serve --stdio
```

## Safety

UseChat is designed around visible desktop automation, explicit installation, local configuration, user-controlled sending, and fail-closed behavior when permissions, windows, login state, or user activity are uncertain.
