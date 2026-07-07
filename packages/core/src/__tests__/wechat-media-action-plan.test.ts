// @covers ../wechat/core/media-action-plan.ts

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildWeChatChannelMediaActionPlan,
  shouldClickDownloadAffordance,
} from '../wechat/core/media-action-plan.js'
import type {
  WeChatChannelMediaActionPlan,
  WeChatChannelMessageKind,
  WeChatChannelRect,
} from '../wechat/core/schema.js'

describe('WeChat channel media action planner', () => {
  it('plans right-click clipboard materialization for already visible image media', () => {
    const plan = buildWeChatChannelMediaActionPlan({
      messageKey: 'm1',
      kind: 'image',
      bbox: { x: 10, y: 20, width: 120, height: 80 },
      mediaStatus: 'downloaded',
    })

    expect(plan).toMatchObject({
      messageKey: 'm1',
      kind: 'image',
      reasonCode: 'copy_clipboard_plan',
    })
    expect(plan.actions.map((action) => action.type)).toEqual([
      'right-click-media',
      'ocr-click-menu-item',
      'materialize-clipboard',
      'postprocess-file',
    ])
    expect(plan.actions[1]).toMatchObject({ label: '复制图片' })
  })

  it('keeps unloaded video media on the copy-only path even when a download affordance is visible', () => {
    const plan = buildWeChatChannelMediaActionPlan({
      messageKey: 'm2',
      kind: 'video-file',
      bbox: { x: 10, y: 20, width: 120, height: 80 },
      downloadActionBbox: { x: 70, y: 50, width: 24, height: 24 },
      mediaStatus: 'not_downloaded',
    })

    expect(shouldClickDownloadAffordance({
      messageKey: 'm2',
      kind: 'video-file',
      bbox: { x: 10, y: 20, width: 120, height: 80 },
      downloadActionBbox: { x: 70, y: 50, width: 24, height: 24 },
      mediaStatus: 'not_downloaded',
    })).toBe(true)
    expect(plan.reasonCode).toBe('copy_clipboard_plan')
    expect(plan.actions.map((action) => action.type)).toEqual([
      'right-click-media',
      'ocr-click-menu-item',
      'materialize-clipboard',
      'postprocess-file',
    ])
    expect(plan.actions.some((action) => action.type === 'click-download')).toBe(false)
  })

  it('keeps unloaded document cards on the copy-only path to avoid opening previews', () => {
    const plan = buildWeChatChannelMediaActionPlan({
      messageKey: 'file-download',
      kind: 'file',
      bbox: { x: 10, y: 20, width: 160, height: 110 },
      downloadActionBbox: { x: 130, y: 74, width: 24, height: 24 },
      mediaStatus: 'not_downloaded',
    })

    expect(plan.reasonCode).toBe('copy_clipboard_plan')
    expect(plan.actions.map((action) => action.type)).toEqual([
      'right-click-media',
      'ocr-click-menu-item',
      'materialize-clipboard',
      'postprocess-file',
    ])
    expect(plan.actions.some((action) => action.type === 'click-download')).toBe(false)
  })

  it('rejects share cards and missing bbox media as non-actionable plans', () => {
    expect(buildWeChatChannelMediaActionPlan({
      messageKey: 'card1',
      kind: 'video-card',
      bbox: { x: 1, y: 2, width: 3, height: 4 },
    })).toMatchObject({
      kind: 'video-card',
      actions: [],
      reasonCode: 'unsupported_share_card',
    })

    expect(buildWeChatChannelMediaActionPlan({
      messageKey: 'file1',
      kind: 'file',
    })).toMatchObject({
      kind: 'file',
      actions: [],
      reasonCode: 'media_bbox_missing',
    })
  })

  it('replays Lab visible-window download fixtures through the Product action planner', () => {
    const truth = readDownloadGroundTruth()
    const replayed = truth.conversations.flatMap((conversation) => conversation.candidates.map((candidate) => {
      const plan = buildWeChatChannelMediaActionPlan({
        messageKey: `${conversation.conversation}:${candidate.index}`,
        kind: candidate.kind,
        bbox: candidate.bbox,
        downloadActionBbox: candidate.downloadActionBbox,
        mediaStatus: candidate.mediaStatus,
      })
      return { conversation: conversation.conversation, candidate, plan }
    }))

    expect(replayed.length).toBeGreaterThan(0)
    for (const item of replayed) {
      expect(item.plan.kind).toBe(item.candidate.kind)
      expect(item.plan.reasonCode).toBe(expectedPlanReasonCode(item.candidate))
      expect(item.plan.actions.map((action) => action.type)).toEqual([
        ...item.candidate.actions
          .map((action) => labActionTypeToProduct(action.type))
          .filter((type) => type !== 'click-download'),
        'postprocess-file',
      ])
      const firstRightClick = item.plan.actions.find((action) => action.type === 'right-click-media')
      expect(firstRightClick).toMatchObject({
        type: 'right-click-media',
        target: item.candidate.bbox,
      })
    }
  })
})

type DownloadGroundTruth = {
  conversations: Array<{
    conversation: string
    candidates: LabDownloadCandidate[]
  }>
}

type LabDownloadCandidate = {
  index: number
  kind: WeChatChannelMessageKind
  mediaStatus?: string | null
  bbox: WeChatChannelRect
  downloadActionBbox?: WeChatChannelRect | null
  actions: Array<{ type: string }>
}

function readDownloadGroundTruth(): DownloadGroundTruth {
  const relative = 'scripts/wechat-rpa-lab/fixtures/visible-window-structure/download-ground-truth.json'
  const candidates = [path.resolve(relative), path.resolve('../..', relative)]
  const filePath = candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as DownloadGroundTruth
}

function expectedPlanReasonCode(candidate: LabDownloadCandidate): WeChatChannelMediaActionPlan['reasonCode'] {
  void candidate
  return 'copy_clipboard_plan'
}

function labActionTypeToProduct(type: string): string {
  if (type === 'right-click') return 'right-click-media'
  if (type === 'click') return 'click-download'
  return type
}
