// @covers ../index.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAffirmativeSendConfirmation, main, shouldPromptBeforeSend } from '../index.js'

describe('UseChat CLI', () => {
  it('parses explicit send confirmations only', () => {
    expect(isAffirmativeSendConfirmation('yes')).toBe(true)
    expect(isAffirmativeSendConfirmation(' YES ')).toBe(true)
    expect(isAffirmativeSendConfirmation('y')).toBe(false)
    expect(isAffirmativeSendConfirmation('no')).toBe(false)
  })

  it('decides when write should prompt before sending', () => {
    expect(shouldPromptBeforeSend({ sendRequiresConfirm: true })).toBe(true)
    expect(shouldPromptBeforeSend({ sendRequiresConfirm: true, yesFlag: true })).toBe(false)
    expect(shouldPromptBeforeSend({ sendRequiresConfirm: true, shortYesFlag: true })).toBe(false)
    expect(shouldPromptBeforeSend({ sendRequiresConfirm: false })).toBe(false)
    expect(shouldPromptBeforeSend({ sendRequiresConfirm: true, dryRun: true })).toBe(false)
  })

  it('supports write --dry-run without requiring helper or model setup', async () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-')), 'config.json')
    const output = await captureConsoleLog(async () => {
      const code = await main([
        '--config',
        configPath,
        'write',
        '--app',
        'wechat',
        '--chat',
        'ABC',
        '--text',
        'hello',
        '--dry-run',
        '--json',
      ])
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      ok: true,
      app: 'wechat',
      chat: 'ABC',
      text: 'hello',
      sent: false,
      status: 'dry-run',
    })
  })

  it('supports write --file --dry-run with local attachment metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-attachment-'))
    const filePath = path.join(dir, 'brief.txt')
    fs.writeFileSync(filePath, 'brief')
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-')), 'config.json')
    const output = await captureConsoleLog(async () => {
      const code = await main([
        '--config',
        configPath,
        'write',
        '--app',
        'wechat',
        '--chat',
        'ABC',
        '--file',
        filePath,
        '--dry-run',
        '--json',
      ])
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      ok: true,
      app: 'wechat',
      chat: 'ABC',
      text: '',
      sent: false,
      status: 'dry-run',
      attachment: {
        kind: 'file',
        name: 'brief.txt',
        localPath: filePath,
      },
      attachments: [
        {
          kind: 'file',
          name: 'brief.txt',
          localPath: filePath,
        },
      ],
    })
  })


  it('supports write --dry-run with trace JSONL output', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-trace-'))
    const configPath = path.join(dir, 'config.json')
    const tracePath = path.join(dir, 'trace.jsonl')
    const output = await captureConsoleLog(async () => {
      const code = await main([
        '--config',
        configPath,
        'write',
        '--app',
        'wechat',
        '--chat',
        'ABC',
        '--text',
        'hello',
        '--dry-run',
        '--json',
        '--trace-id',
        'cli-trace-test',
        '--trace-jsonl',
        tracePath,
      ])
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      ok: true,
      sent: false,
      status: 'dry-run',
      traceId: 'cli-trace-test',
      traceSummary: {
        traceId: 'cli-trace-test',
        operation: 'write',
        status: 'ok',
        jsonlPath: tracePath,
      },
    })
    const traceLines = fs.readFileSync(tracePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(traceLines.map((line) => line.phase)).toEqual(['preflight', 'run_summary'])
  })

  it('accepts read --download auto and proceeds to model configuration checks', async () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-')), 'config.json')
    const output = await captureConsoleLog(async () => {
      const code = await main([
        '--config',
        configPath,
        '--json',
        'read',
        '--app',
        'wechat',
        '--chat',
        'ABC',
        '--format',
        'json',
        '--download',
        'auto',
      ])
      expect(code).toBe(1)
    })
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      ok: false,
      reasonCode: 'model_not_configured',
    })
    expect(parsed.reasonCode).not.toBe('download_mode_unsupported')
  })

  it('supports configuring the watch poll interval through CLI config', async () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-watch-config-')), 'config.json')
    const output = await captureConsoleLog(async () => {
      const code = await main([
        '--config',
        configPath,
        '--json',
        'config',
        'set',
        'wechat.pollIntervalMs',
        '45000',
      ])
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      ok: true,
      key: 'wechat.pollIntervalMs',
      config: {
        wechat: {
          pollIntervalMs: 45000,
        },
      },
    })
  })

  it('keeps async command errors in the JSON error contract', async () => {
    const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-cli-')), 'config.json')
    const output = await captureConsoleLog(async () => {
      const code = await main([
        '--config',
        configPath,
        '--json',
        'read',
        '--app',
        'wechat',
        '--chat',
        'ABC',
        '--format',
        'json',
      ])
      expect(code).toBe(1)
    })
    const parsed = JSON.parse(output)
    expect(parsed).toMatchObject({
      ok: false,
      reasonCode: 'model_not_configured',
    })
  })
})

async function captureConsoleLog(run: () => Promise<void>): Promise<string> {
  const originalLog = console.log
  const lines: string[] = []
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await run()
  } finally {
    console.log = originalLog
  }
  return lines.join('\n')
}
