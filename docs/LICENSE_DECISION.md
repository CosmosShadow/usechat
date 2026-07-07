# License 决策记录

UseChat 的公开发布默认采用源码开放、运行时 artifact 独立分发的模式。

## 当前决定

- npm 包公开发布在 `@shennian/*` scope。
- Helper 源码随仓库提供，便于审计和自编译。
- 大型 Helper runtime zip、Windows DLL、ONNX Runtime 和 PP-OCRv5 模型作为 release artifact 分发，不进入 npm 包，也不建议进入 git 历史。
- 根许可证在正式公开仓库前由 owner 做最终确认；默认候选为 MIT。

## 公开仓库前需要确认

- Shennian copy-out 代码的再授权边界。
- native helper 源码和预编译 artifact 的分发协议。
- 第三方组件 notice 和 license 链接完整性。
- 安全、合规和品牌文案最终评审。
