# UseChat TODO

> Status: private execution checklist.
>
> Goal: build UseChat as an independent, local-first computer-use runtime for messaging agents. First connector: WeChat Desktop.

## Ground rules

- [ ] Do not modify the existing Shennian repository during Phase 0-4; use copy-out only.
- [ ] Keep native helper behavior compatible during MVP; do not redesign helper protocol yet.
- [ ] Keep standalone mode independent from Shennian Cloud; users configure their own OpenAI-compatible vision model.
- [ ] Do not install native helper silently during npm `postinstall`; helper setup must be explicit.
- [ ] Keep the project private until license, compliance, signing, security, and release docs are reviewed.
- [ ] Do not print `.env`, API keys, tokens, raw clipboard content, or full screenshots in logs or CLI output.

## Target product checklist

- [ ] Package can be installed as `@shennian/usechat` or an internal equivalent.
- [ ] CLI binary is `usechat`.
- [ ] `usechat init` works.
- [ ] `usechat doctor` works.
- [ ] `usechat read --app wechat --chat "ABC" --format markdown` works.
- [ ] `usechat write --app wechat --chat "ABC" --text "hello" --yes` works.

## Phase 0 — Project charter and scaffold

Estimate: 0.5-1 day.

- [x] Create private repository / project directory.
- [x] Add private root `package.json`.
- [x] Add pnpm workspace file.
- [x] Add root TypeScript base config placeholder.
- [x] Add `.gitignore`.
- [x] Add README with positioning and non-goals.
- [x] Add architecture document.
- [x] Add helper runtime document.
- [x] Add security and compliance notes.
- [x] Reserve monorepo layout:
  - [x] `packages/core`
  - [x] `packages/cli`
  - [x] `packages/sdk`
  - [x] `packages/model-provider`
  - [x] `native/macos`
  - [x] `native/windows`
  - [x] `helper-runtime`
  - [x] `examples`
- [x] Create initial git commit.
- [x] Verify Shennian repository has no changes.

Acceptance:

- [x] `package.json` is private.
- [x] No Shennian file is modified.
- [x] Project direction is understandable from README + TODO.

## Phase 1 — Copy-out source inventory

Estimate: 1-2 days.

### Source copy-out

- [ ] Copy helper protocol types into `packages/core`.
- [ ] Copy helper client transport into `packages/core`.
- [ ] Copy helper asset / runtime resolver logic into `packages/core` or `helper-runtime`.
- [ ] Copy macOS Swift helper source into `native/macos`.
- [ ] Copy Windows C# helper source into `native/windows`.
- [ ] Copy macOS helper build script into `native/macos` or `helper-runtime`.
- [ ] Copy Windows helper build script into `native/windows` or `helper-runtime`.
- [ ] Copy helper runtime packaging scripts into `helper-runtime`.
- [ ] Copy helper manifest schema fixtures into `helper-runtime`.
- [ ] Keep helper command names unchanged.
- [ ] Keep helper response shapes unchanged except additive fields.

### Attribution and notices

- [ ] Add `NOTICE.md` with copied-source attribution.
- [ ] Add third-party notice placeholder for Windows native DLLs and OCR models.
- [ ] Add license decision note; default private for now.
- [ ] Record Shennian source snapshot commit / path in copy-out notes.

Acceptance:

- [ ] Repository contains auditable helper source.
- [ ] No behavior change yet.
- [ ] Helper source can be diffed against the Shennian source snapshot.
- [ ] No Shennian repository file is modified.

## Phase 2 — CLI and local config

Estimate: 2-3 days.

### Package setup

- [ ] Create `packages/cli/package.json`.
- [ ] Create `packages/core/package.json`.
- [ ] Create `packages/model-provider/package.json`.
- [ ] Create `packages/sdk/package.json`.
- [ ] Add build scripts.
- [ ] Add typecheck scripts.
- [ ] Add test runner.

### CLI basics

- [ ] Implement `usechat --version`.
- [ ] Implement `usechat --help`.
- [ ] Implement `usechat init`.
- [ ] Implement `usechat config get [key]`.
- [ ] Implement `usechat config set <key> <value>`.
- [ ] Implement `usechat config list`.

