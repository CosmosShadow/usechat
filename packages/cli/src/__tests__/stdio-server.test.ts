// @covers ../stdio-server.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { handleStdioLine, runUseChatStdioServer } from '../stdio-server.js'

function writeConfig(config: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-stdio-'))
  const configPath = path.join(dir, 'config.json')
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
}

function ocrOnlyConfig(): unknown {
  return {
    model: { provider: 'ocr-only' },
    wechat: { sendRequiresConfirm: true },
  }
}

describe('UseChat stdio server', () => {
  it('returns stable JSON errors for invalid requests', async () => {
    const response = await handleStdioLine('{bad json', {
      runtimeFactory: vi.fn(),
      doctorRunner: vi.fn(),
    })

    expect(response).toMatchObject({ ok: false, reasonCode: 'invalid_json' })
  })

  it('exposes the doctor tool through a stable response envelope', async () => {
    const configPath = writeConfig(ocrOnlyConfig())
    const doctorRunner = vi.fn(async () => ({
      ok: true,
      platform: 'darwin',
      checks: [],
      secretToken: 'should-be-redacted',
    }))

    const response = await handleStdioLine(JSON.stringify({
      id: 'doctor-1',
      tool: 'usechat.doctor',
      input: { configPath },
    }), {
      runtimeFactory: vi.fn(),
      doctorRunner,
    })

    expect(response).toMatchObject({
      id: 'doctor-1',
      ok: true,
      tool: 'doctor',
      result: {
        ok: true,
        platform: 'darwin',
        secretToken: 'should-be-redacted',
      },
    })
    expect(doctorRunner).toHaveBeenCalledWith(expect.objectContaining({
      checkModel: true,
      modelConfigured: true,
    }))
  })

  it('exposes the read tool without reimplementing WeChat runtime behavior', async () => {
    const configPath = writeConfig(ocrOnlyConfig())
    const read = vi.fn(async () => ({
      ok: true,
      app: 'wechat',
      chat: 'ABC',
      messages: [],
      markdown: '',
      traceId: 'trace-read',
    }))
    const stop = vi.fn(async () => undefined)
    const runtimeFactory = vi.fn(() => ({ read, write: vi.fn(), stop }))

    const response = await handleStdioLine(JSON.stringify({
      id: 2,
      method: 'read',
      params: {
        configPath,
        app: 'wechat',
        chat: 'ABC',
        limit: '2',
        format: 'json',
        download: 'auto',
        traceId: 'trace-read',
      },
    }), {
      runtimeFactory,
      doctorRunner: vi.fn(),
    })

    expect(response).toMatchObject({
      id: 2,
      ok: true,
      tool: 'read',
      result: { ok: true, app: 'wechat', chat: 'ABC', traceId: 'trace-read' },
    })
    expect(runtimeFactory).toHaveBeenCalledWith(expect.objectContaining({ provider: expect.any(Object) }))
    expect(read).toHaveBeenCalledWith({
      chat: 'ABC',
      limit: 2,
      format: 'json',
      download: 'auto',
      traceId: 'trace-read',
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('requires explicit confirmation for write in stdio mode', async () => {
    const configPath = writeConfig(ocrOnlyConfig())

    const response = await handleStdioLine(JSON.stringify({
      id: 'write-needs-confirmation',
      tool: 'write',
      input: { configPath, chat: 'ABC', text: 'hello' },
    }), {
      runtimeFactory: vi.fn(),
      doctorRunner: vi.fn(),
    })

    expect(response).toMatchObject({
      id: 'write-needs-confirmation',
      ok: false,
      tool: 'write',
      reasonCode: 'confirmation_required',
    })
  })

  it('exposes the write tool when yes is explicit', async () => {
    const configPath = writeConfig(ocrOnlyConfig())
    const write = vi.fn(async () => ({
      ok: true,
      app: 'wechat',
      chat: 'ABC',
      text: 'hello',
      attachments: [],
      sent: true,
      status: 'sent-unconfirmed',
      traceId: 'trace-write',
    }))
    const stop = vi.fn(async () => undefined)
    const runtimeFactory = vi.fn(() => ({ read: vi.fn(), write, stop }))

    const response = await handleStdioLine(JSON.stringify({
      id: 'write-1',
      tool: 'write',
      input: { configPath, chat: 'ABC', text: 'hello', yes: true, traceId: 'trace-write' },
    }), {
      runtimeFactory,
      doctorRunner: vi.fn(),
    })

    expect(response).toMatchObject({
      id: 'write-1',
      ok: true,
      tool: 'write',
      result: { sent: true, status: 'sent-unconfirmed', traceId: 'trace-write' },
    })
    expect(write).toHaveBeenCalledWith({
      chat: 'ABC',
      text: 'hello',
      file: undefined,
      image: undefined,
      video: undefined,
      yes: true,
      dryRun: false,
      traceId: 'trace-write',
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('streams JSONL responses and redacts secret-like fields', async () => {
    const configPath = writeConfig(ocrOnlyConfig())
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: Buffer[] = []
    output.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    const serverDone = runUseChatStdioServer({
      configPath,
      input,
      output,
      runtimeFactory: vi.fn(),
      doctorRunner: vi.fn(async () => ({ ok: true, platform: 'darwin', checks: [], apiKey: 'secret-value' })),
    })

    input.end(`${JSON.stringify({ id: 'doctor-jsonl', tool: 'doctor' })}\n`)
    await serverDone

    const lines = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      id: 'doctor-jsonl',
      ok: true,
      tool: 'doctor',
      result: { apiKey: '<redacted>' },
    })
  })
})
