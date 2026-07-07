// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-inbound-media.test.ts

import {
  defaultWeChatChannelAttachmentDir,
  resolveVisibleWeChatChannelMedia,
  type WeChatChannelVisibleMediaCandidate,
} from './media-resolver.js'
import type { HelperTransport } from './runtime.js'
import type { WeChatObservedMessage, WeChatScreenshot, WeChatScreenshotWithData, WeChatWindowInfo } from './types.js'

export async function resolveUseChatObservedMessageMedia(input: {
  helper: HelperTransport
  messages: WeChatObservedMessage[]
  runtimeId?: string
  bindingId?: string
  workDir?: string
  attachmentsDir?: string
  window: WeChatWindowInfo
  screenshot: WeChatScreenshotWithData
  windowId?: string
  chatName: string
  traceId?: string
  platform?: NodeJS.Platform | string
  mediaAnchorText?: string
  verifyConversationTitle?: () => Promise<{ ok: true } | { ok: false; reasonCode: string }>
}): Promise<WeChatObservedMessage[]> {
  const candidates = input.messages
    .map((message, index) => messageToVisibleMediaCandidate(message, input.screenshot, input.window, nearbyMessageText(input.messages, index)))
    .filter((candidate, index) => mediaCandidateMatchesAnchor(input.messages, index, input.mediaAnchorText))
    .filter((candidate): candidate is WeChatChannelVisibleMediaCandidate => candidate != null)
  if (!candidates.length) return input.messages
  const attachmentsDir = input.attachmentsDir
    ?? defaultWeChatChannelAttachmentDir(
      input.workDir || process.cwd(),
      input.runtimeId || 'usechat-direct',
      input.bindingId || `direct:${stableLocalKey(input.chatName)}`,
    )
  const resolved = await resolveVisibleWeChatChannelMedia({
    helper: input.helper,
    candidates,
    attachmentsDir,
    screenshot: input.screenshot,
    windowId: input.windowId,
    window: input.window,
    traceId: input.traceId,
    platform: input.platform,
    stabilityCheck: async () => {
      if (input.verifyConversationTitle) return input.verifyConversationTitle()
      return { ok: true }
    },
  })
  if (!resolved.length) return input.messages
  const byKey = new Map(resolved.map((item) => [item.messageKey, item]))
  return input.messages.map((message) => {
    const result = byKey.get(message.stableMessageKey)
    if (!result) return message
    return {
      ...message,
      mediaMetadata: mergeResolvedMediaMetadata(message.mediaMetadata, result.attachment, result.reasonCode, result.attemptReasonCodes, result.resolveTrace),
    }
  })
}

function mediaCandidateMatchesAnchor(messages: WeChatObservedMessage[], index: number, anchorText?: string): boolean {
  const anchor = normalizeAnchorNeedle(anchorText)
  if (!anchor) return true
  const fallbackKind = expectedMediaFallbackKindFromAnchor(anchor)
  const anchorIndexes = messages
    .map((message, cursor) => normalizeAnchorNeedle(messageAnchorText(message)).includes(anchor) ? cursor : -1)
    .filter((cursor) => cursor >= 0)
  if (!anchorIndexes.length) return index === latestMediaCandidateIndex(messages, fallbackKind)
  for (const anchorIndex of anchorIndexes) {
    if (index >= anchorIndex && index <= anchorIndex + 8) return true
    if (
      index === anchorIndex - 1
      && !messages.slice(anchorIndex + 1, Math.min(messages.length, anchorIndex + 9)).some(messageHasMediaCandidateShape)
    ) {
      return true
    }
  }
  return false
}

type AnchorFallbackMediaKind = 'file' | 'image' | 'video'

function expectedMediaFallbackKindFromAnchor(normalizedAnchor: string): AnchorFallbackMediaKind | null {
  if (normalizedAnchor.includes('video') || normalizedAnchor.includes('vide0')) return 'video'
  if (normalizedAnchor.includes('image') || normalizedAnchor.includes('photo') || normalizedAnchor.includes('ph0t0') || normalizedAnchor.includes('picture')) return 'image'
  if (normalizedAnchor.includes('file') || normalizedAnchor.includes('document')) return 'file'
  return null
}

function latestMediaCandidateIndex(messages: WeChatObservedMessage[], fallbackKind: AnchorFallbackMediaKind | null = null): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!messageHasMediaCandidateShape(messages[index])) continue
    return messageMatchesFallbackMediaKind(messages[index], fallbackKind) ? index : -1
  }
  return -1
}

function messageHasMediaCandidateShape(message: WeChatObservedMessage | undefined): boolean {
  if (!message) return false
  const kind = String(message.kind || '').toLowerCase()
  const metadata = isRecord(message.mediaMetadata) ? message.mediaMetadata : {}
  const attachment = isRecord(metadata.attachment) ? metadata.attachment : {}
  return isMediaLikeKind(kind, metadata, attachment)
}