### Config schema

- [ ] Config root defaults to `~/.usechat/config.json`.
- [ ] Support `model.provider`.
- [ ] Support `model.baseUrl`.
- [ ] Support `model.name`.
- [ ] Support `model.apiKeyEnv`.
- [ ] Support optional `model.timeoutMs`.
- [ ] Support `helper.path` override.
- [ ] Support `output.defaultFormat`.
- [ ] Support `wechat.sendRequiresConfirm`.
- [ ] Support `dataDir`.
- [ ] Validate config and show actionable errors.

### Secret handling

- [ ] Prefer `apiKeyEnv` over raw API key.
- [ ] Never print API key values.
- [ ] Redact secret-like values in JSON output.

Acceptance:

- [ ] CLI can run without Shennian account, machine token, or daemon.
- [ ] Config never prints API keys.
- [ ] Config prefers `apiKeyEnv` over raw key storage.
- [ ] `pnpm test` or equivalent passes.

## Phase 3 — Helper runtime discovery and doctor

Estimate: 3-5 days.

### Helper resolver

- [ ] Support explicit `USECHAT_HELPER_DIR`.
- [ ] Support config `helper.path`.
- [ ] Detect existing installed Shennian Helper runtime.
- [ ] Detect locally built UseChat helper runtime.
- [ ] Reserve future official UseChat helper install path.
- [ ] Validate helper manifest.
- [ ] Validate helper executable existence.
- [ ] Validate helper version.
- [ ] Validate protocol version.
- [ ] Validate required capabilities.

### Doctor command

- [ ] Implement `usechat doctor` human output.
- [ ] Implement `usechat doctor --json` machine output.
- [ ] Check platform support.
- [ ] Check helper presence.
- [ ] Check helper health.
- [ ] Check helper version and protocol.
- [ ] Check required capabilities.
- [ ] Check macOS permissions.
- [ ] Check Windows visible desktop conditions.
- [ ] Check WeChat process.
- [ ] Check visible WeChat window.
- [ ] Check model configuration.
- [ ] Return stable reason codes.

### Reason codes

- [ ] `unsupported_platform`.
- [ ] `helper_missing`.
- [ ] `helper_manifest_missing`.
- [ ] `helper_invalid_manifest`.
- [ ] `helper_version_mismatch`.
- [ ] `helper_protocol_mismatch`.
- [ ] `helper_capability_missing`.
- [ ] `permission_missing`.
- [ ] `wechat_not_running`.
- [ ] `wechat_window_not_found`.
- [ ] `model_not_configured`.

Acceptance:

- [ ] Doctor returns stable JSON with reason codes.
- [ ] Doctor has human-readable output.
- [ ] Missing helper points to explicit setup instructions, not npm postinstall magic.
- [ ] Doctor performs no dangerous UI action.

## Phase 4 — Bring-your-own model provider

Estimate: 3-5 days.

### Provider interface

- [ ] Define `VisionModelProvider` interface.
- [ ] Define `structureVisibleWindow` input schema.
- [ ] Define `structureVisibleWindow` output schema.
- [ ] Define optional `classifyWindow` input/output schema.
- [ ] Normalize provider errors to stable reason codes.

### OpenAI-compatible provider

- [ ] Implement Chat Completions-compatible request.
- [ ] Support `model.baseUrl`.
- [ ] Support `model.name`.
- [ ] Read API key from `model.apiKeyEnv`.
- [ ] Support timeout.
- [ ] Support JSON response parsing.
- [ ] Strip markdown JSON fences.
- [ ] Validate returned JSON.
- [ ] Normalize visible messages.

### Prompts and schemas

- [ ] Add visible-window message structuring prompt.
- [ ] Add window classifier prompt if needed.
- [ ] Add schema tests for text message.
- [ ] Add schema tests for image message.
- [ ] Add schema tests for file message.
- [ ] Add schema tests for video-file vs video-card distinction.
- [ ] Add tests for invalid JSON.
- [ ] Add tests for empty model response.

