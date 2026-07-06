// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-points.test.ts

import type { WeChatScreenPoint, WeChatScreenshot, WeChatWindowInfo } from './types.js'

export type ClassifierRect = {
  x?: number
  y?: number
  width?: number
  height?: number
  coordinateSpace?: string
} | null | undefined

export function screenPointForClassifierRect(
  rect: ClassifierRect,
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
  purpose: 'message-input' | 'search-input' = 'message-input',
): WeChatScreenPoint | null {
  const x = Number(rect?.x)
  const y = Number(rect?.y)
  const width = Number(rect?.width)
  const height = Number(rect?.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const normalizedRect = rect?.coordinateSpace === 'screen'
    ? { x, y, width, height, coordinateSpace: 'screen' as const }
    : {
        x: (x / 999) * screenshot.width,
        y: (y / 999) * screenshot.height,
        width: (width / 999) * screenshot.width,
        height: (height / 999) * screenshot.height,
        coordinateSpace: 'screenshotPixel' as const,
      }
  const yRatio = purpose === 'message-input' ? 0.28 : 0.55
  const point = screenPointForScreenshotPoint({
    x: normalizedRect.x + normalizedRect.width * 0.54,
    y: normalizedRect.y + normalizedRect.height * yRatio,
    coordinateSpace: normalizedRect.coordinateSpace,
  }, screenshot, window)
  if (!point) return null
  return { x: Math.round(point.x), y: Math.round(point.y), coordinateSpace: 'screen' }
}

export function fallbackSearchPoint(window: WeChatWindowInfo): WeChatScreenPoint | null {
  const bounds = window.bounds
  if (!bounds) return null
  return {
    x: Math.round(bounds.x + Math.max(80, bounds.width * 0.11)),
    y: Math.round(bounds.y + Math.max(48, bounds.height * 0.08)),
    coordinateSpace: 'screen',
  }
}

export function fallbackMessageInputPoint(window: WeChatWindowInfo): WeChatScreenPoint | null {
  const bounds = window.bounds
  if (!bounds) return null
  return {
    x: Math.round(bounds.x + bounds.width * 0.66),
    y: Math.round(bounds.y + bounds.height * 0.88),
    coordinateSpace: 'screen',
  }
}

function screenPointForScreenshotPoint(
  point: { x: number; y: number; coordinateSpace?: string },
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
): { x: number; y: number } | null {
  if (![point.x, point.y].every(Number.isFinite)) return null
  if (point.coordinateSpace === 'screen' || !window.bounds) return { x: point.x, y: point.y }
  const scaleX = window.bounds.width / screenshot.width
  const scaleY = window.bounds.height / screenshot.height
  return {
    x: window.bounds.x + point.x * scaleX,
    y: window.bounds.y + point.y * scaleY,
  }
}
