# 第三方组件说明

UseChat 当前是私有正式项目。微信连接器能力来自 Shennian copy-out；native helper runtime 发布时会携带若干第三方运行时和模型资产，必须在 release evidence 中记录来源、版本、license 和 sha256。

## Windows helper runtime

Windows helper 源码位于 `native/windows/`，使用 .NET 和 NuGet 依赖：

| 组件 | 用途 | 当前来源 / 版本 | License 处理 |
|---|---|---|---|
| RapidOcrNet | 本地 OCR wrapper | `RapidOcrNet` NuGet `2.0.0` | release 前确认 NuGet license 并归档。 |
| SkiaSharp.NativeAssets.Win32 | OCR / 图像 native assets | `SkiaSharp.NativeAssets.Win32` NuGet `3.119.1` | release 前归档 license。 |
| System.Management | Windows 管理 API | `System.Management` NuGet `9.0.6` | Microsoft/.NET notice。 |
| ONNX Runtime DLL | OCR 推理运行时 | 随 Windows helper publish/runtime assets 生成或从 Shennian runtime assets copy-out | release 前归档 Microsoft ONNX Runtime notice。 |
| WPF / .NET self-contained native DLL | Windows UI / self-contained runtime | `dotnet publish` 输出 | release evidence 记录文件清单和 sha256。 |

Windows OCR 模型路线保持 Shennian 已确定方案：`RapidOcrNet + PP-OCRv5 + ONNX Runtime/.NET`。模型 manifest 来源于 Shennian helper runtime assets，包含：

- `ch_PP-OCRv5_mobile_det.onnx`
- `ch_ppocr_mobile_v2.0_cls_infer.onnx`
- `ch_PP-OCRv5_rec_mobile.onnx`
- `ppocrv5_dict.txt`
- `latin_PP-OCRv5_rec_mobile_infer.onnx`
- `ppocrv5_latin_dict.txt`

模型 manifest 标记 license 为 Apache-2.0，并记录 PaddleOCR / RapidOcrNet-compatible PP-OCRv5 ONNX assets、source URLs 和每个文件的 sha256。UseChat release 不得把 Windows OCR 替换成云 OCR 或另一套 OCR 实现。

## macOS helper runtime

macOS helper 源码位于 `native/macos/`，使用系统能力：

- Apple Vision / OCR；
- Accessibility；
- ScreenCapture / screenshot；
- Apple Events；
- keyboard / mouse / clipboard automation。

macOS release evidence 需要记录：

- helper executable sha256；
- manifest sha256；
- codesign verify 结果；
- notarization / Gatekeeper assessment 结果。

## 当前状态

- [x] Phase 1 未把第三方二进制直接塞进 npm 包。
- [x] Release 文档已要求 helper runtime 单独生成 evidence。
- [ ] 私有 Windows runtime artifact 发布前，补齐 NuGet / ONNX Runtime / PP-OCRv5 的完整 license 文本或链接归档。
- [ ] 公开开源前完成正式 license review。
