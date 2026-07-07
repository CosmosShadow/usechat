// @covers ../wechat/message-key.ts

import { describe, expect, it } from 'vitest'
import {
  buildStableWeChatMessageKey,
  normalizeWeChatObservedWindowForLedger,
} from '../wechat/message-key.js'

describe('WeChat channel stable message key', () => {
  it('keeps explicit keys but enriches anchor metadata', () => {
    const [message] = normalizeWeChatObservedWindowForLedger([{
      stableMessageKey: 'explicit-key',
      senderRole: 'contact',
      kind: 'text',
      normalizedText: ' Hello ',
      bbox: { x: 11, y: 19, width: 101, height: 40 },
    }])

    expect(message.stableMessageKey).toBe('explicit-key')
    expect(message).toMatchObject({
      stableKeyVersion: 1,
      anchorText: ' Hello ',
      anchorMetadata: {
        stableKeyVersion: 1,
        windowIndex: 0,
        occurrence: 0,
        senderRole: 'contact',
        kind: 'text',
        anchorText: 'hello',
        bboxBand: '20,20,100,40',
      },
    })
  })

  it('generates stable keys for duplicate text using occurrence and context', () => {
    const messages = normalizeWeChatObservedWindowForLedger([
      { senderRole: 'contact', kind: 'text', normalizedText: '收到' },
      { senderRole: 'contact', kind: 'text', normalizedText: '收到' },
      { senderRole: 'contact', kind: 'text', normalizedText: '收到', neighborContext: { previousText: '上文' } },
    ])

    expect(messages.map((message) => message.stableMessageKey)).toHaveLength(3)
    expect(new Set(messages.map((message) => message.stableMessageKey)).size).toBe(3)
    expect(messages.every((message) => message.stableMessageKey.startsWith('wk1_'))).toBe(true)
  })

  it('includes visual media signature for media cards', () => {
    const keyA = buildStableWeChatMessageKey({
      senderRole: 'contact',
      kind: 'image',
      visualBlocks: [{ blockId: 'image-a', blockKind: 'image', model: 'test', dims: 2, vectorBase64: 'aa==' }],
    })
    const keyB = buildStableWeChatMessageKey({
      senderRole: 'contact',
      kind: 'image',
      visualBlocks: [{ blockId: 'image-b', blockKind: 'image', model: 'test', dims: 2, vectorBase64: 'aa==' }],
    })

    expect(keyA).not.toBe(keyB)
  })
})
