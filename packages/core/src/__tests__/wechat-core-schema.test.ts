// @covers ../wechat/core/schema.ts

import { describe, expect, it } from 'vitest'
import {
  isWeChatChannelAttachmentAvailability,
  isWeChatChannelMessageKind,
  isWeChatChannelTracePhase,
  normalizeWeChatChannelAttachmentAvailability,
  normalizeWeChatChannelMessageKind,
  type WeChatChannelMediaActionPlan,
  type WeChatChannelTraceEvent,
} from '../wechat/core/schema.js'

describe('WeChat channel core schema', () => {
  it('normalizes product message kind aliases to the stable vocabulary', () => {
    expect(normalizeWeChatChannelMessageKind('video')).toBe('video-file')
    expect(normalizeWeChatChannelMessageKind('video_file')).toBe('video-file')
    expect(normalizeWeChatChannelMessageKind('photo')).toBe('image')
    expect(normalizeWeChatChannelMessageKind('emoji')).toBe('text')
    expect(normalizeWeChatChannelMessageKind('document')).toBe('file')
    expect(normalizeWeChatChannelMessageKind('link')).toBe('link-card')
    expect(normalizeWeChatChannelMessageKind('mini program')).toBe('mini-program-card')
    expect(normalizeWeChatChannelMessageKind('unknown-kind')).toBe('unknown')
    expect(isWeChatChannelMessageKind('video-card')).toBe(true)
    expect(isWeChatChannelMessageKind('server-url')).toBe(false)
  })

  it('normalizes attachment availability aliases to the local-first vocabulary', () => {
    expect(normalizeWeChatChannelAttachmentAvailability('downloaded')).toBe('edge-local')
    expect(normalizeWeChatChannelAttachmentAvailability('edge_preview')).toBe('edge-preview')
    expect(normalizeWeChatChannelAttachmentAvailability('not_downloaded')).toBe('pending-download')
    expect(normalizeWeChatChannelAttachmentAvailability('metadata')).toBe('metadata-only')
    expect(normalizeWeChatChannelAttachmentAvailability('unavailable-large')).toBe('failed')
    expect(isWeChatChannelAttachmentAvailability('server-url')).toBe(false)
  })

  it('defines typed action plans and trace phases for later planner reuse', () => {
    const plan: WeChatChannelMediaActionPlan = {
      messageKey: 'm1',
      kind: 'image',
      reasonCode: 'image_copy_plan',
      actions: [
        { type: 'right-click-media', target: { x: 1, y: 2, width: 3, height: 4 } },
        { type: 'ocr-click-menu-item', label: '复制图片' },
        { type: 'materialize-clipboard' },
      ],
    }
    const event: WeChatChannelTraceEvent = {
      traceId: 'trace1',
      phase: 'media_plan',
      status: 'ok',
      outputHash: 'sha256:abc',
    }

    expect(plan.actions.map((action) => action.type)).toEqual([
      'right-click-media',
      'ocr-click-menu-item',
      'materialize-clipboard',
    ])
    expect(isWeChatChannelTracePhase(event.phase)).toBe(true)
    expect(isWeChatChannelTracePhase('server_diff')).toBe(false)
  })
})
