// @covers ../wechat/format.ts

import { describe, expect, it } from 'vitest'
import { applyMessageLimit, formatWeChatMessagesMarkdown } from '../wechat/format.js'

describe('wechat message formatting', () => {
  it('formats markdown', () => {
    expect(formatWeChatMessagesMarkdown([
      { stableMessageKey: '1', senderRole: 'self', kind: 'text', normalizedText: 'hello' },
      { stableMessageKey: '2', senderRole: 'contact', senderName: 'ABC', kind: 'image' },
    ])).toBe('我: hello\nABC: [图片]\n')
  })

  it('applies tail limit', () => {
    expect(applyMessageLimit([
      { stableMessageKey: '1', senderRole: 'self', kind: 'text' },
      { stableMessageKey: '2', senderRole: 'self', kind: 'text' },
    ], 1).map((item) => item.stableMessageKey)).toEqual(['2'])
  })
})
