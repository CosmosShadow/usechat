// @covers ../wechat/outbound-ledger.ts

import { describe, expect, it } from 'vitest'
import {
  classifyWeChatOutboundEchoes,
  enqueueWeChatOutboundReply,
  suppressSelfOnlyWeChatMessages,
  type WeChatChannelOutboundLedger,
} from '../wechat/outbound-ledger.js'

describe('WeChat outbound ledger', () => {
  it('dedupes queued replies by idempotency key and stores local attachment refs', () => {
    const ledger: WeChatChannelOutboundLedger = { version: 1, runtimeId: 'runtime1', records: [] }
    const first = enqueueWeChatOutboundReply({
      ledger,
      replyId: 'reply1',
      idempotencyKey: 'idem1',
      bindingId: 'binding1',
      runtimeId: 'runtime1',
      sessionId: 'session1',
      conversationName: 'ABC',
      replyBaseRevision: 0,
      text: '收到',
      attachmentLocalRefs: ['/tmp/brief.pdf'],
      now: new Date('2026-07-07T00:00:00.000Z'),
    })
    const second = enqueueWeChatOutboundReply({
      ledger,
      replyId: 'reply2',
      idempotencyKey: 'idem1',
      bindingId: 'binding1',
      runtimeId: 'runtime1',
      sessionId: 'session1',
      conversationName: 'ABC',
      replyBaseRevision: 0,
      text: '重复',
    })

    expect(second).toBe(first)
    expect(ledger.records).toHaveLength(1)
    expect(first).toMatchObject({
      text: '收到',
      textNormalized: '收到',
      attachmentLocalRefs: ['/tmp/brief.pdf'],
      sendStatus: 'queued',
    })
  })

  it('confirms self echoes and suppresses local echo messages', () => {
    const ledger: WeChatChannelOutboundLedger = { version: 1, runtimeId: 'runtime1', records: [] }
    enqueueWeChatOutboundReply({
      ledger,
      replyId: 'reply1',
      idempotencyKey: 'idem1',
      bindingId: 'binding1',
      runtimeId: 'runtime1',
      sessionId: 'session1',
      conversationName: 'ABC',
      replyBaseRevision: 0,
      text: 'UseChat marker',
      now: new Date('2026-07-07T00:00:00.000Z'),
    })
    ledger.records[0]!.sendStatus = 'sent_unconfirmed'
    ledger.records[0]!.sentAt = '2026-07-07T00:00:01.000Z'

    const result = classifyWeChatOutboundEchoes({
      ledger,
      bindingId: 'binding1',
      now: new Date('2026-07-07T00:00:02.000Z'),
      messages: [
        { stableMessageKey: 'self', senderRole: 'self', kind: 'text', anchorText: 'UseChat marker' },
        { stableMessageKey: 'contact', senderRole: 'contact', kind: 'text', anchorText: 'hello' },
      ],
    })

    expect(result.confirmedRecords).toHaveLength(1)
    expect(result.remainingMessages.map((message) => message.stableMessageKey)).toEqual(['contact'])
    expect(suppressSelfOnlyWeChatMessages([
      { stableMessageKey: 'self', senderRole: 'self', kind: 'text' },
      { stableMessageKey: 'contact', senderRole: 'contact', kind: 'text' },
    ]).map((message) => message.stableMessageKey)).toEqual(['contact'])
  })
})
