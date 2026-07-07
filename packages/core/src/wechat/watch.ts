// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-watch.test.ts

import crypto from 'node:crypto'
import path from 'node:path'
import {
  loadWeChatChannelLedger,
  saveWeChatChannelLedger,
  updateWeChatChannelBindingLedger,
} from './ledger.js'
import type { WeChatObservedMessage, WeChatReadResult } from './types.js'
import type { WeChatRuntime } from './runtime.js'

// Copy-out from Shennian:
// packages/cli/src/channels/wechat-channel/runtime.ts
export const WECHAT_CHANNEL_DEFAULT_POLL_INTERVAL_MS = 60 * 1000
export const WECHAT_CHANNEL_MIN_POLL_INTERVAL_MS = 30 * 1000
export const WECHAT_CHANNEL_MAX_POLL_INTERVAL_MS = 5 * 60 * 1000

// Copy-out from Shennian:
// packages/cli/src/channels/wechat-channel/scheduler.ts
const WECHAT_CHANNEL_STOP_DRAIN_TIMEOUT_MS = 8_000

export type UseChatWeChatWatchRuntime = Pick<WeChatRuntime, 'read' | 'stop'>

export type UseChatWeChatWatchEmit = (event: UseChatWeChatWatchEvent) => void | Promise<void>

export type UseChatWeChatWatchOptions = {
  runtime: UseChatWeChatWatchRuntime
  chat: string
  dataDir: string
  app?: 'wechat'
  runtimeId?: string
  bindingId?: string
  ledgerPath?: string
  pollIntervalMs?: number | null
  limit?: number
  download?: 'never' | 'auto'
  traceJsonlPath?: string | null | ((input: { traceId: string; tickIndex: number }) => string | null | undefined)
  onEvent: UseChatWeChatWatchEmit
  stopRuntime?: boolean
  now?: () => Date
}

export type UseChatWeChatWatchTickResult = {
  runtimeId: string
  bindingId: string
  ledgerPath: string
  tickIndex: number
  observedCount: number
  newMessageCount: number
  revision: number
  events: UseChatWeChatWatchEvent[]
}

export type UseChatWeChatWatchEvent =
  | UseChatWeChatWatchBaselineEvent
  | UseChatWeChatWatchMessageEvent
  | UseChatWeChatWatchErrorEvent
  | UseChatWeChatWatchPausedEvent

export type UseChatWeChatWatchBaseEvent = {
  app: 'wechat'
  chat: string
  runtimeId: string
  bindingId: string
  ledgerPath: string
  tickIndex: number
  at: string
  pollIntervalMs: number
}

export type UseChatWeChatWatchBaselineEvent = UseChatWeChatWatchBaseEvent & {
  type: 'baseline'
  observedCount: number
  revision: number
  traceId?: string
  traceSummary?: WeChatReadResult['traceSummary']
}

export type UseChatWeChatWatchMessageEvent = UseChatWeChatWatchBaseEvent & {
  type: 'message'
  messageIndex: number
  stableMessageKey: string
  revision: number
  message: WeChatObservedMessage
  traceId?: string
  traceSummary?: WeChatReadResult['traceSummary']
}

export type UseChatWeChatWatchErrorEvent = UseChatWeChatWatchBaseEvent & {
  type: 'error'
  reasonCode: string
  message: string
  traceId?: string
}

export type UseChatWeChatWatchPausedEvent = UseChatWeChatWatchBaseEvent & {
  type: 'paused'
  reasonCode: string
  nextPollAt: string
}

export class UseChatWeChatWatchRunner {
  readonly runtimeId: string
  readonly bindingId: string
  readonly ledgerPath: string
  readonly pollIntervalMs: number
  private readonly now: () => Date
  private timer: NodeJS.Timeout | null = null
  private running = false
  private runningTick: Promise<void> | null = null
  private tickIndex = 0

  constructor(private options: UseChatWeChatWatchOptions) {
    this.runtimeId = options.runtimeId ?? useChatWeChatRuntimeId(options.chat)
    this.bindingId = options.bindingId ?? useChatWeChatBindingId(this.runtimeId, options.chat)
    this.ledgerPath = options.ledgerPath ?? defaultUseChatWeChatLedgerPath(options.dataDir, this.runtimeId)
    this.pollIntervalMs = normalizeUseChatWeChatWatchPollIntervalMs(options.pollIntervalMs)
    this.now = options.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    if (this.timer) return
    await this.tick()
    this.timer = setInterval(() => {
      void this.tick().catch(() => {})
    }, this.pollIntervalMs)
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const runningTick = this.runningTick
    if (runningTick) await settleWithin(runningTick, WECHAT_CHANNEL_STOP_DRAIN_TIMEOUT_MS)
    if (this.options.stopRuntime !== false) await this.options.runtime.stop().catch(() => {})
  }

  async tick(): Promise<UseChatWeChatWatchTickResult | void> {
    if (this.running) return
    this.running = true
    let releaseRunningTick = () => {}
    this.runningTick = new Promise<void>((resolve) => {
      releaseRunningTick = resolve
    })
    try {
      const result = await this.collectTickEvents()
      for (const event of result.events) await this.options.onEvent(event)
      return result
    } finally {
      releaseRunningTick()
      this.runningTick = null
      this.running = false
    }
  }

