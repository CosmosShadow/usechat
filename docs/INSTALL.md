# 安装与首次配置

UseChat 安装分两步：先安装公开 npm JS 包，再由用户显式安装 native Helper runtime。UseChat 不会在 npm `postinstall` 阶段静默安装或下载 GUI helper。

## 1. 安装 CLI package

从 npm 安装：

```bash
npm install -g @shennian/usechat
usechat --version
```

本地 tarball 验证：

```bash
npm install -g ./dist/release/packages/shennian-usechat-core-0.1.0.tgz \
  ./dist/release/packages/shennian-usechat-model-provider-0.1.0.tgz \
  ./dist/release/packages/shennian-usechat-sdk-0.1.0.tgz \
  ./dist/release/packages/shennian-usechat-0.1.0.tgz
```

## 2. 安装 Helper runtime

Helper runtime 不随 npm 包分发。正式发布时从 GitHub Releases 下载 `UseChat-Helper-Runtime-<platform>.zip`；源码用户也可以在本仓库运行 `pnpm helper-runtime:build` 自行构建。当前 CLI 支持显式 `--from` 安装，后续会补 `setup-helper --download` 从 release manifest 下载。

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

## 3. 配置视觉大模型

UseChat 通过视觉大模型理解微信窗口截图。国内环境推荐使用阿里云百炼 / DashScope 的 `qwen3.5-flash`，并把 API key 留在环境变量里：

```bash
export DASHSCOPE_API_KEY="你的 DashScope API Key"

usechat init
usechat config set model.provider openai-compatible
usechat config set model.baseUrl https://dashscope.aliyuncs.com/compatible-mode/v1
usechat config set model.name qwen3.5-flash
usechat config set model.apiKeyEnv DASHSCOPE_API_KEY
usechat config set model.timeoutMs 60000
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