function messageMatchesFallbackMediaKind(message: WeChatObservedMessage | undefined, fallbackKind: AnchorFallbackMediaKind | null): boolean {
  if (!message || !fallbackKind) return true
  const kind = String(message.kind || '').toLowerCase()
  const metadata = isRecord(message.mediaMetadata) ? message.mediaMetadata : {}
  const attachment = isRecord(metadata.attachment) ? metadata.attachment : {}
  const type = String(attachment.type || '').toLowerCase()
  const mimeType = String(attachment.mimeType || '').toLowerCase()
  const name = String(attachment.name || attachment.localPath || message.anchorText || message.textExcerpt || '').toLowerCase()
  if (fallbackKind === 'video') return kind.includes('video') || type === 'video' || mimeType.startsWith('video/') || /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(name)
  if (fallbackKind === 'image') return /image|photo|picture/.test(kind) || type === 'image' || mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|tiff?|bmp)$/i.test(name)
  return /file|document/.test(kind) || type === 'file' || (
    !/image|photo|picture|video/.test(kind)
    && type !== 'image'
    && type !== 'video'
    && !mimeType.startsWith('image/')
    && !mimeType.startsWith('video/')
  )
}

function messageAnchorText(message: WeChatObservedMessage | undefined): string {
  if (!message) return ''
  const raw = message as unknown as Record<string, unknown>
  return [
    message.normalizedText,
    message.anchorText,
    message.textExcerpt,
    raw.text,
  ].map((value) => String(value || '')).join('\n')
}

function normalizeAnchorNeedle(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[o]/giu, '0')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

function nearbyMessageText(messages: WeChatObservedMessage[], index: number): string | null {
  const text = [
    messages[index - 1],
    messages[index],
    messages[index + 1],
  ]
    .map((message) => message ? message.normalizedText || message.anchorText || message.textExcerpt || '' : '')
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join('\n')
  return text || null
}

export function messageToVisibleMediaCandidate(
  message: WeChatObservedMessage,
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
  contextText?: string | null,
): WeChatChannelVisibleMediaCandidate | null {
  const kind = String(message.kind || '').toLowerCase()
  const metadata = isRecord(message.mediaMetadata) ? message.mediaMetadata : {}
  const attachment = isRecord(metadata.attachment) ? metadata.attachment : {}
  const availability = stringValue(attachment.availability) || stringValue(metadata.availability)
  const localPath = stringValue(attachment.localPath) || stringValue(metadata.localPath)
  if (availability === 'edge-local' && localPath) return null
  if (!isMediaLikeKind(kind, metadata, attachment)) return null
  const rawBbox = bboxFromUnknown(message.bbox) ?? bboxFromUnknown(metadata.bbox) ?? bboxFromUnknown(metadata.downloadActionBbox)
  const rawDownloadActionBbox = bboxFromUnknown(metadata.downloadActionBbox)
  const bbox = screenBboxForMedia(rawBbox, screenshot, window)
  const screenshotBbox = screenshotBboxForMedia(rawBbox, screenshot, window)
  const downloadActionBbox = screenBboxForMedia(rawDownloadActionBbox, screenshot, window)
  return {
    messageKey: message.stableMessageKey,
    kind: stringValue(attachment.type) || stringValue(attachment.kind) || stringValue(metadata.messageType) || kind,
    fileName: stringValue(attachment.name) || stringValue(attachment.fileName) || stringValue(metadata.fileName) || null,
    mimeType: stringValue(attachment.mimeType) || stringValue(metadata.mimeType) || null,
    size: numberValue(attachment.size) ?? numberValue(metadata.size),
    mediaStatus: mediaStatusFromMetadata(metadata, attachment),
    observedAt: message.observedAt ?? null,
    contextText: contextText ?? message.normalizedText ?? message.anchorText ?? message.textExcerpt ?? null,
    ...(bbox ? { bbox } : {}),
    ...(screenshotBbox ? { screenshotBbox } : {}),
    ...(downloadActionBbox ? { downloadActionBbox } : {}),
  }
}

export function mergeResolvedMediaMetadata(metadata: unknown, attachment: unknown, reasonCode: string, attemptReasonCodes?: string[], resolveTrace?: unknown): Record<string, unknown> {
  const base = isRecord(metadata) ? { ...metadata } : {}
  return {
    ...base,
    availability: isRecord(attachment) ? attachment.availability : base.availability,
    mediaStatus: isRecord(attachment) && attachment.availability === 'edge-local' ? 'downloaded' : base.mediaStatus,
    attachment,
    edgeResolveReasonCode: reasonCode,
    ...(attemptReasonCodes?.length ? { edgeResolveAttempts: attemptReasonCodes } : {}),
    ...(resolveTrace ? { edgeResolveTrace: resolveTrace } : {}),
  }
}

