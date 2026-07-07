# License Review

UseChat 当前保持私有。公开开源前默认许可证候选为 MIT，但正式切换到公开许可证前需要确认 Shennian copy-out 代码、native helper、模型和二进制运行时资产的授权边界。

## 当前结论

- UseChat 自有 TypeScript / Swift / C# 源码来自 Shennian copy-out；公开前需由项目 owner 确认 Shennian 对这些代码拥有再授权权利。
- npm 包当前仍为 private；公开前再添加根 LICENSE 文件。
- Windows OCR 模型和运行时资产必须随 Third-party notices 一起分发。
- macOS / Windows helper 二进制 provenance 必须保留 sha256、构建脚本、helperVersion、protocolVersion 和签名状态。

## 第三方组件摘要

| 组件 | 用途 | 许可 / 来源 |
|---|---|---|
| PaddleOCR / PP-OCRv5 ONNX assets | Windows 本地 OCR 模型 | Apache-2.0；见 PaddleOCR LICENSE。 |
| RapidOcrNet | Windows OCR wrapper | GitHub / NuGet 包；基于 RapidOCR / PaddleOCR ONNX 模型路线，公开前归档对应 NuGet license。 |
| ONNX Runtime | Windows OCR 推理 runtime DLL | MIT；见 Microsoft ONNX Runtime LICENSE。 |
| SkiaSharp.NativeAssets.Win32 | Windows 图像处理 native assets | MIT；见 SkiaSharp / NuGet package license。 |
| .NET self-contained runtime DLL | Windows helper runtime | Microsoft .NET runtime notice，随 publish 输出归档。 |

参考来源：

- PaddleOCR LICENSE: https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE
- Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0
- ONNX Runtime LICENSE: https://github.com/microsoft/onnxruntime/blob/main/LICENSE
- ONNX Runtime project license summary: https://github.com/microsoft/onnxruntime
- SkiaSharp.NativeAssets.Win32 NuGet: https://www.nuget.org/packages/SkiaSharp.NativeAssets.Win32/
- RapidOcrNet repository: https://github.com/BobLd/RapidOcrNet

## Gate 状态

- 私有 release：通过，license 风险以 private + notice + provenance 管控。
- 公开 release：需要 owner 做最终法律确认后再把根 LICENSE 从“暂不公开”切到选定许可证。
