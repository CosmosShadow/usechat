// @covers ../wechat/points.ts

import { describe, expect, it } from 'vitest'
import { fallbackMessageInputPoint, screenPointForClassifierRect } from '../wechat/points.js'

describe('wechat point conversion', () => {
  it('uses screenshot bounds when converting normalized classifier rects', () => {
    const point = screenPointForClassifierRect(
      { x: 500, y: 800, width: 100, height: 100, coordinateSpace: 'normalized-0-999' },
      {
        mimeType: 'image/png',
        dataBase64: 'x',
        width: 1000,
        height: 1000,
        bounds: { x: -10, y: 20, width: 2000, height: 1200 },
      },
      {
        windowId: 'old',
        bounds: { x: 100, y: 100, width: 800, height: 600 },
      },
      'message-input',
    )
    expect(point).toEqual({ x: 1099, y: 1015, coordinateSpace: 'screen' })
  })

  it('aims fallback message input point inside the editable composer band', () => {
    expect(fallbackMessageInputPoint({
      windowId: 'wechat',
      bounds: { x: 31, y: 70, width: 1010, height: 1208, coordinateSpace: 'screen' },
    })).toEqual({ x: 718, y: 1121, coordinateSpace: 'screen' })
  })
})
