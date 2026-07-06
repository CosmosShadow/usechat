# macOS Helper

这里会放从当前 Shennian helper 实现 copy-out 的 macOS Swift helper 源码。

首个正式版本策略：

- 保持 helper protocol 兼容；
- 第一次 copy-out 不重新设计权限或 IPC；
- 支持开发者自编译；
- 后续为普通用户提供签名预编译 helper runtime。