function mediaStatusFromMetadata(metadata: Record<string, unknown>, attachment: Record<string, unknown>): WeChatChannelVisibleMediaCandidate['mediaStatus'] {
  const status = stringValue(metadata.mediaStatus)
  if (status === 'not_downloaded') return 'not_downloaded'
  if (status === 'loading' || status === 'downloading' || status === 'in_progress') return 'loading'
  if (status === 'downloaded' || status === 'available') return 'available'
  const availability = stringValue(attachment.availability) || stringValue(metadata.availability)
  if (availability === 'pending-download') return 'not_downloaded'
  if (availability === 'metadata-only') return 'metadata_only'
  return status || null
}

function isMediaLikeKind(kind: string, metadata: Record<string, unknown>, attachment: Record<string, unknown>): boolean {
  const type = `${kind} ${stringValue(metadata.messageType)} ${stringValue(attachment.type)} ${stringValue(attachment.kind)}`.toLowerCase()
  return /image|photo|video|file|document/.test(type)
}

function bboxFromUnknown(value: unknown): WeChatChannelVisibleMediaCandidate['bbox'] | null {
  if (!isRecord(value)) return null
  const x = numberValue(value.x)
  const y = numberValue(value.y)
  const width = numberValue(value.width)
  const height = numberValue(value.height)
  if (x == null || y == null || width == null || height == null) return null
  return {
    x,
    y,
    width,
    height,
    ...(typeof value.coordinateSpace === 'string' ? { coordinateSpace: value.coordinateSpace } : {}),
  }
}

function screenBboxForMedia(
  bbox: WeChatChannelVisibleMediaCandidate['bbox'] | null,
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
): WeChatChannelVisibleMediaCandidate['bbox'] | null {
  if (!bbox) return null
  if (bbox.coordinateSpace === 'screen') return bbox
  const point = screenPointForTextBbox(bbox, screenshot, window)
  if (!point) return bbox
  const windowBounds = window.bounds
  if (!windowBounds?.width || !windowBounds?.height) {
    return {
      ...bbox,
      x: point.x - bbox.width / 2,
      y: point.y - bbox.height / 2,
      coordinateSpace: 'screen',
    }
  }
  const scaleX = windowBounds.width / screenshot.width
  const scaleY = windowBounds.height / screenshot.height
  const centerX = point.x
  const centerY = point.y
  return {
    x: centerX - (bbox.width * scaleX) / 2,
    y: centerY - (bbox.height * scaleY) / 2,
    width: bbox.width * scaleX,
    height: bbox.height * scaleY,
    coordinateSpace: 'screen',
  }
}

function screenshotBboxForMedia(
  bbox: WeChatChannelVisibleMediaCandidate['bbox'] | null,
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
): WeChatChannelVisibleMediaCandidate['screenshotBbox'] | null {
  if (!bbox) return null
  if (bbox.coordinateSpace !== 'screen') return { ...bbox, coordinateSpace: 'screenshotPixel' }
  const bounds = window.bounds
  if (!bounds?.width || !bounds?.height) return null
  const scaleX = screenshot.width / bounds.width
  const scaleY = screenshot.height / bounds.height
  return {
    x: (bbox.x - bounds.x) * scaleX,
    y: (bbox.y - bounds.y) * scaleY,
    width: bbox.width * scaleX,
    height: bbox.height * scaleY,
    coordinateSpace: 'screenshotPixel',
  }
}

function screenPointForTextBbox(
  value: unknown,
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null
  const bbox = value as Record<string, unknown>
  const x = Number(bbox.x)
  const y = Number(bbox.y)
  const width = Number(bbox.width)
  const height = Number(bbox.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  const coordinateSpace = typeof bbox.coordinateSpace === 'string' ? bbox.coordinateSpace : undefined
  const point = { x: x + width / 2, y: y + height / 2 }
  if (coordinateSpace === 'screen' || !window.bounds) return point
  const scaleX = screenshot.width && window.bounds.width ? screenshot.width / window.bounds.width : 1
  const scaleY = screenshot.height && window.bounds.height ? screenshot.height / window.bounds.height : scaleX
  const contentX = Math.max(0, (screenshot.width - window.bounds.width * scaleX) / 2)
  const contentY = Math.max(0, (screenshot.height - window.bounds.height * scaleY) / 2)
  return {
    x: window.bounds.x + (point.x - contentX) / scaleX,
    y: window.bounds.y + (point.y - contentY) / scaleY,
  }
}

function stableLocalKey(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '').slice(0, 80) || 'chat'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}
