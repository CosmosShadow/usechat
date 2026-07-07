// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-media-action-plan.test.ts

import {
  normalizeWeChatChannelMessageKind,
  normalizeWeChatChannelAttachmentAvailability,
  type WeChatChannelMediaAction,
  type WeChatChannelMediaActionPlan,
  type WeChatChannelMediaCandidate,
  type WeChatChannelMessageKind,
} from './schema.js'

const DOWNLOADABLE_KINDS = new Set<WeChatChannelMessageKind>(['image', 'file', 'video-file'])
const CARD_KINDS = new Set<WeChatChannelMessageKind>([
  'video-card',
  'link-card',
  'official-account-card',
  'mini-program-card',
])

export function buildWeChatChannelMediaActionPlan(candidate: WeChatChannelMediaCandidate): WeChatChannelMediaActionPlan {
  const kind = normalizeWeChatChannelMessageKind(candidate.kind)
  if (!DOWNLOADABLE_KINDS.has(kind)) {
    return {
      messageKey: candidate.messageKey,
      kind,
      actions: [],
      reasonCode: CARD_KINDS.has(kind) ? 'unsupported_share_card' : 'unsupported_media_kind',
    }
  }
  if (!candidate.bbox) {
    return {
      messageKey: candidate.messageKey,
      kind,
      actions: [],
      reasonCode: 'media_bbox_missing',
    }
  }

  const actions: WeChatChannelMediaAction[] = [
    ...copyActionsForKind(kind, candidate.bbox),
    {
      type: 'postprocess-file',
      reasonCode: 'verify-local-attachment',
    },
  ]

  return {
    messageKey: candidate.messageKey,
    kind,
    actions,
    reasonCode: 'copy_clipboard_plan',
  }
}

export function shouldClickDownloadAffordance(candidate: WeChatChannelMediaCandidate): boolean {
  if (!candidate.downloadActionBbox) return false
  const availability = normalizeWeChatChannelAttachmentAvailability(candidate.mediaStatus)
  if (availability === 'pending-download') return true
  const status = String(candidate.mediaStatus ?? '').trim().toLowerCase().replace(/-/g, '_')
  return status === 'loading'
}

function copyMenuLabelForKind(kind: WeChatChannelMessageKind): string {
  if (kind === 'image') return '复制图片'
  if (kind === 'video-file') return '复制视频'
  return '复制文件'
}

function copyActionsForKind(kind: WeChatChannelMessageKind, bbox: NonNullable<WeChatChannelMediaCandidate['bbox']>, retry = false): WeChatChannelMediaAction[] {
  return [
    {
      type: 'right-click-media',
      target: bbox,
      reasonCode: retry ? `retry-open-${kind}-context-menu-after-download` : `open-${kind}-context-menu`,
    },
    {
      type: 'ocr-click-menu-item',
      label: copyMenuLabelForKind(kind),
      reasonCode: retry ? `retry-copy-${kind}-from-context-menu` : `copy-${kind}-from-context-menu`,
    },
    {
      type: 'materialize-clipboard',
      reasonCode: retry ? 'retry-materialize-system-clipboard-attachment' : 'materialize-system-clipboard-attachment',
    },
  ]
}
