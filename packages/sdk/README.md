# UseChat SDK

给应用和 Agent 嵌入的 TypeScript API。

计划 API：

```ts
import { createUseChat } from '@shennian/usechat-sdk'

const usechat = createUseChat()
await usechat.doctor()
await usechat.read({ app: 'wechat', chat: 'ABC' })
await usechat.write({ app: 'wechat', chat: 'ABC', text: 'hello' })
```
