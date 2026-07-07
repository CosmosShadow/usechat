// @covers ../wechat/ledger.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadWeChatChannelLedger,
  markWeChatChannelBindingDisabled,
  saveWeChatChannelLedger,
  updateWeChatChannelBindingLedger,
} from '../wechat/ledger.js'

describe('WeChat channel local ledger', () => {
  it('establishes baseline without producing new messages, then diffs by stable key', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    const baseline = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{ stableMessageKey: 'a', senderRole: 'contact', kind: 'text' }],
    })
    expect(baseline.newMessages).toEqual([])
    expect(baseline.binding.baselineEstablished).toBe(true)

    const next = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'a', senderRole: 'contact', kind: 'text' },
        { stableMessageKey: 'b', senderRole: 'contact', kind: 'text' },
      ],
    })
    expect(next.newMessages.map((message) => message.stableMessageKey)).toEqual(['b'])
    expect(next.binding.revision).toBe(1)
  })


  it('uses anchor edit distance when stable keys drift and suppresses self-only changes', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old-contact', senderRole: 'contact', kind: 'text', anchorText: '今天晚上开会' },
        { stableMessageKey: 'old-self', senderRole: 'self', kind: 'text', anchorText: '好的' },
      ],
    })

    const next = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'new-contact-key', senderRole: 'contact', kind: 'text', anchorText: '今天晚上开会' },
        { stableMessageKey: 'new-self-key', senderRole: 'self', kind: 'text', anchorText: '好的' },
        { stableMessageKey: 'new-contact-message', senderRole: 'contact', kind: 'text', anchorText: '新增一句' },
      ],
    })

    expect(next.newMessages.map((message) => message.stableMessageKey)).toEqual(['new-contact-message'])
    expect(next.binding.revision).toBe(1)
  })

  it('keeps anchor-only and suppressed messages in recent state but never delivers them', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{ stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' }],
    })

    const next = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        { stableMessageKey: 'partial-anchor', senderRole: 'contact', kind: 'text', anchorText: '么。', isBaseline: true },
        { stableMessageKey: 'suppressed-anchor', senderRole: 'contact', kind: 'text', anchorText: '半截', deliveryStatus: 'suppressed' },
        { stableMessageKey: 'real-new', senderRole: 'contact', kind: 'text', anchorText: '真正的新消息' },
      ],
    })

    expect(next.newMessages.map((message) => message.stableMessageKey)).toEqual(['real-new'])
    expect(next.binding.recent.map((message) => message.stableMessageKey)).toContain('partial-anchor')
    expect(next.binding.recent.map((message) => message.stableMessageKey)).toContain('suppressed-anchor')
  })

  it('delivers a freshly-downloaded video even when an older readable video shares the same anchor', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    const oldReadableVideo = {
      stableMessageKey: 'old-vid',
      senderRole: 'contact' as const,
      kind: 'video-file',
      anchorText: 'video',
      isBaseline: true,
      bbox: { x: 820, y: 129, width: 266, height: 105 },
      mediaMetadata: { mediaStatus: 'downloaded', attachment: { type: 'video', availability: 'edge-local', localPath: '/tmp/old.mp4' } },
    }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [oldReadableVideo],
    })

    const freshVideoBase = {
      stableMessageKey: 'fresh-vid',
      senderRole: 'contact' as const,
      kind: 'video-file',
      anchorText: 'video',
      bbox: { x: 820, y: 1163, width: 266, height: 273 },
    }
    const pending = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        oldReadableVideo,
        { ...freshVideoBase, mediaMetadata: { mediaStatus: 'not_downloaded', availability: 'pending-download' } },
      ],
    })
    expect(pending.newMessages).toEqual([])

    const ready = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        oldReadableVideo,
        { ...freshVideoBase, mediaMetadata: { mediaStatus: 'downloaded', attachment: { type: 'video', availability: 'edge-local', localPath: '/tmp/fresh.mp4' } } },
      ],
    })
    expect(ready.newMessages.map((message) => message.stableMessageKey)).toEqual(['fresh-vid'])
    expect(ready.binding.revision).toBe(1)
  })

  it('delivers a freshly-downloaded image when an older readable image shares the same anchor and keys drift', () => {
    // 真实现场:上一轮遗留的老图(baseline、已下载 readable)和本轮新图 anchorText 都是 'image'。
    // 新图在「未下完」和「下完」两轮之间 bbox 会随消息滚动漂移,hashed stableMessageKey 因此变化,
    // 无法按 key 命中自己;模糊兜底若匹配到仍在窗口里的老 readable 图,hasLocalMediaUpgrade 恒 false,
    // 新图永远投不出去。回归 e2e(img-e2e-20260702014556)里图片就是这样丢的。
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    const oldReadableImage = {
      stableMessageKey: 'old-img',
      senderRole: 'contact' as const,
      kind: 'image',
      anchorText: 'image',
      isBaseline: true,
      bbox: { x: 737, y: 129, width: 349, height: 270 },
      mediaMetadata: { mediaStatus: 'downloaded', attachment: { type: 'image', availability: 'edge-local', localPath: '/tmp/old.png' } },
    }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [oldReadableImage],
    })

    const pending = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        oldReadableImage,
        { stableMessageKey: 'fresh-img-pending', senderRole: 'contact', kind: 'image', anchorText: 'image', bbox: { x: 737, y: 620, width: 349, height: 270 }, mediaMetadata: { mediaStatus: 'not_downloaded', availability: 'pending-download' } },
      ],
    })
    expect(pending.newMessages).toEqual([])

    const ready = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        oldReadableImage,
        { stableMessageKey: 'fresh-img-ready', senderRole: 'contact', kind: 'image', anchorText: 'image', bbox: { x: 737, y: 797, width: 349, height: 270 }, mediaMetadata: { mediaStatus: 'downloaded', attachment: { type: 'image', availability: 'edge-local', localPath: '/tmp/fresh.png' } } },
      ],
    })
    const deliveredPaths = ready.newMessages.map((message) => {
      const attachment = (message.mediaMetadata as { attachment?: { localPath?: string } } | undefined)?.attachment
      return attachment?.localPath
    })
    expect(deliveredPaths).toContain('/tmp/fresh.png')
    expect(ready.newMessages).toHaveLength(1)
  })


  it('waits for media to become locally readable before delivery and keeps local paths stable', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{ stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' }],
    })

    const pending = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        {
          stableMessageKey: 'file-1',
          senderRole: 'contact',
          kind: 'file',
          anchorText: 'brief.txt',
          mediaMetadata: {
            attachment: {
              type: 'file',
              name: 'brief.txt',
              availability: 'metadata-only',
            },
          },
        },
      ],
    })
    expect(pending.newMessages).toEqual([])

    const localized = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        {
          stableMessageKey: 'file-1',
          senderRole: 'contact',
          kind: 'file',
          anchorText: 'brief.txt',
          mediaMetadata: {
            attachment: {
              type: 'file',
              name: 'brief.txt',
              localPath: '/tmp/brief.txt',
              availability: 'edge-local',
            },
          },
        },
      ],
    })
    expect(localized.newMessages).toEqual([
      expect.objectContaining({ stableMessageKey: 'file-1' }),
    ])

    const regressed = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        {
          stableMessageKey: 'file-1',
          senderRole: 'contact',
          kind: 'file',
          anchorText: 'brief.txt',
          mediaMetadata: {
            attachment: {
              type: 'file',
              name: 'brief.txt',
              availability: 'metadata-only',
            },
          },
        },
      ],
    })

    expect(regressed.newMessages).toEqual([])
    expect(JSON.stringify(regressed.binding.recent.at(-1)?.mediaMetadata)).toContain('/tmp/brief.txt')
    expect(regressed.binding.attachmentStates?.['file-1']).toMatchObject({
      stableMessageKey: 'file-1',
      availability: 'edge-local',
      localPath: '/tmp/brief.txt',
    })
  })

  it('tracks pending attachment state without delivering incomplete media', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{ stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' }],
    })

    const pending = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        {
          stableMessageKey: 'img-pending',
          senderRole: 'contact',
          kind: 'image',
          anchorText: 'photo',
          mediaMetadata: {
            edgeResolveReasonCode: 'clipboard_attachment_unavailable',
            attachment: {
              type: 'image',
              name: 'photo.png',
              availability: 'pending-download',
              providerError: 'clipboard_attachment_unavailable',
            },
          },
        },
      ],
    })

    expect(pending.newMessages).toEqual([])
    expect(pending.binding.recent.map((message) => message.stableMessageKey)).toContain('img-pending')
    expect(pending.binding.attachmentStates?.['img-pending']).toMatchObject({
      stableMessageKey: 'img-pending',
      kind: 'image',
      availability: 'pending-download',
      name: 'photo.png',
      providerError: 'clipboard_attachment_unavailable',
      reasonCode: 'clipboard_attachment_unavailable',
    })
  })

  it('keeps vector references in the ledger without storing raw visual vectors in recent state', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    const next = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{
        stableMessageKey: 'img-1',
        senderRole: 'contact',
        kind: 'image',
        anchorText: 'photo',
        visualBlocks: [{
          blockId: 'image-a',
          blockKind: 'image',
          vectorStoreKey: 'wcv1_a',
          model: 'server-visual-embedding',
          dims: 4,
          signature: 'sig-a',
          vectorBase64: 'raw-vector-should-not-persist',
        }],
      }],
      vectorReferences: [{
        stableMessageKey: 'img-1',
        blockId: 'image-a',
        blockKind: 'image',
        vectorStoreKey: 'wcv1_a',
        model: 'server-visual-embedding',
        dims: 4,
        signature: 'sig-a',
        observedAt: '2026-06-15T00:00:00.000Z',
      }],
    })

    expect(next.binding.vectorReferences?.['img-1']).toEqual([
      expect.objectContaining({ vectorStoreKey: 'wcv1_a', signature: 'sig-a' }),
    ])
    expect(JSON.stringify(next.binding.vectorReferences)).not.toContain('raw-vector-should-not-persist')
  })

  it('keeps needs-review messages in local state but does not deliver them', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{ stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' }],
    })

    const next = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        {
          stableMessageKey: 'ambiguous-media',
          senderRole: 'contact',
          kind: 'image',
          anchorText: 'similar images',
          deliveryStatus: 'needs-review',
          mediaMetadata: {
            attachment: {
              type: 'image',
              name: 'ambiguous.png',
              availability: 'metadata-only',
              providerError: 'ambiguous_media_anchor',
            },
          },
        },
      ],
    })

    expect(next.newMessages).toEqual([])
    expect(next.binding.recent.map((message) => message.stableMessageKey)).toContain('ambiguous-media')
    expect(next.binding.attachmentStates?.['ambiguous-media']).toMatchObject({
      stableMessageKey: 'ambiguous-media',
      availability: 'metadata-only',
      deliveryStatus: 'needs-review',
      providerError: 'ambiguous_media_anchor',
    })
  })

  it('writes a deliverability trace explaining why an undownloaded image is dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-deliverability-'))
    const tracePath = path.join(dir, 'trace.jsonl')
    const previousTraceEnv = process.env.SHENNIAN_WECHAT_DELIVERABILITY_TRACE
    process.env.SHENNIAN_WECHAT_DELIVERABILITY_TRACE = tracePath
    try {
      const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
      updateWeChatChannelBindingLedger({
        ledger,
        bindingId: 'binding1',
        observedMessages: [{ stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' }],
      })
      updateWeChatChannelBindingLedger({
        ledger,
        bindingId: 'binding1',
        observedMessages: [
          { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
          {
            stableMessageKey: 'img-pending',
            senderRole: 'contact',
            kind: 'image',
            anchorText: 'photo',
            mediaMetadata: { attachment: { type: 'image', name: 'photo.png', availability: 'pending-download' } },
          },
        ],
      })

      const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean)
      const lastEntry = JSON.parse(lines.at(-1) as string)
      const imageTrace = lastEntry.messages.find((entry: { stableMessageKey: string }) => entry.stableMessageKey === 'img-pending')
      expect(imageTrace).toMatchObject({
        kind: 'image',
        isNewByAnchor: true,
        isCandidate: true,
        delivered: false,
        hasAttachmentCandidate: true,
        hasAgentReadableAttachment: false,
        dropReason: 'attachment-not-readable',
      })
    } finally {
      if (previousTraceEnv === undefined) delete process.env.SHENNIAN_WECHAT_DELIVERABILITY_TRACE
      else process.env.SHENNIAN_WECHAT_DELIVERABILITY_TRACE = previousTraceEnv
    }
  })

  it('keeps only the latest 20 messages and persists on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-channel-ledger-'))
    const filePath = path.join(dir, 'ledger.json')
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: Array.from({ length: 25 }, (_, index) => ({
        stableMessageKey: `m-${index}`,
        senderRole: 'contact' as const,
        kind: 'text',
      })),
      baselineOnly: true,
    })
    saveWeChatChannelLedger(filePath, ledger)
    const loaded = loadWeChatChannelLedger(filePath, 'runtime1')
    expect(loaded.bindings.binding1.recent).toHaveLength(20)
    expect(loaded.bindings.binding1.recent[0].stableMessageKey).toBe('m-5')
  })

  it('marks disabled bindings and re-enables with baseline-only scan', () => {
    const ledger = { version: 1 as const, runtimeId: 'runtime1', bindings: {} }
    updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [{ stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' }],
    })
    markWeChatChannelBindingDisabled({
      ledger,
      bindingId: 'binding1',
      disabledAt: new Date('2026-06-12T00:00:00.000Z'),
    })

    const reopened = updateWeChatChannelBindingLedger({
      ledger,
      bindingId: 'binding1',
      observedMessages: [
        { stableMessageKey: 'missed-while-off', senderRole: 'contact', kind: 'text', anchorText: 'missed while off' },
      ],
    })

    expect(reopened.newMessages).toEqual([])
    expect(reopened.binding).toMatchObject({ baselineEstablished: true, disabledSince: null })
  })
})
