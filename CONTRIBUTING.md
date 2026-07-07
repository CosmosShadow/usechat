# 贡献指南

UseChat 当前是私有正式项目。公开贡献流程会在 license、签名、第三方 notices 和安全评审完成后开放。

## 基本规则

- 不要从零重新实现微信 RPA。除非单独通过设计评审，微信连接器行为必须能追溯到 Shennian copy-out 来源。
- 不添加协议逆向、客户端注入、数据库读取、批量营销或规避检测能力。
- 不记录 API key、token、`.env` 内容、原始截图、完整 OCR 文本或剪贴板内容。
- 行为变更必须补测试。
- 架构或 release 行为变化时同步更新文档。

## 本地开发

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm helper-runtime:validate
```
