# 第三方组件说明

UseChat Phase 1 暂未复制 Shennian helper runtime 中的预编译 Windows native DLL、ONNX Runtime DLL、OCR 模型或发布 zip，只复制源码、脚本和 manifest fixture。

后续如果在本仓库分发 helper runtime artifact，需要在这里补齐对应第三方组件的 license、source notice 和版本信息。

## 计划覆盖的组件类别

- Windows .NET self-contained runtime 相关文件。
- ONNX Runtime 相关 DLL。
- SkiaSharp / WPF native 相关 DLL。
- PP-OCR / OCR 模型文件。
- macOS helper app 打包和签名相关说明。

## 当前状态

- [x] Phase 1 未复制第三方二进制 runtime artifact。
- [ ] 后续复制或发布二进制 artifact 前补齐完整 notice。
