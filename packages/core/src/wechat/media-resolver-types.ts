// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-media-resolver.test.ts

import type { ExternalMessageAttachment } from './types.js'
import type { WeChatChannelMediaCacheScanTrace } from './media-cache-resolver.js'

export type WeChatChannelVisibleMediaCandidate = {
  messageKey: string
  kind: 'image' | 'video' | 'file' | 'link' | 'card' | string
  bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  screenshotBbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  downloadActionBbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } | null
  fileName?: string | null
  mimeType?: string | null
  size?: number | null
  mediaStatus?: 'available' | 'not_downloaded' | 'loading' | 'metadata_only' | 'unsupported' | string | null
  observedAt?: string | null
  contextText?: string | null
}

export type WeChatChannelMediaResolveResult = {
  messageKey: string
  attachment: ExternalMessageAttachment
  reasonCode: string
  attemptReasonCodes?: string[]
  resolveTrace?: WeChatChannelMediaResolveTrace
}

export type WeChatChannelMediaResolveTrace = {
  candidateKind: string
  bbox?: WeChatChannelVisibleMediaCandidate['bbox']
  downloadActionBbox?: WeChatChannelVisibleMediaCandidate['downloadActionBbox']
  mediaStatus?: WeChatChannelVisibleMediaCandidate['mediaStatus']
  actionPlan: {
    reasonCode: string
    actions: Array<{
      type: string
      reasonCode?: string
      label?: string
      target?: unknown
    }>
  }
  attempts: WeChatChannelMediaResolveAttemptTrace[]
  finalReasonCode?: string
  attachmentValidation?: WeChatChannelMediaAttachmentValidationTrace
}

export type WeChatChannelMediaResolveAttemptTrace = {
  phase: 'stability' | 'copy-before-download' | 'download-action' | 'copy-after-download' | 'cache-scan'
  stage?: WeChatChannelMediaStabilityStage
  retry?: boolean
  pointAttempt?: number
  pointRole?: 'center' | 'file-title' | 'file-body' | 'media-top-left' | 'media-top-right' | 'media-bottom-left' | 'media-bottom-right'
  ok?: boolean
  reasonCode?: string
  rightClickPoint?: { x: number; y: number; coordinateSpace?: string }
  menuSearchBounds?: WeChatChannelMenuSearchBounds
  menuPickOrder?: Array<'ocr-menu'>
  pickedMethod?: 'ocr-menu'
  pickedLabel?: string
  pickedPoint?: { x: number; y: number }
  ocrMenuCandidates?: WeChatChannelOcrMenuCandidateTrace[]
  disallowedLabels?: string[]
  clipboardChangeCountBefore?: number | null
  clipboardChangeCountAfter?: number | null
  clipboardPayload?: WeChatChannelClipboardPayloadTrace
  downloadPoint?: { x: number; y: number; coordinateSpace?: string }
  cacheScan?: WeChatChannelMediaCacheScanTrace
}

export type WeChatChannelOcrMenuCandidateTrace = {
  text: string
  normalizedText: string
  point?: { x: number; y: number }
  bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  exact?: boolean
  exactCopy?: boolean
  fuzzy?: boolean
  dangerous?: boolean
  selected?: boolean
}

export type WeChatChannelClipboardPayloadTrace = {
  changeCount?: number | null
  fileUrlCount: number
  filePathCount: number
  hasImageData: boolean
  imageDataBytes?: number
  mimeType?: string
  suggestedFileName?: string
  fileNames?: string[]
  extensions?: string[]
}

export type WeChatChannelMediaAttachmentValidationTrace = {
  availability?: ExternalMessageAttachment['availability']
  type?: string
  name?: string
  localPath?: string
  mimeType?: string
  extension?: string
  materializationKind?: ExternalMessageAttachment['materializationKind']
  isOriginal?: boolean
  mimeKindMatches?: boolean
}

export type WeChatChannelMediaStabilityStage = 'before-media-action' | 'after-media-action'

export type WeChatChannelMediaStabilityCheck = (input: {
  stage: WeChatChannelMediaStabilityStage
  candidate: WeChatChannelVisibleMediaCandidate
}) => Promise<{ ok: true } | { ok: false; reasonCode: string }> | { ok: true } | { ok: false; reasonCode: string }

export type WeChatChannelMenuSearchBounds = {
  x: number
  y: number
  width: number
  height: number
  coordinateSpace?: string
}

export type WeChatChannelScreenCapture = {
  mimeType?: string
  dataBase64?: string
  width?: number
  height?: number
  bounds?: WeChatChannelMenuSearchBounds
}


export type ClipboardAttachmentPayload = {
  fileUrls?: string[]
  filePaths?: string[]
  dataBase64?: string
  mimeType?: string
  suggestedFileName?: string
  changeCount?: number
}

