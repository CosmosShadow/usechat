// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-trace.test.ts

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defaultUseChatDataDir, redactSecrets } from '../config.js'
import type { WeChatChannelHelperRequestTraceEvent } from './helper-client.js'

export type UseChatTracePhase =
  | 'preflight'
  | 'open_conversation'
  | 'capture_window'
  | 'structure_window_request'
  | 'structure_window_response'
  | 'normalize_messages'
  | 'media_resolve_attempt'
  | 'validate_messages'
  | 'send_enqueue'
  | 'send_submit'
  | 'helper_request'
  | 'helper_response'
  | 'helper_error'
  | 'run_summary'

export type UseChatTraceEvent = {
  traceId: string
  phase: UseChatTracePhase
  status: 'ok' | 'pending' | 'failed' | 'skipped'
  at: string
  operation?: 'read' | 'write' | 'doctor' | string
  reasonCode?: string
  latencyMs?: number
  inputHash?: string
  outputHash?: string
  command?: string
  messageCount?: number
  attachmentCount?: number
  mediaCount?: number
  details?: Record<string, unknown>
}

export type UseChatTraceSummary = {
  traceId: string
  operation?: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  status: 'ok' | 'failed' | 'pending'
  reasonCode?: string
  eventCount: number
  failedPhase?: string
  phases: Array<{
    phase: string
    status: 'ok' | 'pending' | 'failed' | 'skipped'
    reasonCode?: string
    latencyMs?: number
    command?: string
  }>
  jsonlPath?: string
}

export type UseChatTraceRecorderOptions = {
  traceId: string
  operation?: string
  enabled?: boolean
  jsonlPath?: string
  now?: () => Date
}

export type UseChatTraceRecorder = {
  readonly traceId: string
  readonly jsonlPath?: string
  record(event: Omit<UseChatTraceEvent, 'traceId' | 'at' | 'operation'> & { at?: string; operation?: string }): void
  recordHelperEvent(event: WeChatChannelHelperRequestTraceEvent): void
  finish(status?: 'ok' | 'failed' | 'pending', reasonCode?: string): UseChatTraceSummary
  summary(status?: 'ok' | 'failed' | 'pending', reasonCode?: string): UseChatTraceSummary
  events(): UseChatTraceEvent[]
}

const SCREENSHOT_KEYS = /^(dataBase64|screenshot|capture)$/i
const SECRETISH_KEYS = /(api[_-]?key|token|secret|password|credential)/i

export function defaultUseChatTraceDir(): string {
  return path.join(defaultUseChatDataDir(), 'traces')
}

export function defaultUseChatTraceJsonlPath(traceId: string): string {
  return path.join(defaultUseChatTraceDir(), `${safeTraceFileName(traceId)}.jsonl`)
}

export function createUseChatTraceRecorder(options: UseChatTraceRecorderOptions): UseChatTraceRecorder {
  const enabled = options.enabled !== false
  const started = options.now?.() ?? new Date()
  const events: UseChatTraceEvent[] = []
  let finished: Date | null = null
  const jsonlPath = enabled ? options.jsonlPath : undefined

  function writeEvent(event: UseChatTraceEvent): void {
    if (!enabled) return
    events.push(event)
    if (!jsonlPath) return
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true })
    fs.appendFileSync(jsonlPath, `${JSON.stringify(redactTraceValue(event))}\n`, 'utf8')
  }

  const recorder: UseChatTraceRecorder = {
    traceId: options.traceId,
    jsonlPath,
    record(event) {
      writeEvent({
        ...event,
        traceId: options.traceId,
        at: event.at ?? (options.now?.() ?? new Date()).toISOString(),
        operation: event.operation ?? options.operation,
        details: sanitizeTraceDetails(event.details),
      })
    },
    recordHelperEvent(event) {
      const phase = event.phase === 'request'
        ? 'helper_request'
        : event.phase === 'response'
          ? 'helper_response'
          : 'helper_error'
      recorder.record({
        phase,
        status: event.phase === 'error' || event.ok === false ? 'failed' : event.phase === 'request' ? 'pending' : 'ok',
        command: event.command,
        reasonCode: event.errorCode,
        latencyMs: event.durationMs ?? event.latencyMs,
        inputHash: event.params ? stableHash(redactTraceValue(event.params)) : undefined,
        outputHash: event.result ? stableHash(redactTraceValue(event.result)) : undefined,
        details: {
          helperRequestId: event.id,
          timeoutMs: event.timeoutMs,
          errorSummary: event.errorSummary,
        },
      })
    },
    finish(status = 'ok', reasonCode) {
      if (!finished) {
        finished = options.now?.() ?? new Date()
        recorder.record({ phase: 'run_summary', status, reasonCode })
      }
      return recorder.summary(status, reasonCode)
    },
    summary(status = 'pending', reasonCode) {
      const end = finished ?? (options.now?.() ?? new Date())
      const failed = events.find((event) => event.status === 'failed')
      const finalStatus = status === 'ok' && failed ? 'failed' : status
      return {
        traceId: options.traceId,
        ...(options.operation ? { operation: options.operation } : {}),
        startedAt: started.toISOString(),
        ...(finished ? { finishedAt: finished.toISOString() } : {}),
        durationMs: end.getTime() - started.getTime(),
        status: finalStatus,
        reasonCode: reasonCode ?? failed?.reasonCode,
        eventCount: events.length,
        failedPhase: failed?.phase,
        phases: events.map((event) => ({
          phase: event.phase,
          status: event.status,
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
          ...(typeof event.latencyMs === 'number' ? { latencyMs: event.latencyMs } : {}),
          ...(event.command ? { command: event.command } : {}),
        })),
        ...(jsonlPath ? { jsonlPath } : {}),
      }
    },
    events() {
      return [...events]
    },
  }
  return recorder
}

export function stableHash(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`
}

export function redactTraceValue(value: unknown): unknown {
  return redactSecrets(stripLargeAndSensitiveFields(value))
}

function sanitizeTraceDetails(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const sanitized = redactTraceValue(value)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized as Record<string, unknown> : undefined
}

function stripLargeAndSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripLargeAndSensitiveFields)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SCREENSHOT_KEYS.test(key)) {
      out[key] = '<omitted>'
      continue
    }
    if (SECRETISH_KEYS.test(key) && !/Env$/i.test(key)) {
      out[key] = typeof child === 'string' && child.length ? '<redacted>' : child
      continue
    }
    if (typeof child === 'string' && child.length > 2_000) {
      out[key] = `<omitted:${Buffer.byteLength(child, 'utf8')}b>`
      continue
    }
    out[key] = stripLargeAndSensitiveFields(child)
  }
  return out
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!value || typeof value !== 'object') return JSON.stringify(value)
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`
}

function safeTraceFileName(traceId: string): string {
  return traceId.replace(/[^a-z0-9_.-]+/gi, '-').slice(0, 120) || 'trace'
}