  private async collectTickEvents(): Promise<UseChatWeChatWatchTickResult> {
    const tickIndex = this.tickIndex + 1
    this.tickIndex = tickIndex
    const at = this.now().toISOString()
    const traceId = `watch-${stableHashPrefix(`${this.runtimeId}:${this.bindingId}:${tickIndex}:${at}`)}`
    const base = (): UseChatWeChatWatchBaseEvent => ({
      app: 'wechat',
      chat: this.options.chat,
      runtimeId: this.runtimeId,
      bindingId: this.bindingId,
      ledgerPath: this.ledgerPath,
      tickIndex,
      at,
      pollIntervalMs: this.pollIntervalMs,
    })

    try {
      const result = await this.options.runtime.read({
        chat: this.options.chat,
        limit: this.options.limit,
        format: 'json',
        download: this.options.download ?? 'never',
        traceId,
        traceJsonlPath: resolveWatchTraceJsonlPath(this.options.traceJsonlPath, { traceId, tickIndex }),
      })
      const ledger = loadWeChatChannelLedger(this.ledgerPath, this.runtimeId)
      const existing = ledger.bindings[this.bindingId]
      const baselineOnly = !existing?.baselineEstablished || Boolean(existing?.disabledSince)
      const state = updateWeChatChannelBindingLedger({
        ledger,
        bindingId: this.bindingId,
        observedMessages: result.messages,
        baselineOnly,
      })
      saveWeChatChannelLedger(this.ledgerPath, ledger)

      const events: UseChatWeChatWatchEvent[] = []
      if (baselineOnly) {
        events.push({
          ...base(),
          type: 'baseline',
          observedCount: result.messages.length,
          revision: state.binding.revision,
          traceId: result.traceId,
          traceSummary: result.traceSummary,
        })
      }
      state.newMessages.forEach((message, index) => {
        events.push({
          ...base(),
          type: 'message',
          messageIndex: index,
          stableMessageKey: message.stableMessageKey,
          revision: state.binding.revision,
          message,
          traceId: result.traceId,
          traceSummary: result.traceSummary,
        })
      })
      return {
        runtimeId: this.runtimeId,
        bindingId: this.bindingId,
        ledgerPath: this.ledgerPath,
        tickIndex,
        observedCount: result.messages.length,
        newMessageCount: state.newMessages.length,
        revision: state.binding.revision,
        events,
      }
    } catch (error) {
      const reasonCode = errorReasonCode(error)
      const message = error instanceof Error ? error.message : String(error)
      const nextPollAt = new Date(this.now().getTime() + this.pollIntervalMs).toISOString()
      const events: UseChatWeChatWatchEvent[] = [
        {
          ...base(),
          type: 'error',
          reasonCode,
          message,
          traceId,
        },
        {
          ...base(),
          type: 'paused',
          reasonCode,
          nextPollAt,
        },
      ]
      return {
        runtimeId: this.runtimeId,
        bindingId: this.bindingId,
        ledgerPath: this.ledgerPath,
        tickIndex,
        observedCount: 0,
        newMessageCount: 0,
        revision: 0,
        events,
      }
    }
  }
}

export function createUseChatWeChatWatchRunner(options: UseChatWeChatWatchOptions): UseChatWeChatWatchRunner {
  return new UseChatWeChatWatchRunner(options)
}

export function normalizeUseChatWeChatWatchPollIntervalMs(value?: number | null): number {
  if (!Number.isFinite(value)) return WECHAT_CHANNEL_DEFAULT_POLL_INTERVAL_MS
  return Math.min(
    WECHAT_CHANNEL_MAX_POLL_INTERVAL_MS,
    Math.max(WECHAT_CHANNEL_MIN_POLL_INTERVAL_MS, Number(value)),
  )
}

export function defaultUseChatWeChatLedgerPath(dataDir: string, runtimeId: string): string {
  return path.join(dataDir, 'ledger', 'wechat-channel', `${safeWeChatChannelRuntimePathSegment(runtimeId)}.ledger.json`)
}

export function useChatWeChatRuntimeId(conversationName: string): string {
  return stableId('usechat-wechat-watch', cleanText(conversationName))
}

export function useChatWeChatBindingId(runtimeId: string, conversationName: string): string {
  return stableId('wechat-channel-binding', `${runtimeId}\n${cleanText(conversationName)}`)
}

// Copy-out from Shennian:
// packages/cli/src/channels/wechat-rpa/product-channel.ts
export function safeWeChatChannelRuntimePathSegment(runtimeId: string): string {
  const safe = String(runtimeId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return safe || 'wechat-channel-runtime'
}

function resolveWatchTraceJsonlPath(
  value: UseChatWeChatWatchOptions['traceJsonlPath'],
  input: { traceId: string; tickIndex: number },
): string | null | undefined {
  if (typeof value === 'function') return value(input)
  return value
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

function stableHashPrefix(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function errorReasonCode(error: unknown, fallback = 'unknown_error'): string {
  if (error && typeof error === 'object') {
    const reasonCode = (error as { reasonCode?: unknown; errorCode?: unknown }).reasonCode
      ?? (error as { reasonCode?: unknown; errorCode?: unknown }).errorCode
    if (typeof reasonCode === 'string' && reasonCode.trim()) return reasonCode.trim()
  }
  const message = error instanceof Error ? error.message : String(error || '')
  const match = message.match(/^([a-z0-9_./-]+)(?::|\b)/i)
  return match?.[1] || fallback
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | null = null
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    }),
  ])
  if (timer) clearTimeout(timer)
}