### Reason codes

- [ ] `model_not_configured`.
- [ ] `model_request_failed`.
- [ ] `model_invalid_json`.
- [ ] `model_no_messages`.
- [ ] `model_timeout`.

Acceptance:

- [ ] No server-side Shennian VLM call is required.
- [ ] User can point UseChat at OpenAI, DashScope-compatible endpoints, or another OpenAI-compatible provider.
- [ ] Prompt and schema live in this repository.
- [ ] Unit tests cover success and failure cases.

## Phase 5 — WeChat read MVP

Estimate: 4-7 days.

### Command

- [ ] Implement `usechat read --app wechat --chat <name>`.
- [ ] Support `--limit <n>`.
- [ ] Support `--format markdown`.
- [ ] Support `--format json`.
- [ ] Support `--download never` for MVP.
- [ ] Add readable failure output.
- [ ] Add JSON failure output.

### Runtime flow

- [ ] Run preflight before UI actions.
- [ ] Ensure WeChat window is ready.
- [ ] Open conversation by search.
- [ ] Confirm target conversation title when possible.
- [ ] Capture visible window.
- [ ] Collect OCR/layout hints when available.
- [ ] Call model provider.
- [ ] Normalize messages.
- [ ] Validate message order and bbox sanity.
- [ ] Slice to `--limit`.
- [ ] Output Markdown.
- [ ] Output JSON.

### Tests and smoke

- [ ] Unit test read output formatting.
- [ ] Unit test model-to-message normalization.
- [ ] Mock helper read flow test.
- [ ] macOS smoke: read `文件传输助手`.
- [ ] Windows smoke: read one known conversation.

Acceptance:

- [ ] `usechat read --app wechat --chat "文件传输助手"` works on macOS.
- [ ] Windows read smoke passes or produces a documented platform blocker.
- [ ] Failure does not click or type dangerous input after failed preflight.
- [ ] No raw screenshot is saved by default.

## Phase 6 — WeChat write MVP

Estimate: 3-5 days.

### Command

- [ ] Implement `usechat write --app wechat --chat <name> --text <text>`.
- [ ] Prompt for confirmation by default.
- [ ] Support `--yes` for non-interactive agent usage.
- [ ] Support `--json` output.
- [ ] Support `--dry-run`.

### Runtime flow

- [ ] Run preflight before UI actions.
- [ ] Ensure WeChat window is ready.
- [ ] Open conversation by search.
- [ ] Confirm target conversation title when possible.
- [ ] Snapshot clipboard.
- [ ] Set clipboard text.
- [ ] Paste into message input.
- [ ] Submit message.
- [ ] Restore clipboard.
- [ ] Return send status.
- [ ] Do not automatically resend after unknown status.

### Tests and smoke

- [ ] Unit test confirmation behavior.
- [ ] Unit test `--yes` behavior.
- [ ] Unit test dry run.
- [ ] Mock helper write flow test.
- [ ] macOS smoke: write to `文件传输助手`.
- [ ] Windows smoke: write to one known conversation.

Acceptance:

- [ ] Text write works on macOS.
- [ ] Windows write smoke passes or produces a documented platform blocker.
- [ ] No automatic resend after crash or unknown status.
- [ ] Clipboard restore failure is warning-only and does not trigger resend.

## Phase 7 — Full connector capabilities

Estimate: 1-2 weeks after MVP.

### Attachments outbound

- [ ] Support `usechat write --file <path>`.
- [ ] Support `usechat write --image <path>`.
- [ ] Support `usechat write --video <path>`.
- [ ] Validate local file existence.
- [ ] Validate file size limits.
- [ ] Use clipboard file operations.
- [ ] Restore clipboard after sending.

### Media inbound

- [ ] Identify visible media candidates.
- [ ] Build media action plan.
- [ ] Right-click media bbox.
- [ ] OCR menu candidate selection.
- [ ] Read clipboard file URLs / bitmap.
- [ ] Materialize local original files where possible.
- [ ] Store inbound attachments under `~/.usechat/attachments/inbound/`.
- [ ] Distinguish original file vs preview crop.
- [ ] Return `pending-download` / `metadata-only` instead of fake success.

