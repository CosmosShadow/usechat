# BYO Model 配置

UseChat 独立模式不依赖 Shennian 云端 VLM。用户需要配置自己的 OpenAI-compatible 视觉模型 endpoint。

## UseChat 如何使用视觉大模型

UseChat 读取微信消息时，会让 Helper 截取当前可见微信窗口，并收集系统 OCR、布局候选和可见会话指纹等 hints。随后模型 provider 把截图和 hints 一起发送给视觉大模型，要求模型返回严格 JSON。Core 再对 JSON 做 schema 校验、消息归一化、排序、去重和 trace 记录。

因此，推荐选择支持图片输入、OpenAI-compatible Chat Completions、并且能稳定输出 JSON 的视觉模型。

## 推荐配置：阿里云百炼 / DashScope Qwen-VL

国内环境推荐先使用 `qwen-vl-plus`；如果对复杂窗口、图片、卡片和文件消息理解要求更高，可以改成 `qwen-vl-max`。

`model.baseUrl` 填兼容模式根地址，不要加 `/chat/completions`。

```bash
export DASHSCOPE_API_KEY="你的 DashScope API Key"

usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
usechat config set model.name qwen-vl-plus
usechat config set model.apiKeyEnv DASHSCOPE_API_KEY
usechat config set model.timeoutMs 60000
```

`model.apiKeyEnv` 是环境变量名，不是 API key 明文。UseChat 不会在配置、日志或 trace 中打印 API key。

## 其他 OpenAI-compatible 视觉模型

```bash
export USECHAT_MODEL_API_KEY="..."

usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name "你的视觉模型名"
usechat config set model.apiKeyEnv USECHAT_MODEL_API_KEY
usechat config set model.timeoutMs 60000
```

## 环境变量

macOS / Linux shell：

```bash
export DASHSCOPE_API_KEY="..."
```

Windows PowerShell：

```powershell
$env:DASHSCOPE_API_KEY="..."
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
