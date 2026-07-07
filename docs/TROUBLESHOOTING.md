# Troubleshooting

## `model_not_configured`

检查：

```bash
usechat config list
```

至少需要：

```bash
usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY
```

确认环境变量存在，但不要把 key 打印到日志里。

## `helper_runtime_required` / `helper_missing`

显式安装 helper runtime：

```bash
usechat setup-helper --from ./UseChat-Helper-Runtime-macos.zip --force
usechat doctor --json
```

也可以临时指定 helper 路径：

```bash
usechat config set helper.path /path/to/wechat-channel/macos
```

## macOS 权限缺失

`doctor` 可能返回：

- `permission_missing`
- `permission-screen-recording`
- `permission-accessibility`
- `permission-input-monitoring`

到系统设置中给 `UseChat Helper.app` 或当前终端授予屏幕录制、辅助功能和输入监听权限。权限修改后通常需要重启 helper 或终端。

## Windows 可见桌面不可用

Windows 微信 UI 自动化必须运行在已登录、未锁屏、可见桌面会话中。通过 SSH 直接执行通常不能操作桌面窗口。

远程 smoke 使用：

```powershell
pnpm smoke:wechat:abc:windows-task
```

## `wechat_login_required`

微信桌面端停在重新登录、扫码或安全验证页面。UseChat 会 fail closed，不继续点击、粘贴或发送。请手动登录微信并确认目标会话可见，再重试。

## 附件发送返回 `sent-unconfirmed`

这表示 UseChat 已把文本或附件提交给微信输入/发送链路，但不做重复发送确认。不要在 unknown / unconfirmed 状态下自动重发，避免重复消息。

## Trace 调试

显式开启 JSONL trace：

```bash
usechat read --app wechat --chat "ABC" --format json --trace-jsonl
usechat write --app wechat --chat "ABC" --text "hello" --yes --json --trace-jsonl
```

Trace 默认脱敏，不保存原始截图、不打印 API key 或剪贴板全文。
