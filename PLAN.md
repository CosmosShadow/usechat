# UseChat Plan

> Status: private planning document.
>
> Goal: build UseChat as an independent, local-first computer-use runtime for messaging agents. First connector: WeChat Desktop.

## Ground rules

1. **Do not modify the existing Shennian repository in Phase 0-4.** Use copy-out only.
2. **Keep the native helper behavior compatible.** Do not redesign the helper protocol during MVP.
3. **No Shennian Cloud dependency for standalone mode.** Users configure their own OpenAI-compatible vision model.
4. **No silent native install in npm postinstall.** Helper setup is an explicit user action.
5. **Start private.** Public open-source release requires a separate license, compliance, signing, and security review.

## Target product

```bash
npm install -g @shennian/usechat
usechat init
usechat doctor
usechat read --app wechat --chat "ABC" --format markdown
usechat write --app wechat --chat "ABC" --text "hello" --yes
```

## Phase 0 — Project charter and scaffold

Estimate: 0.5-1 day.

Deliverables:

- Private repository created.
- README, plan, architecture, helper runtime notes.
- Monorepo layout reserved for core, CLI, SDK, model provider, native helper, and helper runtime.
- Initial git commit.

Acceptance:

- `package.json` is private.
- No Shennian file is modified.
- Project direction is understandable from README + PLAN.

## Phase 1 — Copy-out source inventory

Estimate: 1-2 days.

Deliverables:

- Copy helper protocol and helper client into `packages/core`.
- Copy macOS helper source into `native/macos`.
- Copy Windows helper source into `native/windows`.
- Copy helper packaging scripts into `helper-runtime`.
- Keep original protocol and helper command names unchanged.
- Add source attribution notes and third-party notices.

Acceptance:

- New repository contains auditable helper source.
- No behavior change yet.
- Helper source can still be compared against the Shennian source snapshot.

## Phase 2 — CLI and local config

Estimate: 2-3 days.

Deliverables:

- `usechat init` creates `~/.usechat/config.json`.
- `usechat config get/set` works.
- Config schema covers:
  - model provider type;
  - model base URL;
  - model name;
  - API key environment variable;
  - helper path override;
  - default output format;
  - send confirmation policy;
  - local data directory.

Acceptance:

- CLI can run without Shennian account, machine token, or daemon.
- Config never prints API keys.
- Config prefers `apiKeyEnv` over raw key storage.

## Phase 3 — Helper runtime discovery and doctor

Estimate: 3-5 days.

Deliverables:

- Helper resolver supports:
  - explicit `USECHAT_HELPER_DIR`;
  - existing installed Shennian Helper runtime;
  - locally built helper runtime under this repository;
  - future official UseChat helper runtime install path.
- `usechat doctor` checks:
  - platform;
  - helper presence;
  - helper version and protocol;
  - required capabilities;
  - macOS / Windows permissions;
  - WeChat process and visible window;
  - model configuration.

Acceptance:

- Doctor returns stable JSON with reason codes.
- Doctor has human-readable output.
- Missing helper points to explicit setup instructions, not npm postinstall magic.

## Phase 4 — Bring-your-own model provider

Estimate: 3-5 days.

Deliverables:

- OpenAI-compatible vision model provider.
- Visible-window message structuring prompt.
- Window classifier prompt if needed for input/search box localization.
- JSON schema validation and normalization.
- Reason codes:
  - `model_not_configured`;
  - `model_request_failed`;
  - `model_invalid_json`;
  - `model_no_messages`;
  - `model_timeout`.

Acceptance:

- No server-side Shennian VLM call is required.
- User can point UseChat at OpenAI, DashScope-compatible endpoints, or another OpenAI-compatible provider.
- Prompt and schema live in this repository.

## Phase 5 — WeChat read MVP

Estimate: 4-7 days.

Deliverables:

- `usechat read --app wechat --chat <name>`.
- Open conversation by search.
- Capture visible window.
- Structure visible messages.
- Output Markdown and JSON.
- Optional `--limit` and `--download never`.

Acceptance:

- macOS smoke: read `文件传输助手`.
- Windows smoke: read one known conversation.
- Failure does not click or type dangerous input after a failed preflight.

## Phase 6 — WeChat write MVP

Estimate: 3-5 days.

Deliverables:

- `usechat write --app wechat --chat <name> --text <text>`.
- Confirmation by default.
- `--yes` for non-interactive agent usage.
- Clipboard snapshot / setText / paste / submit / restore.
- Basic trace summary.

Acceptance:

- macOS smoke: write to `文件传输助手`.
- Windows smoke: write to one known conversation.
- No automatic resend after crash or unknown status.

## Phase 7 — Full connector capabilities

Estimate: 1-2 weeks after MVP.

Deliverables:

- Send file / image / video.
- Visible media download.
- Local attachment materialization under `~/.usechat/attachments/`.
- Local ledger and baseline.
- Dedupe and local echo suppression.
- JSONL trace events.

Acceptance:

- Text, file, image, and video smoke on macOS and Windows.
- File/video success requires real local original file, not preview crop.
- Local ledger avoids duplicate read events in repeated runs.

## Phase 8 — Agent interface

Estimate: 1 week.

Deliverables:

- `usechat watch --app wechat --chat <name> --emit jsonl`.
- `usechat serve --stdio` for tool-style usage.
- Example instructions for Codex / Claude Code / Cursor / OpenCode.
- Future MCP-compatible server design.

Acceptance:

- External agent can call read/write through CLI.
- Programmatic mode has stable JSON contracts.

## Phase 9 — Private beta release

Estimate: 1 week.

Deliverables:

- npm private/internal package or GitHub package release.
- macOS helper build instructions.
- Windows helper build instructions.
- Optional signed prebuilt helper artifacts.
- Clean-machine smoke checklist.

Acceptance:

- Install from package.
- Configure BYO model.
- Run doctor/read/write on macOS and Windows.
- Documentation is sufficient for internal testers.

## Timeline summary

- MVP alpha (`doctor + read + write + BYO model`): **3-4 weeks**.
- Full WeChat connector beta: **6-8 weeks**.
- Public open-source candidate: requires separate legal, security, signing, release, and community docs review.
