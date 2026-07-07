// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-ledger.test.ts

import fs from 'node:fs'
import path from 'node:path'
import { WECHAT_CHANNEL_RECENT_MESSAGE_WINDOW } from './runtime.js'
import type { WeChatObservedMessage as WeChatChannelObservedMessage } from './types.js'
import { filterNewWeChatMessagesByAnchor, isLikelySameWeChatMessage } from './anchor.js'
import { normalizeWeChatObservedWindowForLedger } from './message-key.js'
import type { WeChatChannelCooldownState } from './cooldown.js'
import type { WeChatChannelVectorReference } from './vector-store.js'


export type WeChatChannelLedger = {
  version: 1
  runtimeId: string
  bindings: Record<string, WeChatChannelBindingLedger>
}

export type WeChatChannelBindingLedger = {
  bindingId: string
  baselineEstablished: boolean
  disabledSince?: string | null
  revision: number
  recent: WeChatChannelObservedMessage[]
  pendingSendKeys: string[]
  attachmentStates?: Record<string, WeChatChannelAttachmentState>
  vectorReferences?: Record<string, WeChatChannelVectorReference[]>
  cooldown?: WeChatChannelCooldownState
}

export type WeChatChannelAttachmentState = {
  stableMessageKey: string
  kind: string
  availability: string
  deliveryStatus?: string
  localPath?: string
  url?: string
  name?: string
  providerError?: string
  reasonCode?: string
}

export function loadWeChatChannelLedger(filePath: string, runtimeId: string): WeChatChannelLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WeChatChannelLedger
    if (parsed?.version === 1 && parsed.runtimeId === runtimeId && parsed.bindings && typeof parsed.bindings === 'object') return parsed
  } catch {}
  return { version: 1, runtimeId, bindings: {} }
}

export function saveWeChatChannelLedger(filePath: string, ledger: WeChatChannelLedger): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2))
}

export function updateWeChatChannelBindingLedger(input: {
  ledger: WeChatChannelLedger
  bindingId: string
  observedMessages: WeChatChannelObservedMessage[]
  baselineOnly?: boolean
  vectorReferences?: WeChatChannelVectorReference[]
}): { binding: WeChatChannelBindingLedger; newMessages: WeChatChannelObservedMessage[] } {
  const existing = input.ledger.bindings[input.bindingId]
  const normalized = normalizeWeChatObservedWindowForLedger(input.observedMessages).map(stripRawVisualVectorsFromMessage)
  const retained = mergePreviousLocalMedia(existing?.recent ?? [], normalized)
    .slice(-WECHAT_CHANNEL_RECENT_MESSAGE_WINDOW)
  const baselineOnly = input.baselineOnly || !existing?.baselineEstablished || Boolean(existing?.disabledSince)
  const newMessages = baselineOnly ? [] : filterDeliverableWeChatMessages(existing?.recent ?? [], retained)
  const binding: WeChatChannelBindingLedger = {
    bindingId: input.bindingId,
    baselineEstablished: true,
    disabledSince: null,
    revision: (existing?.revision ?? 0) + (newMessages.length > 0 ? 1 : 0),
    recent: retained,
    pendingSendKeys: existing?.pendingSendKeys ?? [],
    attachmentStates: buildAttachmentStates(retained, existing?.attachmentStates),
    vectorReferences: buildVectorReferences(retained, existing?.vectorReferences, input.vectorReferences),
    cooldown: existing?.cooldown,
  }
  input.ledger.bindings[input.bindingId] = binding
  return { binding, newMessages }
}

function stripRawVisualVectorsFromMessage(message: WeChatChannelObservedMessage): WeChatChannelObservedMessage {
  if (!Array.isArray(message.visualBlocks)) return message
  return {
    ...message,
    visualBlocks: message.visualBlocks.map((block) => {
      const { vectorBase64: _vectorBase64, ...rest } = block
      return rest
    }),
  }
}

export function markWeChatChannelBindingDisabled(input: {
  ledger: WeChatChannelLedger
  bindingId: string
  disabledAt?: Date
}): WeChatChannelBindingLedger {
  const existing = input.ledger.bindings[input.bindingId]
  const binding: WeChatChannelBindingLedger = {
    bindingId: input.bindingId,
    baselineEstablished: false,
    disabledSince: (input.disabledAt ?? new Date()).toISOString(),
    revision: existing?.revision ?? 0,
    recent: existing?.recent ?? [],
    pendingSendKeys: existing?.pendingSendKeys ?? [],
    attachmentStates: existing?.attachmentStates,
    vectorReferences: existing?.vectorReferences,
    cooldown: existing?.cooldown,
  }
  input.ledger.bindings[input.bindingId] = binding
  return binding
}

