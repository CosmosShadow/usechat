// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-message-quality.test.ts

import type { WeChatObservedMessage } from './types.js'

type MessageBbox = {
  x: number
  y: number
  width: number
  height: number
  coordinateSpace?: string
}

export type WeChatMessageQualityWarning = {
  code: 'message_bbox_invalid' | 'message_bbox_out_of_window' | 'message_order_non_monotonic' | 'message_duplicate_key'
  message: string
  messageIndex?: number
  stableMessageKey?: string
  details?: Record<string, unknown>
}

export type WeChatMessageQualityReport = {
  ok: boolean
  warnings: WeChatMessageQualityWarning[]
  metrics: {
    messageCount: number
    comparableBboxCount: number
    invalidBboxCount: number
    outOfWindowBboxCount: number
    nonMonotonicPairCount: number
    duplicateKeyCount: number
  }
}

export function validateWeChatMessages(input: {
  messages: WeChatObservedMessage[]
  windowBounds?: { width: number; height: number } | null
}): WeChatMessageQualityReport {
  const warnings: WeChatMessageQualityWarning[] = []
  const comparable: Array<{ index: number; key: string; bbox: MessageBbox }> = []
  const seenKeys = new Set<string>()
  let invalidBboxCount = 0
  let outOfWindowBboxCount = 0
  let duplicateKeyCount = 0

  input.messages.forEach((message, index) => {
    const key = message.stableMessageKey || `index:${index}`
    if (seenKeys.has(key)) {
      duplicateKeyCount += 1
      warnings.push({
        code: 'message_duplicate_key',
        message: `消息 stableMessageKey 重复：${key}`,
        messageIndex: index,
        stableMessageKey: key,
      })
    } else {
      seenKeys.add(key)
    }

    if (message.bbox === undefined) return
    const bbox = comparableBbox(message.bbox)
    if (!bbox) {
      invalidBboxCount += 1
      warnings.push({
        code: 'message_bbox_invalid',
        message: '消息 bbox 不完整或数值不合理，已忽略。',
        messageIndex: index,
        stableMessageKey: key,
      })
      return
    }
    comparable.push({ index, key, bbox })
    if (input.windowBounds && bboxOutOfWindow(bbox, input.windowBounds)) {
      outOfWindowBboxCount += 1
      warnings.push({
        code: 'message_bbox_out_of_window',
        message: '消息 bbox 超出当前窗口范围，已保留但标记为低置信度。',
        messageIndex: index,
        stableMessageKey: key,
        details: { bbox },
      })
    }
  })

  let nonMonotonicPairCount = 0
  for (let i = 1; i < comparable.length; i += 1) {
    const prev = comparable[i - 1]!
    const current = comparable[i]!
    if (isVisiblyBefore(current.bbox, prev.bbox)) {
      nonMonotonicPairCount += 1
      warnings.push({
        code: 'message_order_non_monotonic',
        message: '消息顺序与可见 bbox 从上到下的顺序不一致。',
        messageIndex: current.index,
        stableMessageKey: current.key,
        details: {
          previousIndex: prev.index,
          previousStableMessageKey: prev.key,
          previousBbox: prev.bbox,
          bbox: current.bbox,
        },
      })
    }
  }

  return {
    ok: warnings.length === 0,
    warnings,
    metrics: {
      messageCount: input.messages.length,
      comparableBboxCount: comparable.length,
      invalidBboxCount,
      outOfWindowBboxCount,
      nonMonotonicPairCount,
      duplicateKeyCount,
    },
  }
}

function comparableBbox(value: unknown): MessageBbox | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const width = Number(record.width)
  const height = Number(record.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || width > 100_000 || height > 100_000) return null
  return {
    x,
    y,
    width,
    height,
    ...(typeof record.coordinateSpace === 'string' && record.coordinateSpace.trim() ? { coordinateSpace: record.coordinateSpace } : {}),
  }
}

function bboxOutOfWindow(bbox: MessageBbox, windowBounds: { width: number; height: number }): boolean {
  const width = Number(windowBounds.width)
  const height = Number(windowBounds.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  const toleranceX = Math.max(24, width * 0.08)
  const toleranceY = Math.max(24, height * 0.08)
  return bbox.x + bbox.width < -toleranceX
    || bbox.y + bbox.height < -toleranceY
    || bbox.x > width + toleranceX
    || bbox.y > height + toleranceY
}

function isVisiblyBefore(left: MessageBbox, right: MessageBbox): boolean {
  const dy = left.y - right.y
  const threshold = Math.max(8, Math.min(left.height, right.height) * 0.35)
  if (dy < -threshold) return true
  if (Math.abs(dy) <= threshold && left.x < right.x - 8) return true
  return false
}
