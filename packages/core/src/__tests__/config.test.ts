// @covers ../config.ts

import { describe, expect, it } from 'vitest'
import { defaultUseChatConfigPath, redactSecrets, setConfigValue, validateUseChatConfig } from '../config.js'

describe('UseChat config', () => {
  it('uses ~/.usechat/config.json by default', () => {
    expect(defaultUseChatConfigPath({ homedir: '/tmp/home', env: {} })).toBe('/tmp/home/.usechat/config.json')
  })

  it('rejects raw api keys in apiKeyEnv', () => {
    const config = setConfigValue({
      model: {},
      helper: {},
      output: { defaultFormat: 'markdown' },
      wechat: { sendRequiresConfirm: true },
      dataDir: '/tmp/usechat',
    }, 'model.apiKeyEnv', 'OPENAI_API_KEY')
    expect(config.model.apiKeyEnv).toBe('OPENAI_API_KEY')
    expect(() => setConfigValue(config, 'model.apiKeyEnv', 'sk-secret')).toThrow(/apiKeyEnv/)
  })

  it('redacts secret-like fields', () => {
    expect(redactSecrets({ apiKey: 'abc', nested: { token: 'def', safe: 'x' } })).toEqual({
      apiKey: '<redacted>',
      nested: { token: '<redacted>', safe: 'x' },
    })
  })

  it('does not redact apiKeyEnv names', () => {
    expect(redactSecrets({ apiKeyEnv: 'OPENAI_API_KEY' })).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' })
  })

  it('validates model setup', () => {
    const result = validateUseChatConfig({ dataDir: '/tmp/usechat' }, { env: {}, homedir: '/tmp/home' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.map((issue) => issue.reasonCode)).toContain('model_provider_missing')
  })

  it('allows local ocr-only provider for smoke reads', () => {
    const result = validateUseChatConfig({ model: { provider: 'ocr-only' }, dataDir: '/tmp/usechat' }, { env: {}, homedir: '/tmp/home' })
    expect(result.ok).toBe(true)
  })
})