function buildVectorReferences(
  recent: WeChatChannelObservedMessage[],
  previous: Record<string, WeChatChannelVectorReference[]> | undefined,
  incoming: WeChatChannelVectorReference[] | undefined,
): Record<string, WeChatChannelVectorReference[]> | undefined {
  const incomingByMessage = new Map<string, WeChatChannelVectorReference[]>()
  for (const reference of incoming ?? []) {
    const stableMessageKey = stringValue(reference.stableMessageKey)
    if (!stableMessageKey) continue
    const current = incomingByMessage.get(stableMessageKey) ?? []
    current.push(reference)
    incomingByMessage.set(stableMessageKey, current)
  }

  const states: Record<string, WeChatChannelVectorReference[]> = {}
  for (const message of recent) {
    const references = incomingByMessage.get(message.stableMessageKey)
      ?? vectorReferencesFromMessage(message)
      ?? previous?.[message.stableMessageKey]
    if (references?.length) states[message.stableMessageKey] = references
  }
  return Object.keys(states).length ? states : undefined
}

function vectorReferencesFromMessage(message: WeChatChannelObservedMessage): WeChatChannelVectorReference[] | undefined {
  const blocks = Array.isArray(message.visualBlocks) ? message.visualBlocks : []
  const references = blocks.flatMap((block) => {
    const vectorStoreKey = stringValue(block.vectorStoreKey)
    const blockId = stringValue(block.blockId)
    const blockKind = stringValue(block.blockKind) || 'visual'
    const model = stringValue(block.modelVersion) || stringValue(block.model) || 'server-visual-embedding'
    const dims = Number(block.dims)
    if (!vectorStoreKey || !blockId || !Number.isFinite(dims) || dims < 1) return []
    return [{
      stableMessageKey: message.stableMessageKey,
      blockId,
      blockKind,
      vectorStoreKey,
      model,
      ...(block.modelVersion !== undefined ? { modelVersion: block.modelVersion } : {}),
      dims: Math.round(dims),
      ...(stringValue(block.signature) ? { signature: stringValue(block.signature) } : {}),
      ...(block.bbox !== undefined ? { bbox: block.bbox } : {}),
      observedAt: message.observedAt || new Date(0).toISOString(),
    }]
  })
  return references.length ? references : undefined
}

export function filterDeliverableWeChatMessages(
  previous: WeChatChannelObservedMessage[],
  current: WeChatChannelObservedMessage[],
): WeChatChannelObservedMessage[] {
  const newByAnchor = filterNewWeChatMessagesByAnchor({ previous, current })
  const newKeys = new Set(newByAnchor.map((message) => message.stableMessageKey))
  const currentKeys = new Set(current.map((message) => message.stableMessageKey))
  const trace: WeChatChannelDeliverabilityTrace[] = []
  const candidates = current.filter((message) => {
    if (newKeys.has(message.stableMessageKey)) return true
    // 升级判定必须拿这条消息「自己」上一轮的状态比，不能模糊匹配到别的同类消息。
    // 一个会话里可能有多条 video-file / image（anchorText 都是 'video' / 'image'），靠
    // isLikelySameWeChatMessage 的文本相似度会把刚下载好的新媒体匹配到一条早就 readable 的旧媒体上，
    // hasLocalMediaUpgrade 因此恒为 false，新媒体永远投递不出去。优先用 stableMessageKey 精确命中自己；
    // 模糊兜底只允许匹配「这一轮已经不在窗口里」的旧消息（即 key 漂移的同一条），当前窗口里各有归属的
    // 旧消息绝不借给别人当升级前身，否则会把新图错配到顶部那张老 readable 图上。
    const matchedPrevious = previous.find((item) => item.stableMessageKey === message.stableMessageKey)
      ?? previous.find((item) => !currentKeys.has(item.stableMessageKey) && isLikelySameWeChatMessage(item, message))
    return matchedPrevious ? hasLocalMediaUpgrade(matchedPrevious, message) : false
  })
  const candidateKeys = new Set(candidates.map((message) => message.stableMessageKey))
  const delivered = candidates.filter((message) => {
    if (message.senderRole === 'self') return false
    if (message.isBaseline === true) return false
    if (isNonDeliverableStatus(message.deliveryStatus)) return false
    if (hasAttachmentCandidate(message) && !hasAgentReadableAttachment(message)) return false
    return true
  })
  const deliveredKeys = new Set(delivered.map((message) => message.stableMessageKey))
  for (const message of current) {
    trace.push({
      stableMessageKey: message.stableMessageKey,
      kind: message.kind || null,
      senderRole: message.senderRole || null,
      anchorText: (message.anchorText || message.normalizedText || message.textExcerpt || '').slice(0, 40),
      isNewByAnchor: newKeys.has(message.stableMessageKey),
      isCandidate: candidateKeys.has(message.stableMessageKey),
      delivered: deliveredKeys.has(message.stableMessageKey),
      isBaseline: message.isBaseline === true,
      deliveryStatus: message.deliveryStatus ?? null,
      hasAttachmentCandidate: hasAttachmentCandidate(message),
      hasAgentReadableAttachment: hasAgentReadableAttachment(message),
      dropReason: deliverabilityDropReason(message, candidateKeys.has(message.stableMessageKey)),
    })
  }
  logDeliverabilityTrace(trace)
  return delivered
}

