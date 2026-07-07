# Helper Runtime 打包

UseChat 的 helper runtime 目录负责把已经从 Shennian copy-out 的 native helper 源码和 runtime assets 打包成普通用户可安装的 helper 产物。

这里不重新实现微信 RPA。微信窗口、截图、OCR、点击、键盘、剪贴板和文件物化能力都来自 Shennian copy-out 的 helper 源码和脚本。

## 目录

```text
helper-runtime/
  scripts/native-helper/        # 从 Shennian copy-out 的 native helper 构建/签名脚本，已适配 UseChat 目录
  scripts/build-*.mjs           # runtime 打包、manifest、evidence 生成脚本
  wechat-channel/macos/         # macOS helper runtime assets 输入目录
  wechat-channel/windows/       # Windows helper runtime assets 输入目录
  dist/                         # 本地构建输出，不提交
```

Native 源码在：

```text
native/macos/
native/windows/
```

## 构建

macOS：

```bash
pnpm --dir helper-runtime build:native:mac
pnpm --dir helper-runtime validate
pnpm --dir helper-runtime build:mac
```

Windows：

```powershell
pnpm --dir helper-runtime build:native:win
pnpm --dir helper-runtime validate
pnpm --dir helper-runtime build:win
```

根目录快捷入口：

```bash
pnpm helper-runtime:build:native:mac
pnpm helper-runtime:build:mac
pnpm helper-runtime:build:native:win
pnpm helper-runtime:build:win
```

`pnpm helper-runtime:build` 会在当前平台尽力构建：macOS 本机会构建 macOS helper/runtime；Windows helper 需要在 Windows 构建机上运行，除非 CI 明确提供 Windows SDK toolchain 并设置 `WECHAT_CHANNEL_HELPER_ALLOW_CROSS_BUILD=1`。

## 安装原则

普通用户应通过显式命令安装 helper runtime：

```bash
usechat setup-helper
```

不得在 npm `postinstall` 阶段静默安装 GUI helper runtime。

## Release evidence

每次 runtime 打包会生成：

```text
helper-runtime-package.json
helper-runtime-evidence.json
```

其中记录 helper version、protocol version、manifest sha256、entrypoint sha256、签名/公证/Authenticode 状态和产物路径。

## 兼容说明

UseChat release 保持 helper protocol、helper command 和 response shape 兼容 Shennian copy-out 来源；对外 runtime identity 使用 `UseChat Helper.app` / `UseChat Helper`，resolver 保留历史 `Shennian Helper` fallback，避免已安装测试环境立刻失效。
