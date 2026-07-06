// @covers ../index.ts

import { describe, expect, it } from 'vitest'
import { normalizeStructuredMessages, stripJsonMarkdownFence } from '../index.js'

describe('model provider utilities', () => {
  it('strips json fences', () => {
    expect(stripJsonMarkdownFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}')
  })

  it('normalizes structured messages', () => {
    const messages = normalizeStructuredMessages([{ senderRole: 'me', kind: 'photo', text: 'hi' }])
    expect(messages[0]).toMatchObject({ senderRole: 'unknown', kind: 'image', normalizedText: 'hi' })
  })
})
