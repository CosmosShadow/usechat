// @covers ../wechat/trace.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createUseChatTraceRecorder, defaultUseChatTraceJsonlPath, redactTraceValue, stableHash } from '../wechat/trace.js'

describe('UseChat trace recorder', () => {
  it('writes redacted JSONL events and produces a phase summary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-trace-'))
    const jsonlPath = path.join(dir, 'trace.jsonl')
    const trace = createUseChatTraceRecorder({ traceId: 'trace1', operation: 'read', jsonlPath })

    trace.record({
      phase: 'capture_window',
      status: 'ok',
      details: {
        dataBase64: 'raw-screenshot-bytes',
        nested: { apiKey: 'secret-key', text: 'safe' },
      },
    })
    trace.record({ phase: 'validate_messages', status: 'failed', reasonCode: 'message_order_unstable' })
    const summary = trace.finish('failed', 'message_order_unstable')

    expect(summary).toMatchObject({
      traceId: 'trace1',
      operation: 'read',
      status: 'failed',
      reasonCode: 'message_order_unstable',
      failedPhase: 'validate_messages',
      jsonlPath,
    })
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatchObject({
      traceId: 'trace1',
      phase: 'capture_window',
      details: {
        dataBase64: '<omitted>',
        nested: { apiKey: '<redacted>', text: 'safe' },
      },
    })
    expect(JSON.stringify(lines)).not.toContain('raw-screenshot-bytes')
    expect(JSON.stringify(lines)).not.toContain('secret-key')
  })

  it('hashes objects stably and exposes safe default paths', () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }))
    expect(defaultUseChatTraceJsonlPath('read:ABC/1')).toMatch(/read-ABC-1\.jsonl$/)
  })

  it('redacts large strings and screenshot fields without mutating the source', () => {
    const input = { dataBase64: 'abc', token: 'secret', longText: 'x'.repeat(2100) }
    const redacted = redactTraceValue(input)
    expect(redacted).toMatchObject({
      dataBase64: '<omitted>',
      token: '<redacted>',
      longText: '<omitted:2100b>',
    })
    expect(input.token).toBe('secret')
  })
})
