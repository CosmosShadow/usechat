# UseChat SDK

Embeddable TypeScript API for apps and agents.

Planned API:

```ts
import { createUseChat } from '@shennian/usechat-sdk'

const usechat = createUseChat()
await usechat.doctor()
await usechat.read({ app: 'wechat', chat: 'ABC' })
await usechat.write({ app: 'wechat', chat: 'ABC', text: 'hello' })
```
