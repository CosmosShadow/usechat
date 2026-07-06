// @covers ../wechat/message-quality.ts

import { describe, expect, it } from 'vitest'
import { validateWeChatMessages } from '../wechat/message-quality.js'
import type { WeChatObservedMessage } from '../wechat/types.js'

describe('wechat message quality validation', () => {
  it('accepts monotonic in-window message bboxes', () => {
    const report = validateWeChatMessages({
      windowBounds: { width: 1200, height: 900 },
      messages: [
        message('a', 300),
        message('b', 360),
        message('c', 420),
      ],
    })

    expect(report.ok).toBe(true)
    expect(report.metrics).toMatchObject({
      messageCount: 3,
      comparableBboxCount: 3,
      invalidBboxCount: 0,
      outOfWindowBboxCount: 0,
      nonMonotonicPairCount: 0,
      duplicateKeyCount: 0,
    })
  })

  it('reports invalid, out-of-window, duplicate and non-monotonic bboxes', () => {
    const report = validateWeChatMessages({
      windowBounds: { width: 1200, height: 900 },
      messages: [
        message('dup', 500),
        message('dup', 420),
        { ...message('invalid', 600), bbox: { x: 10, y: 10, width: -1, height: 20 } },
        message('outside', 1500),
      ],
    })

    expect(report.ok).toBe(false)
    expect(report.metrics).toMatchObject({
      messageCount: 4,
      comparableBboxCount: 3,
      invalidBboxCount: 1,
      outOfWindowBboxCount: 1,
      nonMonotonicPairCount: 1,
      duplicateKeyCount: 1,
    })
    expect(report.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      'message_duplicate_key',
      'message_order_non_monotonic',
      'message_bbox_invalid',
      'message_bbox_out_of_window',
    ]))
  })
})

function message(key: string, y: number): WeChatObservedMessage {
  return {
    stableMessageKey: key,
    senderRole: 'contact',
    kind: 'text',
    normalizedText: key,
    bbox: { x: 520, y, width: 160, height: 36, coordinateSpace: 'screenshotPixel' },
  }
}
