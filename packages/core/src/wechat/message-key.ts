// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-message-key.test.ts

import crypto from 'node:crypto'
import type { WeChatObservedMessage as WeChatChannelObservedMessage } from './types.js'
import { normalizeWeChatAnchorText } from './anchor.js'

export type WeChatChannelMessageKeyInput = Omit<WeChatChannelObservedMessage, 'stableMessageKey'> & {
  stableMessageKey?: string | null
}

export type WeChatChannelNormalizedMessage = WeChatChannelObservedMessage & {
  stableKeyVersion: 1
}

export function normalizeWeChatObservedWindowForLedger(
  messages: WeChatChannelMessageKeyInput[],
): WeChatChannelNormalizedMessage[] {
  const baseCounts = new Map<string, number>()
  return messages.map((message, windowIndex) => {
    const base = stableMessageBase(message, windowIndex)
    const occurrence = baseCounts.get(base) ?? 0
    baseCounts.set(base, occurrence + 1)
    const anchorMetadata = buildAnchorMetadata(message, windowIndex, occurrence)
    const stableMessageKey = normalizeExplicitKey(message.stableMessageKey) || hashStableMessageKey({ base, occurrence })
    const anchorText = message.anchorText || message.normalizedText || message.textExcerpt || ''
    return {
      ...message,
      stableMessageKey,
      stableKeyVersion: 1,
      anchorText,
      anchorMetadata: {
        ...(isRecord(message.anchorMetadata) ? message.anchorMetadata : {}),
        ...anchorMetadata,
      },
    }
  })
}

export function buildStableWeChatMessageKey(message: WeChatChannelMessageKeyInput, windowIndex = 0, occurrence = 0): string {
  return normalizeExplicitKey(message.stableMessageKey) || hashStableMessageKey({
    base: stableMessageBase(message, windowIndex),
    occurrence,
  })
}

export function buildAnchorMetadata(message: WeChatChannelMessageKeyInput, windowIndex: number, occurrence: number) {
  return {
    stableKeyVersion: 1,
    windowIndex,
    occurrence,
    senderRole: message.senderRole,
    kind: message.kind,
    anchorText: normalizeWeChatAnchorText(message.anchorText || message.normalizedText || message.textExcerpt || ''),
    bboxBand: bboxBand(message.bbox),
    mediaSignature: mediaSignature(message),
  }
}

function stableMessageBase(message: WeChatChannelMessageKeyInput, windowIndex: number): string {
  return JSON.stringify({
    senderRole: message.senderRole || 'unknown',
    senderName: normalizeWeChatAnchorText(message.senderName || ''),
    kind: message.kind || 'text',
    anchorText: normalizeWeChatAnchorText(message.anchorText || message.normalizedText || message.textExcerpt || ''),
    bboxBand: bboxBand(message.bbox),
    mediaSignature: mediaSignature(message),
    neighborSignature: neighborSignature(message.neighborContext),
    orderBand: Math.floor(windowIndex / 4),
  })
}

function hashStableMessageKey(input: { base: string; occurrence: number }): string {
  return `wk1_${crypto.createHash('sha256').update(`${input.base}|${input.occurrence}`).digest('hex').slice(0, 24)}`
}

function normalizeExplicitKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function bboxBand(value: unknown): string | null {
  if (!isRecord(value)) return null
  const x = numberPart(value.x)
  const y = numberPart(value.y)
  const width = numberPart(value.width)
  const height = numberPart(value.height)
  if ([x, y, width, height].some((part) => part === null)) return null
  return [x, y, width, height].map((part) => Math.round((part ?? 0) / 20) * 20).join(',')
}

function mediaSignature(message: WeChatChannelMessageKeyInput): string | null {
  const metadata = isRecord(message.mediaMetadata) ? message.mediaMetadata : {}
  const visualBlocks = Array.isArray(message.visualBlocks) ? message.visualBlocks : []
  const parts = [
    stringPart(metadata.fileName),
    stringPart(metadata.mimeType),
    stringPart(metadata.size),
    ...visualBlocks.map((block) => `${block.blockKind}:${block.blockId}`),
  ].filter(Boolean)
  return parts.length ? parts.join('|') : null
}

function neighborSignature(value: unknown): string | null {
  if (!isRecord(value)) return null
  const before = normalizeWeChatAnchorText(value.beforeText || value.previousText || value.prev)
  const after = normalizeWeChatAnchorText(value.afterText || value.nextText || value.next)
  return before || after ? `${before.slice(0, 24)}|${after.slice(0, 24)}` : null
}

function numberPart(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function stringPart(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return String(value).trim() || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