type WeChatChannelDeliverabilityTrace = {
  stableMessageKey: string
  kind: string | null
  senderRole: string | null
  anchorText: string
  isNewByAnchor: boolean
  isCandidate: boolean
  delivered: boolean
  isBaseline: boolean
  deliveryStatus: string | null
  hasAttachmentCandidate: boolean
  hasAgentReadableAttachment: boolean
  dropReason: string | null
}

function deliverabilityDropReason(message: WeChatChannelObservedMessage, isCandidate: boolean): string | null {
  if (!isCandidate) return 'not-new-and-no-media-upgrade'
  if (message.senderRole === 'self') return 'sender-self'
  if (message.isBaseline === true) return 'baseline'
  if (isNonDeliverableStatus(message.deliveryStatus)) return `status:${normalizedDeliveryStatus(message.deliveryStatus)}`
  if (hasAttachmentCandidate(message) && !hasAgentReadableAttachment(message)) return 'attachment-not-readable'
  return null
}

function logDeliverabilityTrace(trace: WeChatChannelDeliverabilityTrace[]): void {
  const target = process.env.SHENNIAN_WECHAT_DELIVERABILITY_TRACE
  if (!target) return
  try {
    const line = JSON.stringify({ at: new Date().toISOString(), messages: trace }) + '\n'
    if (target === '1' || target === 'stderr') process.stderr.write(`[wechat-deliverability] ${line}`)
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.appendFileSync(target, line)
    }
  } catch {}
}

function buildAttachmentStates(
  recent: WeChatChannelObservedMessage[],
  previous: Record<string, WeChatChannelAttachmentState> | undefined,
): Record<string, WeChatChannelAttachmentState> | undefined {
  const states: Record<string, WeChatChannelAttachmentState> = {}
  for (const message of recent) {
    const state = attachmentStateForMessage(message)
    const previousState = previous?.[message.stableMessageKey]
    if (!state && previousState) {
      states[message.stableMessageKey] = previousState
      continue
    }
    if (state) states[message.stableMessageKey] = preferReadableAttachmentState(previousState, state)
  }
  return Object.keys(states).length ? states : undefined
}

function attachmentStateForMessage(message: WeChatChannelObservedMessage): WeChatChannelAttachmentState | null {
  const candidates = attachmentCandidates(message.mediaMetadata)
  if (!candidates.length && !hasAttachmentCandidate(message) && !isNonDeliverableStatus(message.deliveryStatus)) return null
  const attachment = bestReadableAttachment(message.mediaMetadata as Record<string, unknown>) ?? candidates[0] ?? {}
  const deliveryStatus = normalizedDeliveryStatus(message.deliveryStatus)
  const availability = stringValue(attachment.availability)
    || stringValue((message.mediaMetadata as Record<string, unknown> | undefined)?.availability)
    || (deliveryStatus === 'needs-review' ? 'needs-review' : 'metadata-only')
  return {
    stableMessageKey: message.stableMessageKey,
    kind: message.kind || stringValue(attachment.type) || 'unknown',
    availability,
    ...(deliveryStatus ? { deliveryStatus } : {}),
    ...(stringValue(attachment.localPath) ? { localPath: stringValue(attachment.localPath) } : {}),
    ...(stringValue(attachment.url) ? { url: stringValue(attachment.url) } : {}),
    ...(stringValue(attachment.name) || stringValue(attachment.fileName) ? { name: stringValue(attachment.name) || stringValue(attachment.fileName) } : {}),
    ...(stringValue(attachment.providerError) ? { providerError: stringValue(attachment.providerError) } : {}),
    ...(stringValue(attachment.reasonCode) || stringValue((message.mediaMetadata as Record<string, unknown> | undefined)?.edgeResolveReasonCode)
      ? { reasonCode: stringValue(attachment.reasonCode) || stringValue((message.mediaMetadata as Record<string, unknown> | undefined)?.edgeResolveReasonCode) }
      : {}),
  }
}