### Ledger and dedupe

- [ ] Implement local ledger under `~/.usechat/ledger/`.
- [ ] Implement baseline scan.
- [ ] Implement dedupe.
- [ ] Implement local echo suppression.
- [ ] Implement recent window retention.

### Trace

- [ ] Emit trace summary JSON.
- [ ] Emit JSONL trace events.
- [ ] Redact sensitive fields.
- [ ] Do not save raw screenshots by default.

Acceptance:

- [ ] Text, file, image, and video send smoke on macOS and Windows.
- [ ] File/video success requires real local original file, not preview crop.
- [ ] Local ledger avoids duplicate read events in repeated runs.
- [ ] Trace can diagnose phase failures without leaking content by default.

## Phase 8 — Agent interface

Estimate: 1 week.

### Watch mode

- [ ] Implement `usechat watch --app wechat --chat <name> --emit jsonl`.
- [ ] Emit initial baseline event.
- [ ] Emit new message events.
- [ ] Emit error / paused events.
- [ ] Support poll interval config.
- [ ] Support graceful shutdown.

### Tool server

- [ ] Design `usechat serve --stdio` protocol.
- [ ] Implement `doctor` tool.
- [ ] Implement `read` tool.
- [ ] Implement `write` tool.
- [ ] Return stable JSON contracts.
- [ ] Document future MCP-compatible mapping.

### Agent docs

- [ ] Add Codex usage instructions.
- [ ] Add Claude Code usage instructions.
- [ ] Add Cursor / OpenCode usage notes.
- [ ] Add custom agent JSON examples.

Acceptance:

- [ ] External agent can call read/write through CLI.
- [ ] Programmatic mode has stable JSON contracts.
- [ ] Human confirmation policy is documented for agents.

## Phase 9 — Private beta release

Estimate: 1 week.

### Packaging

- [ ] Decide internal package registry / GitHub package path.
- [ ] Build CLI package.
- [ ] Build SDK package if ready.
- [ ] Build model-provider package if separate.
- [ ] Generate package provenance notes.

### Helper artifacts

- [ ] Add macOS helper build instructions.
- [ ] Add Windows helper build instructions.
- [ ] Build macOS helper runtime.
- [ ] Build Windows helper runtime.
- [ ] Optionally sign macOS helper.
- [ ] Optionally sign Windows helper.
- [ ] Generate helper runtime manifests.
- [ ] Generate helper runtime evidence.

### Private beta checks

- [ ] Clean-machine macOS install.
- [ ] Clean-machine macOS doctor.
- [ ] Clean-machine macOS read.
- [ ] Clean-machine macOS write.
- [ ] Clean-machine Windows install.
- [ ] Clean-machine Windows doctor.
- [ ] Clean-machine Windows read.
- [ ] Clean-machine Windows write.
- [ ] BYO model setup docs verified.
- [ ] Troubleshooting docs verified.

Acceptance:

- [ ] Install from package.
- [ ] Configure BYO model.
- [ ] Run doctor/read/write on macOS and Windows.
- [ ] Documentation is sufficient for internal testers.

## Release gates before public open source

- [ ] License review.
- [ ] Third-party notices complete.
- [ ] Helper source and binary provenance documented.
- [ ] macOS signing / notarization plan decided.
- [ ] Windows signing / SmartScreen plan decided.
- [ ] Security review for helper install / zip extraction.
- [ ] Compliance wording reviewed.
- [ ] No anti-ban / bulk / marketing claims in docs.
- [ ] Public README rewritten for external users.
- [ ] Contribution and issue templates created.
- [ ] Responsible disclosure policy added.

## Timeline summary

- [ ] MVP alpha (`doctor + read + write + BYO model`): target **3-4 weeks**.
- [ ] Full WeChat connector beta: target **6-8 weeks**.
- [ ] Public open-source candidate: requires separate legal, security, signing, release, and community docs review.
