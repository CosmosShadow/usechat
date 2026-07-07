// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-ledger.test.ts

import type { WeChatObservedMessage } from './types.js'

export function normalizeWeChatAnchorText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function weChatAnchorText(message: WeChatObservedMessage): string {
  return normalizeWeChatAnchorText(message.anchorText || message.normalizedText || message.textExcerpt || '')
}

export function weChatTextSimilarity(left: unknown, right: unknown): number {
  const a = normalizeWeChatAnchorText(left)
  const b = normalizeWeChatAnchorText(right)
  if (!a || !b) return 0
  if (a === b) return 1
  const distance = levenshtein(a, b)
  return 1 - distance / Math.max(a.length, b.length)
}

export function isLikelySameWeChatMessage(
  previous: WeChatObservedMessage,
  current: WeChatObservedMessage,
  threshold = 0.95,
): boolean {
  if (previous.stableMessageKey && previous.stableMessageKey === current.stableMessageKey) return true
  if (previous.senderRole !== current.senderRole) return false
  if (previous.kind !== current.kind) return false
  const previousAnchor = weChatAnchorText(previous)
  const currentAnchor = weChatAnchorText(current)
  if (!previousAnchor || !currentAnchor) return false
  return weChatTextSimilarity(previousAnchor, currentAnchor) >= threshold
}

export function filterNewWeChatMessagesByAnchor(input: {
  previous: WeChatObservedMessage[]
  current: WeChatObservedMessage[]
  threshold?: number
}): WeChatObservedMessage[] {
  const consumed = new Set<number>()
  const result: WeChatObservedMessage[] = []
  for (const current of input.current) {
    const index = input.previous.findIndex((previous, previousIndex) => {
      return !consumed.has(previousIndex) && isLikelySameWeChatMessage(previous, current, input.threshold)
    })
    if (index >= 0) {
      consumed.add(index)
      continue
    }
    result.push(current)
  }
  return result
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, index) => index)
  const curr = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!
  }
  return prev[b.length]!
}
