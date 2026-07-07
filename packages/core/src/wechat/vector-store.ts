// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-vector-store.test.ts

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WECHAT_CHANNEL_RECENT_MESSAGE_WINDOW } from './runtime.js'
import type { WeChatObservedMessage } from './types.js'

type WeChatChannelVisualBlock = NonNullable<WeChatObservedMessage['visualBlocks']>[number]

export type WeChatChannelVectorStore = {
  version: 1
  runtimeId: string
  bindings: Record<string, WeChatChannelBindingVectorStore>
}

export type WeChatChannelBindingVectorStore = {
  bindingId: string
  vectors: Record<string, WeChatChannelVectorRecord>
}

export type WeChatChannelVectorRecord = {
  vectorStoreKey: string
  stableMessageKey: string
  blockId: string
  blockKind: string
  model: string
  modelVersion?: string | null
  dims: number
  vectorBase64?: string
  signature?: string
  bbox?: unknown
  observedAt: string
}

export type WeChatChannelVectorReference = {
  stableMessageKey: string
  blockId: string
  blockKind: string
  vectorStoreKey: string
  model: string
  modelVersion?: string | null
  dims: number
  signature?: string
  bbox?: unknown
  observedAt: string
}

export function defaultWeChatChannelVectorStorePath(workDir: string, runtimeId: string): string {
  return path.join(workDir, 'wechat-channel', `${runtimeId}.vector-store.json`)
}

export function loadWeChatChannelVectorStore(filePath: string, runtimeId: string): WeChatChannelVectorStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WeChatChannelVectorStore
    if (parsed?.version === 1 && parsed.runtimeId === runtimeId && parsed.bindings && typeof parsed.bindings === 'object') return parsed
  } catch {}
  return { version: 1, runtimeId, bindings: {} }
}

export function saveWeChatChannelVectorStore(filePath: string, store: WeChatChannelVectorStore): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2))
}

export function upsertWeChatChannelVectorReferences(input: {
  store: WeChatChannelVectorStore
  bindingId: string
  blocks: WeChatChannelVisualBlock[]
  now?: Date
}): WeChatChannelVectorReference[] {
  const binding = input.store.bindings[input.bindingId] ?? { bindingId: input.bindingId, vectors: {} }
  const observedAt = (input.now ?? new Date()).toISOString()
  const references: WeChatChannelVectorReference[] = []
  for (const block of input.blocks) {
    const stableMessageKey = stringValue(block.stableMessageKey)
    const blockId = stringValue(block.blockId)
    const blockKind = stringValue(block.blockKind) || 'visual'
    const dims = positiveInt(block.dims)
    const model = stringValue(block.modelVersion) || stringValue(block.model) || 'server-visual-embedding'
    const vectorBase64 = stringValue(block.vectorBase64)
    const signature = stringValue(block.signature) || (vectorBase64 ? vectorSignature(vectorBase64) : '')
    if (!stableMessageKey || !blockId || dims < 1 || (!vectorBase64 && !signature)) continue
    const vectorStoreKey = buildVectorStoreKey({ stableMessageKey, blockId, blockKind, model, signature, vectorBase64 })
    const record: WeChatChannelVectorRecord = {
      vectorStoreKey,
      stableMessageKey,
      blockId,
      blockKind,
      model,
      ...(block.modelVersion !== undefined ? { modelVersion: block.modelVersion } : {}),
      dims,
      ...(vectorBase64 ? { vectorBase64 } : {}),
      ...(signature ? { signature } : {}),
      ...(block.bbox !== undefined ? { bbox: block.bbox } : {}),
      observedAt,
    }
    binding.vectors[vectorStoreKey] = record
    references.push(toVectorReference(record))
  }
  binding.vectors = trimVectors(binding.vectors)
  input.store.bindings[input.bindingId] = binding
  return references
}

function trimVectors(records: Record<string, WeChatChannelVectorRecord>): Record<string, WeChatChannelVectorRecord> {
  const entries = Object.values(records)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .slice(-WECHAT_CHANNEL_RECENT_MESSAGE_WINDOW * 4)
  return Object.fromEntries(entries.map((record) => [record.vectorStoreKey, record]))
}

function toVectorReference(record: WeChatChannelVectorRecord): WeChatChannelVectorReference {
  return {
    stableMessageKey: record.stableMessageKey,
    blockId: record.blockId,
    blockKind: record.blockKind,
    vectorStoreKey: record.vectorStoreKey,
    model: record.model,
    ...(record.modelVersion !== undefined ? { modelVersion: record.modelVersion } : {}),
    dims: record.dims,
    ...(record.signature ? { signature: record.signature } : {}),
    ...(record.bbox !== undefined ? { bbox: record.bbox } : {}),
    observedAt: record.observedAt,
  }
}

function buildVectorStoreKey(input: {
  stableMessageKey: string
  blockId: string
  blockKind: string
  model: string
  signature: string
  vectorBase64: string
}): string {
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({
      stableMessageKey: input.stableMessageKey,
      blockId: input.blockId,
      blockKind: input.blockKind,
      model: input.model,
      signature: input.signature,
      vectorBase64: input.vectorBase64,
    }))
    .digest('hex')
    .slice(0, 24)
  return `wcv1_${hash}`
}

function vectorSignature(vectorBase64: string): string {
  return `sha256:${crypto.createHash('sha256').update(vectorBase64).digest('hex').slice(0, 32)}`
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : 0
}
