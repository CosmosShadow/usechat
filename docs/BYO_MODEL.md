# BYO Model 配置

UseChat 独立模式不依赖 Shennian 云端 VLM。用户需要配置自己的 OpenAI-compatible 视觉模型 endpoint。

## 配置项

```bash
usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY
usechat config set model.timeoutMs 60000
```

`model.apiKeyEnv` 是环境变量名，不是 API key 明文。UseChat 不会在配置、日志或 trace 中打印 API key。

## 环境变量

macOS / Linux shell：

```bash
export OPENAI_API_KEY="..."
```

Windows PowerShell：

```powershell
$env:OPENAI_API_KEY="..."
```

## 验证

```bash
usechat doctor --json
usechat read --app wechat --chat "ABC" --format json --limit 10
```

如果只是做本地 helper / OCR smoke，可以临时使用：

```bash
usechat config set model.provider ocr-only
```

`ocr-only` 只用于 smoke 和无云模型验证，不代表最终 VLM 效果。