function preferReadableAttachmentState(
  previous: WeChatChannelAttachmentState | undefined,
  current: WeChatChannelAttachmentState,
): WeChatChannelAttachmentState {
  if (!previous) return current
  if (isReadableAttachmentState(current)) return current
  if (isReadableAttachmentState(previous)) return previous
  return current
}

function isReadableAttachmentState(state: WeChatChannelAttachmentState): boolean {
  return (state.availability === 'edge-local' && Boolean(state.localPath))
    || (state.availability === 'server-url' && Boolean(state.url))
}

function isNonDeliverableStatus(status: unknown): boolean {
  const normalized = normalizedDeliveryStatus(status)
  return normalized === 'suppressed'
    || normalized === 'pending'
    || normalized === 'needs-review'
    || normalized === 'manual-review'
}

function mergePreviousLocalMedia(
  previous: WeChatChannelObservedMessage[],
  current: WeChatChannelObservedMessage[],
): WeChatChannelObservedMessage[] {
  const currentKeys = new Set(current.map((message) => message.stableMessageKey))
  return current.map((message) => {
    if (hasAgentReadableAttachment(message)) return message
    // 只从「同一条消息」上一轮的状态里把已就绪的本地附件带过来。同一会话里多条 video-file
    // 的 anchorText 都是 'video'，模糊匹配会把别的视频已下好的本地路径错套到这条还没下好的视频上。
    // 先按 stableMessageKey 精确命中；模糊兜底只允许匹配「这一轮已经不在窗口里」的旧消息
    // （即 key 漂移的同一条），已经在当前窗口里各有归属的旧消息绝不借给别人。
    const matchedPrevious = previous.find((item) => item.stableMessageKey === message.stableMessageKey && hasAgentReadableAttachment(item))
      ?? previous.find((item) => !currentKeys.has(item.stableMessageKey)
        && isLikelySameWeChatMessage(item, message)
        && hasAgentReadableAttachment(item))
    if (!matchedPrevious) return message
    return {
      ...message,
      mediaMetadata: mergeMediaMetadata(message.mediaMetadata, matchedPrevious.mediaMetadata),
    }
  })
}

function hasLocalMediaUpgrade(previous: WeChatChannelObservedMessage, current: WeChatChannelObservedMessage): boolean {
  return hasAttachmentCandidate(previous)
    && !hasAgentReadableAttachment(previous)
    && hasAgentReadableAttachment(current)
}

function hasAttachmentCandidate(message: WeChatChannelObservedMessage): boolean {
  return attachmentCandidates(message.mediaMetadata).length > 0 || /image|photo|video|file|document/i.test(message.kind || '')
}

function hasAgentReadableAttachment(message: WeChatChannelObservedMessage): boolean {
  return attachmentCandidates(message.mediaMetadata).some((attachment) => {
    const localPath = typeof attachment.localPath === 'string' ? attachment.localPath.trim() : ''
    const url = typeof attachment.url === 'string' ? attachment.url.trim() : ''
    const availability = typeof attachment.availability === 'string' ? attachment.availability : ''
    return (availability === 'edge-local' && Boolean(localPath)) || (availability === 'server-url' && Boolean(url))
  })
}

function mergeMediaMetadata(current: unknown, previous: unknown): unknown {
  const currentRecord = isRecord(current) ? { ...current } : {}
  const previousRecord = isRecord(previous) ? previous : {}
  const previousAttachment = bestReadableAttachment(previousRecord)
  if (!previousAttachment) return current
  return {
    ...currentRecord,
    availability: previousAttachment.availability,
    mediaStatus: 'downloaded',
    attachment: {
      ...(isRecord(currentRecord.attachment) ? currentRecord.attachment : {}),
      ...previousAttachment,
    },
  }
}

function bestReadableAttachment(metadata: Record<string, unknown>): Record<string, unknown> | null {
  return attachmentCandidates(metadata).find((attachment) => {
    const availability = typeof attachment.availability === 'string' ? attachment.availability : ''
    const localPath = typeof attachment.localPath === 'string' ? attachment.localPath.trim() : ''
    const url = typeof attachment.url === 'string' ? attachment.url.trim() : ''
    return (availability === 'edge-local' && Boolean(localPath)) || (availability === 'server-url' && Boolean(url))
  }) ?? null
}

function attachmentCandidates(metadata: unknown): Record<string, unknown>[] {
  if (!isRecord(metadata)) return []
  if (Array.isArray(metadata.attachments)) return metadata.attachments.filter(isRecord)
  if (isRecord(metadata.attachment)) return [metadata.attachment]
  if (metadata.localPath || metadata.url || metadata.name || metadata.fileName || metadata.availability) return [metadata]
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedDeliveryStatus(status: unknown): string {
  return String(status ?? '').trim().toLowerCase().replace(/_/g, '-')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
