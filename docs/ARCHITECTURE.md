# UseChat Architecture

## One-line architecture

```text
Agent / human CLI
  -> UseChat CLI / SDK / tool server
  -> connector core
  -> model provider + native helper protocol
  -> visible local messaging app
```

UseChat keeps business state in TypeScript and platform capabilities in native helpers.

## Layers

| Layer | Responsibility | Should not do |
|------|----------------|---------------|
| CLI | commands, config, output, confirmation, setup entry | native UI automation details |
| SDK | embeddable API for external apps / agents | own global state unexpectedly |
| Core | connector state machine, schema, ledger, media plan, outbound queue, trace | platform-specific APIs, model secrets |
| Model provider | OpenAI-compatible VLM calls, prompts, JSON schema normalization | account/billing logic, UI automation |
| Helper protocol | JSON-RPC command contract, reason codes, capabilities | product/session semantics |
| Native helper | window, screenshot, OCR, input, clipboard, file materialization, activity detection | model calls, ledger, dedupe, agent routing |
| Helper runtime | packaging, manifest, install, upgrade, signing evidence | hidden postinstall side effects |

## WeChat first release flow

```text
read(chat)
  -> doctor/preflight
  -> helper.ensureReady
  -> helper.search/open conversation
  -> helper.captureAndOcr or capture + OCR hints
  -> model.structureVisibleWindow
  -> normalize / validate
  -> output markdown/json
```

```text
write(chat, text)
  -> doctor/preflight
  -> confirm unless --yes
  -> helper.ensureReady
  -> helper.search/open conversation
  -> clipboard snapshot
  -> set text
  -> paste and submit
  -> restore clipboard
  -> report status
```

## Standalone mode vs platform mode

### Standalone mode

Standalone mode is the first target.

- No Shennian account.
- No Shennian machine token.
- No Shennian server relay.
- BYO model provider.
- Local config under `~/.usechat`.
- Local attachments and trace under `~/.usechat`.

### Platform mode

Platform mode is future work.

- Shennian or another agent platform can embed UseChat.
- The platform can provide identity, cloud sync, audit, remote confirmation, team controls, or managed model routing.
- UseChat core should remain usable without that platform.

## Native helper compatibility

The first formal release keeps the existing helper protocol compatible with the current Shennian helper. This avoids simultaneous changes in JS state machine and native automation.

Rules:

- Do not rename helper commands during the first formal release.
- Do not change response shapes unless additive.
- Keep stable reason codes.
- Keep helper as a capability runtime, not a business daemon.
- All UI-affecting commands are serialized.

## Local data ownership

Default local root:

```text
~/.usechat/
  config.json
  logs/
  traces/
  ledger/
  attachments/
    inbound/
    outbound/
  helper/
```

No raw screenshots, OCR full text, or clipboard contents should be stored by default. Diagnostic export must be an explicit user action.

## Model provider contract

Core only depends on a provider interface:

```ts
interface VisionModelProvider {
  structureVisibleWindow(input: StructureVisibleWindowInput): Promise<StructureVisibleWindowResult>
  classifyWindow?(input: ClassifyWindowInput): Promise<ClassifyWindowResult>
}
```

First implementation: OpenAI-compatible chat completions style vision endpoint.

## Connector interface

Initial TypeScript shape:

```ts
interface MessagingConnector {
  doctor(): Promise<DoctorResult>
  read(input: ReadInput): Promise<ReadResult>
  write(input: WriteInput): Promise<WriteResult>
  watch?(input: WatchInput): AsyncIterable<ConnectorEvent>
}
```

WeChat is the first implementation. The interface should not hardcode WeChat-only concepts unless the concept is genuinely connector-specific.
