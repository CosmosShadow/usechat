# 安装与首次配置

UseChat 当前是私有正式项目。安装分两步：先安装 JS 包，再由用户显式安装 native Helper runtime。UseChat 不会在 npm `postinstall` 阶段静默安装 GUI helper。

## 1. 安装 CLI package

公开 npm 发布后：

```bash
npm install -g @shennian/usechat
usechat --version
```

本地私有 tarball 验证：

```bash
npm install -g ./dist/release/packages/shennian-usechat-core-0.1.0.tgz \
  ./dist/release/packages/shennian-usechat-model-provider-0.1.0.tgz \
  ./dist/release/packages/shennian-usechat-sdk-0.1.0.tgz \
  ./dist/release/packages/shennian-usechat-0.1.0.tgz
```

## 2. 安装 Helper runtime

从 release artifact 显式安装：

macOS：

```bash
usechat setup-helper --from ./helper-runtime/dist/macos/UseChat-Helper-Runtime-macos.zip --force
```

Windows：

```powershell
usechat setup-helper --from .\helper-runtime\dist\windows\UseChat-Helper-Runtime-windows.zip --force
```

默认安装位置：

- macOS：`~/Library/Application Support/UseChat/Helper/UseChat Helper.app`
- Windows：`%LOCALAPPDATA%\Programs\UseChat Helper`

也可以指定目标：

```bash
usechat setup-helper --from ./UseChat-Helper-Runtime-macos.zip --target /path/to/UseChat\ Helper.app --force
```

## 3. 配置模型

推荐使用 OpenAI-compatible endpoint，并把 API key 留在环境变量里：

```bash
usechat init
usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://api.openai.com/v1
usechat config set model.name gpt-4.1-mini
usechat config set model.apiKeyEnv OPENAI_API_KEY
```

本地 smoke 可使用 `ocr-only` provider：

```bash
usechat config set model.provider ocr-only
```

## 4. 验证

```bash
usechat doctor --json
usechat read --app wechat --chat "ABC" --format json --download never
usechat write --app wechat --chat "ABC" --text "UseChat release smoke" --yes --json
```

Windows 远程验证必须在已登录的可见桌面会话中运行；SSH Session 0 不能可靠操作微信窗口。仓库内 smoke 使用交互式计划任务：

```powershell
pnpm smoke:wechat:abc:windows-task
```
