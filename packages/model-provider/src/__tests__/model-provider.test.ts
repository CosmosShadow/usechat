// @covers ../index.ts

import { describe, expect, it } from 'vitest'
import { createOcrOnlyVisionProvider, createOpenAICompatibleVisionProvider, normalizeStructuredMessages, stripJsonMarkdownFence } from '../index.js'

describe('model provider utilities', () => {
  it('strips json fences', () => {
    expect(stripJsonMarkdownFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}')
  })

  it('normalizes structured messages', () => {
    const messages = normalizeStructuredMessages([
      { senderRole: 'me', kind: 'photo', text: 'hi' },
      { senderRole: 'contact', kind: 'document', text: 'file' },
      { senderRole: 'self', kind: 'video-card', text: 'card' },
    ])
    expect(messages[0]).toMatchObject({ senderRole: 'unknown', kind: 'image', normalizedText: 'hi' })
    expect(messages[1]).toMatchObject({ senderRole: 'contact', kind: 'file', normalizedText: 'file' })
    expect(messages[2]).toMatchObject({ senderRole: 'self', kind: 'video-card', normalizedText: 'card' })
  })

  it('supports ocr-only fallback provider', async () => {
    const provider = createOcrOnlyVisionProvider()
    const result = await provider.structureVisibleWindow({ screenshots: [], edgeOcrBlocks: [{ text: 'ABC hello' }] })
    expect(result.structuredMessages[0]).toMatchObject({ normalizedText: 'ABC hello', senderRole: 'unknown' })
  })

  it('reports invalid model JSON with a stable reason code', async () => {
    const provider = createOpenAICompatibleVisionProvider({
      baseUrl: 'https://example.test/v1',
      model: 'vision-model',
      apiKeyEnv: 'TEST_USECHAT_KEY',
      env: { TEST_USECHAT_KEY: 'test-key' } as NodeJS.ProcessEnv,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 }),
    })
    await expect(provider.structureVisibleWindow({ screenshots: [] })).rejects.toMatchObject({ reasonCode: 'model_invalid_json' })
  })

  it('reports empty model messages with a stable reason code', async () => {
    const provider = createOpenAICompatibleVisionProvider({
      baseUrl: 'https://example.test/v1',
      model: 'vision-model',
      apiKeyEnv: 'TEST_USECHAT_KEY',
      env: { TEST_USECHAT_KEY: 'test-key' } as NodeJS.ProcessEnv,
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{\"structuredMessages\":[]}' } }] }), { status: 200 }),
    })
    await expect(provider.structureVisibleWindow({ screenshots: [] })).rejects.toMatchObject({ reasonCode: 'model_no_messages' })
  })

  it('disables thinking for DashScope Qwen models', async () => {
    let requestBody: Record<string, unknown> | null = null
    const provider = createOpenAICompatibleVisionProvider({
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.5-flash',
      apiKeyEnv: 'TEST_USECHAT_KEY',
      env: { TEST_USECHAT_KEY: 'test-key' } as NodeJS.ProcessEnv,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"structuredMessages":[{"senderRole":"contact","kind":"text","normalizedText":"hi"}]}' } }] }), { status: 200 })
      },
    })
    await provider.structureVisibleWindow({ screenshots: [] })
    expect(requestBody).toMatchObject({ enable_thinking: false })
  })
})
