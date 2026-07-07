// @covers ../wechat/watch.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createUseChatWeChatWatchRunner,
  defaultUseChatWeChatLedgerPath,
  normalizeUseChatWeChatWatchPollIntervalMs,
  safeWeChatChannelRuntimePathSegment,
  type UseChatWeChatWatchEvent,
  type UseChatWeChatWatchRuntime,
} from '../wechat/watch.js'
import type { WeChatObservedMessage, WeChatReadResult } from '../wechat/types.js'

describe('UseChat WeChat watch runner', () => {
  it('emits an initial baseline event without replaying existing messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-watch-'))
    const events: UseChatWeChatWatchEvent[] = []
    const runtime = fakeRuntime([
      [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
      ],
    ])
    const runner = createUseChatWeChatWatchRunner({
      runtime,
      chat: 'ABC',
      dataDir: dir,
      onEvent: (event) => events.push(event),
      now: fixedClock('2026-07-07T00:00:00.000Z'),
    })

    const result = await runner.tick()

    expect(result).toMatchObject({ observedCount: 1, newMessageCount: 0, revision: 0 })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'baseline',
        app: 'wechat',
        chat: 'ABC',
        observedCount: 1,
        revision: 0,
      }),
    ])
    expect(fs.existsSync(runner.ledgerPath)).toBe(true)
  })

  it('diffs by the copied-out Shennian ledger and emits only deliverable new messages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-watch-'))
    const events: UseChatWeChatWatchEvent[] = []
    const runtime = fakeRuntime([
      [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
      ],
      [
        { stableMessageKey: 'old', senderRole: 'contact', kind: 'text', anchorText: 'old' },
        { stableMessageKey: 'self-echo', senderRole: 'self', kind: 'text', anchorText: 'sent by me' },
        { stableMessageKey: 'new', senderRole: 'contact', kind: 'text', anchorText: 'new message' },
      ],
    ])
    const runner = createUseChatWeChatWatchRunner({
      runtime,
      chat: 'ABC',
      dataDir: dir,
      onEvent: (event) => events.push(event),
      now: fixedClock('2026-07-07T00:00:00.000Z'),
    })

    await runner.tick()
    const second = await runner.tick()

    expect(second).toMatchObject({ observedCount: 3, newMessageCount: 1, revision: 1 })
    expect(events.map((event) => event.type)).toEqual(['baseline', 'message'])
    expect(events[1]).toMatchObject({
      type: 'message',
      stableMessageKey: 'new',
      revision: 1,
      message: {
        stableMessageKey: 'new',
        senderRole: 'contact',
        anchorText: 'new message',
      },
    })
  })

  it('emits error and paused events without crashing the polling loop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-watch-'))
    const events: UseChatWeChatWatchEvent[] = []
    const runtime: UseChatWeChatWatchRuntime = {
      read: async () => {
        throw new Error('wechat_login_required: login required')
      },
      stop: async () => {},
    }
    const runner = createUseChatWeChatWatchRunner({
      runtime,
      chat: 'ABC',
      dataDir: dir,
      onEvent: (event) => events.push(event),
      pollIntervalMs: 1,
      now: fixedClock('2026-07-07T00:00:00.000Z'),
    })

    const result = await runner.tick()

    expect(result).toMatchObject({ observedCount: 0, newMessageCount: 0 })
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', reasonCode: 'wechat_login_required' }),
      expect.objectContaining({ type: 'paused', reasonCode: 'wechat_login_required', nextPollAt: '2026-07-07T00:00:30.000Z' }),
    ])
  })

  it('uses Shennian-compatible poll interval clamps and Windows-safe ledger filenames', () => {
    expect(normalizeUseChatWeChatWatchPollIntervalMs(undefined)).toBe(60_000)
    expect(normalizeUseChatWeChatWatchPollIntervalMs(1)).toBe(30_000)
    expect(normalizeUseChatWeChatWatchPollIntervalMs(10 * 60_000)).toBe(5 * 60_000)
    expect(safeWeChatChannelRuntimePathSegment('wechat-rpa:test')).toBe('wechat-rpa_test')
    expect(defaultUseChatWeChatLedgerPath('/tmp/usechat', 'wechat-rpa:test')).toBe(
      path.join('/tmp/usechat', 'ledger', 'wechat-channel', 'wechat-rpa_test.ledger.json'),
    )
  })
})

function fakeRuntime(windows: WeChatObservedMessage[][]): UseChatWeChatWatchRuntime {
  let index = 0
  return {
    read: async (input): Promise<WeChatReadResult> => {
      const messages = windows[Math.min(index, windows.length - 1)] ?? []
      index += 1
      return {
        ok: true,
        app: 'wechat',
        chat: input.chat,
        messages,
        markdown: '',
        traceId: input.traceId ?? `trace-${index}`,
      }
    },
    stop: async () => {},
  }
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso)
}
