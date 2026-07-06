# UseChat

> **Private project scaffold. Not open source yet.**
>
> UseChat is **Computer Use for messaging agents**. It lets AI agents use local messaging apps through visible, permissioned desktop automation. The first connector is WeChat.

## Positioning

UseChat is not a bot platform, not a protocol hack, and not a bulk messaging tool. It is a local-first computer-use runtime for a user's own messaging desktop apps:

```text
AI Agent
  -> UseChat CLI / SDK / tool server
  -> UseChat connector core
  -> native helper runtime
  -> visible desktop messaging app
```

The first product target is:

```bash
usechat doctor
usechat read --app wechat --chat "ABC" --limit 10
usechat write --app wechat --chat "ABC" --text "hello" --yes
```

## Why UseChat

Messaging apps are still where real work happens. Most AI agents can write code, browse files, and call APIs, but they cannot safely use the user's local chat apps. UseChat makes that ability explicit, local, auditable, and permissioned.

Principles:

- **Local-first**: the user's app, account, screen, files, and permissions stay on the user's computer.
- **Visible computer use**: no protocol cracking, no client injection, no local database scraping.
- **Agent-ready**: CLI first, SDK second, tool/MCP server later.
- **Bring your own model**: users configure an OpenAI-compatible vision model; UseChat does not require Shennian Cloud.
- **Helper source included**: native helper source will live in this repository so the system is auditable and self-buildable.
- **Human control**: sending defaults to explicit confirmation unless the user opts into `--yes` or a policy allows automation.

## Initial scope

UseChat starts with WeChat Desktop on macOS and Windows.

### MVP commands

```bash
usechat init
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY

usechat doctor
usechat read --app wechat --chat "文件传输助手" --limit 10
usechat write --app wechat --chat "文件传输助手" --text "hello" --yes
```

### MVP capabilities

- Discover and validate the native helper runtime.
- Check platform permissions and WeChat readiness.
- Open a named WeChat conversation.
- Capture the visible chat window.
- Structure current visible messages with a user-configured vision model.
- Print Markdown or JSON.
- Send text with confirmation / `--yes`.

### Later capabilities

- File, image, and video send.
- Visible media download and local materialization.
- Local ledger, baseline, dedupe, and echo suppression.
- `watch` mode emitting JSONL events.
- Tool server / MCP-style interface for Codex, Claude Code, Cursor, OpenCode, and custom agents.
- Additional messaging connectors after WeChat.

## Repository layout

```text
usechat/
  packages/core/             # Connector state machine, ledger, schema, trace, outbound logic.
  packages/cli/              # `usechat` command-line interface.
  packages/sdk/              # Embeddable TypeScript API.
  packages/model-provider/   # OpenAI-compatible vision provider and schema prompts.
  native/macos/              # macOS helper source and build notes.
  native/windows/            # Windows helper source and build notes.
  helper-runtime/            # Helper package, manifest, install, upgrade, release artifacts.
  docs/                      # Architecture, plan, helper runtime, compliance notes.
  examples/                  # Agent integration examples.
```

## Relationship with Shennian

UseChat is extracted as a new private project. The existing Shennian repository remains untouched during the initial extraction.

Short-term relationship:

- Copy-out design and implementation from Shennian only when needed.
- Do not make Shennian depend on UseChat during the first phase.
- Keep helper protocol behavior compatible with the current Shennian helper.
- Let UseChat prove itself independently before discussing reverse integration.

Long-term relationship:

- UseChat can become the reusable messaging computer-use layer.
- Shennian can later consume UseChat as one connector in its broader agent control plane.

## Non-goals

- No WeChat protocol reverse engineering.
- No process injection.
- No reading WeChat local databases.
- No scanning caches or Downloads to guess attachments.
- No bulk messaging, marketing automation, anti-ban claims, or multi-account control.
- No silent GUI helper install during npm `postinstall`.
- No hidden cloud dependency for the first standalone release.

## Status

Current status: **private planning scaffold**.

Next step: follow [PLAN.md](./PLAN.md) to copy the existing helper source and connector logic into this repository without modifying Shennian.
