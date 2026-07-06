# Security and Compliance Notes

This document is not legal advice. It records product and engineering boundaries for UseChat.

## Positioning

UseChat is a local computer-use tool. It operates the user's own visible desktop messaging app on the user's own computer after explicit authorization.

Do say:

- local-first;
- visible computer use;
- user-authorized;
- personal assistant;
- agent uses your own desktop app.

Do not say:

- anti-ban;
- bypass detection;
- bulk messaging;
- group control;
- marketing automation;
- unlimited accounts;
- protocol cracking.

## Hard technical boundaries

- No protocol reverse engineering.
- No process injection.
- No client patching.
- No local database scraping.
- No cache scanning to infer messages or attachments.
- No hidden background sending without user policy.
- No storing API keys in logs.
- No printing raw secrets in CLI output.

## Privacy defaults

- Screenshots are used for the current model call and not saved by default.
- Clipboard content is not logged.
- OCR full text is not logged by default.
- Attachments stay local unless a user or embedding platform explicitly transfers them.
- Diagnostic export is explicit and should support redaction.

## Sending policy

The default CLI behavior should confirm destination and content before sending. Non-interactive usage must opt in with `--yes` or an explicit policy.

If the window, chat title, input box, clipboard, or user activity status is uncertain, UseChat must fail closed.
