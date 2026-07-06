# `@usechat/core`

UseChat 的连接器核心。

计划职责：

- connector schema；
- helper protocol types；
- helper client abstraction；
- read/write 状态机；
- 本机 ledger；
- media action planning；
- outbound queue；
- trace 和 reasonCode。

这个包不应该依赖神念账号、服务端、relay、计费或 Agent adapters。
