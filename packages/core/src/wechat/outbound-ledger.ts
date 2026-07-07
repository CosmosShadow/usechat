// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-outbound-ledger.test.ts

import fs from 'node:fs'
import path from 'node:path'
import type { WeChatChannelHumanActivityReasonCode } from './helper-protocol.js'
import { normalizeWeChatAnchorText, weChatTextSimilarity } from './anchor.js'
import type { WeChatObservedMessage } from './types.js'

export type WeChatChannelOutboundStatus =
  | 'queued'
  | 'sending'
  | 'sent_unconfirmed'
  | 'confirmed_echo'
  | 'failed'
  | 'stale'
  | 'manual_review'

export type WeChatChannelOutboundCommitStage =
  | 'queued'
  | 'open_conversation'
  | 'focus_input'
  | 'clipboard_snapshot'
  | 'clipboard_set'
  | 'paste'
  | 'before_return'
  | 'after_return'
  | 'sent'

export type WeChatChannelOutboundRecord = {
  replyId: string
  idempotencyKey: string
  bindingId: string
  runtimeId: string
  sessionId: string
  conversationName: string
  replyBaseRevision: number
  text?: string
  textNormalized?: string
  attachmentLocalRefs?: string[]
  createdAt: string
  queuedAt?: string
  sentAt?: string
  confirmedAt?: string
  sendStatus: WeChatChannelOutboundStatus
  expectedEchoAnchor?: string
  confirmedEchoAnchor?: string
  observeAttemptsAfterSent?: number
  failureCode?: string
  lastErrorSummary?: string
  deferReason?: WeChatChannelHumanActivityReasonCode | 'user_takeover_aborted' | string
  nextAttemptAt?: string
  lastAttemptAt?: string
  attemptCount?: number
  firstUserActivityBlockedAt?: string
  commitStage?: WeChatChannelOutboundCommitStage
  copyableContentRef?: string
  cancelledAt?: string
}

export type WeChatChannelOutboundLedger = {
  version: 1
  runtimeId: string
  records: WeChatChannelOutboundRecord[]
}

export type EchoClassificationResult = {
  remainingMessages: WeChatObservedMessage[]
  confirmedRecords: WeChatChannelOutboundRecord[]
  manualReviewRecords: WeChatChannelOutboundRecord[]
}

const MAX_OUTBOUND_RECORDS = 500
const MANUAL_REVIEW_AFTER_OBSERVE_ATTEMPTS = 2
const MANUAL_REVIEW_AFTER_MS = 10 * 60 * 1000

export function loadWeChatChannelOutboundLedger(filePath: string, runtimeId: string): WeChatChannelOutboundLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as WeChatChannelOutboundLedger
    if (parsed?.version === 1 && parsed.runtimeId === runtimeId && Array.isArray(parsed.records)) return parsed
  } catch {}
  return { version: 1, runtimeId, records: [] }
}

export function saveWeChatChannelOutboundLedger(filePath: string, ledger: WeChatChannelOutboundLedger): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  ledger.records = ledger.records.slice(-MAX_OUTBOUND_RECORDS)
  fs.writeFileSync(filePath, JSON.stringify(ledger, null, 2))
}

export function saveWeChatChannelOutboundLedgerMerging(filePath: string, ledger: WeChatChannelOutboundLedger): void {
  const onDisk = loadWeChatChannelOutboundLedger(filePath, ledger.runtimeId)
  const knownKeys = new Set(ledger.records.map((record) => record.idempotencyKey))
  const merged = ledger.records.concat(onDisk.records.filter((record) => !knownKeys.has(record.idempotencyKey)))
  saveWeChatChannelOutboundLedger(filePath, { ...ledger, records: merged })
}

export function enqueueWeChatOutboundReply(input: {
  ledger: WeChatChannelOutboundLedger
  replyId: string
  idempotencyKey: string
  bindingId: string
  runtimeId: string
  sessionId: string
  conversationName: string
  replyBaseRevision: number
  text?: string
  attachmentLocalRefs?: string[]
  now?: Date
}): WeChatChannelOutboundRecord {
  const existing = input.ledger.records.find((record) => record.idempotencyKey === input.idempotencyKey)
  if (existing) return existing
  const now = (input.now ?? new Date()).toISOString()
  const textNormalized = normalizeWeChatAnchorText(input.text)
  const record: WeChatChannelOutboundRecord = {
    replyId: input.replyId,
    idempotencyKey: input.idempotencyKey,
    bindingId: input.bindingId,
    runtimeId: input.runtimeId,
    sessionId: input.sessionId,
    conversationName: input.conversationName,
    replyBaseRevision: input.replyBaseRevision,
    text: normalizeOutboundTextPayload(input.text) || undefined,
    textNormalized: textNormalized || undefined,
    attachmentLocalRefs: input.attachmentLocalRefs ?? [],
    createdAt: now,
    queuedAt: now,
    sendStatus: 'queued',
    commitStage: 'queued',
    copyableContentRef: `reply:${input.replyId}`,
    expectedEchoAnchor: textNormalized || undefined,
    observeAttemptsAfterSent: 0,
  }
  input.ledger.records.push(record)
  return record
}

export function guardWeChatOutboundRevision(input: {
  record: WeChatChannelOutboundRecord
  currentLastInboundRevision: number
}): { ok: true } | { ok: false; reason: 'stale' } {
  if (input.currentLastInboundRevision <= input.record.replyBaseRevision) return { ok: true }
  input.record.sendStatus = 'stale'
  input.record.failureCode = 'reply_revision_stale'
  input.record.lastErrorSummary = 'Inbound revision advanced before reply send'
  input.record.commitStage = input.record.commitStage ?? 'queued'
  return { ok: false, reason: 'stale' }
}

export function markWeChatOutboundSending(record: WeChatChannelOutboundRecord): void {
  record.sendStatus = 'sending'
  record.failureCode = undefined
  record.lastErrorSummary = undefined
  record.deferReason = undefined
}

export function markWeChatOutboundCommitStage(
  record: WeChatChannelOutboundRecord,
  stage: WeChatChannelOutboundCommitStage,
): void {
  record.commitStage = stage
}

export function markWeChatOutboundSentUnconfirmed(record: WeChatChannelOutboundRecord, now = new Date()): void {
  record.sendStatus = 'sent_unconfirmed'
  record.sentAt = now.toISOString()
  record.commitStage = 'sent'
  record.observeAttemptsAfterSent = 0
  record.failureCode = undefined
  record.lastErrorSummary = undefined
  record.deferReason = undefined
  record.nextAttemptAt = undefined
}

export function markWeChatOutboundFailed(
  record: WeChatChannelOutboundRecord,
  failureCode: string,
  errorSummary: string,
): void {
  record.sendStatus = 'failed'
  record.failureCode = failureCode
  record.lastErrorSummary = errorSummary.slice(0, 500)
}

export function markWeChatOutboundManualReview(
  record: WeChatChannelOutboundRecord,
  failureCode: string,
  errorSummary: string,
  commitStage?: WeChatChannelOutboundCommitStage,
): void {
  record.sendStatus = 'manual_review'
  record.failureCode = failureCode
  record.lastErrorSummary = errorSummary.slice(0, 500)
  record.nextAttemptAt = undefined
  record.deferReason = undefined
  if (commitStage) record.commitStage = commitStage
}

export function markWeChatOutboundUserActiveTimeout(record: WeChatChannelOutboundRecord, now = new Date()): void {
  record.sendStatus = 'failed'
  record.failureCode = 'user_active_timeout'
  record.lastErrorSummary = 'User stayed active until outbound send wait deadline expired'
  record.nextAttemptAt = undefined
  record.deferReason = 'user_active_timeout'
  record.lastAttemptAt = now.toISOString()
}

export function cancelWeChatOutboundRecord(
  record: WeChatChannelOutboundRecord,
  reason = 'user_cancelled',
  now = new Date(),
): void {
  if (record.sendStatus !== 'queued') return
  record.sendStatus = 'failed'
  record.failureCode = reason
  record.lastErrorSummary = 'Queued outbound send was cancelled'
  record.cancelledAt = now.toISOString()
  record.nextAttemptAt = undefined
}

export function markWeChatOutboundWaitingUserIdle(input: {
  record: WeChatChannelOutboundRecord
  reasonCode: WeChatChannelHumanActivityReasonCode | 'user_activity_unknown' | 'user_takeover_aborted'
  nextAttemptAt: Date
  now?: Date
}): void {
  const now = input.now ?? new Date()
  input.record.sendStatus = 'queued'
  input.record.deferReason = input.reasonCode
  input.record.nextAttemptAt = input.nextAttemptAt.toISOString()
  input.record.lastAttemptAt = now.toISOString()
  input.record.attemptCount = (input.record.attemptCount ?? 0) + 1
  input.record.firstUserActivityBlockedAt ??= now.toISOString()
  input.record.commitStage ??= 'queued'
  input.record.failureCode = undefined
  input.record.lastErrorSummary = undefined
}

export function shouldFailWeChatOutboundForUserActiveTimeout(input: {
  record: WeChatChannelOutboundRecord
  now?: Date
  maxWaitMs: number
}): boolean {
  if (input.record.sendStatus !== 'queued') return false
  if (!input.record.firstUserActivityBlockedAt) return false
  const blockedAt = new Date(input.record.firstUserActivityBlockedAt).getTime()
  if (!Number.isFinite(blockedAt)) return false
  return (input.now ?? new Date()).getTime() - blockedAt >= input.maxWaitMs
}

export function isWeChatOutboundTerminalDeliveryStatus(record: WeChatChannelOutboundRecord): boolean {
  return record.sendStatus === 'failed' || record.sendStatus === 'manual_review' || record.sendStatus === 'confirmed_echo'
}

export function classifyWeChatOutboundEchoes(input: {
  ledger: WeChatChannelOutboundLedger
  bindingId: string
  messages: WeChatObservedMessage[]
  now?: Date
}): EchoClassificationResult {
  const now = input.now ?? new Date()
  const confirmedRecords: WeChatChannelOutboundRecord[] = []
  const manualReviewRecords: WeChatChannelOutboundRecord[] = []
  const pendingRecords = input.ledger.records.filter((record) => record.bindingId === input.bindingId && record.sendStatus === 'sent_unconfirmed')
  const consumedMessageIndexes = new Set<number>()

  for (const record of pendingRecords) {
    const matchIndex = input.messages.findIndex((message, index) => !consumedMessageIndexes.has(index) && isOutboundEcho(record, message))
    if (matchIndex >= 0) {
      consumedMessageIndexes.add(matchIndex)
      const message = input.messages[matchIndex]!
      record.sendStatus = 'confirmed_echo'
      record.confirmedAt = now.toISOString()
      record.commitStage = 'sent'
      record.confirmedEchoAnchor = normalizeWeChatAnchorText(message.anchorText || message.normalizedText || message.textExcerpt || '') || undefined
      confirmedRecords.push(record)
    }
    for (const [index, message] of input.messages.entries()) {
      if (consumedMessageIndexes.has(index)) continue
      if (isOutboundEchoFragment(record, message)) consumedMessageIndexes.add(index)
    }
    if (matchIndex >= 0) continue
    record.observeAttemptsAfterSent = (record.observeAttemptsAfterSent ?? 0) + 1
    if (shouldMoveOutboundToManualReview(record, now)) {
      record.sendStatus = 'manual_review'
      record.failureCode = 'echo_confirmation_timeout'
      record.lastErrorSummary = 'Sent reply echo was not confirmed after observe threshold'
      record.commitStage = 'sent'
      manualReviewRecords.push(record)
    }
  }

  return {
    remainingMessages: input.messages.filter((_, index) => !consumedMessageIndexes.has(index)),
    confirmedRecords,
    manualReviewRecords,
  }
}

export function suppressSelfOnlyWeChatMessages(messages: WeChatObservedMessage[]): WeChatObservedMessage[] {
  return messages.filter((message) => message.senderRole !== 'self')
}

function isOutboundEcho(record: WeChatChannelOutboundRecord, message: WeChatObservedMessage): boolean {
  if (message.senderRole !== 'self') return false
  const expected = record.expectedEchoAnchor || record.textNormalized || ''
  const actual = normalizeWeChatAnchorText(message.anchorText || message.normalizedText || message.textExcerpt || '')
  if (!expected || !actual) return false
  if (expected === actual) return true
  if (Math.min(expected.length, actual.length) < 24) return false
  return weChatTextSimilarity(expected, actual) >= 0.9
}

function isOutboundEchoFragment(record: WeChatChannelOutboundRecord, message: WeChatObservedMessage): boolean {
  const expected = record.expectedEchoAnchor || record.textNormalized || ''
  const actual = normalizeWeChatAnchorText(message.anchorText || message.normalizedText || message.textExcerpt || '')
  if (!expected || !actual) return false
  if (isOutboundEcho(record, message)) return true
  if (weChatTextSimilarity(expected, actual) >= 0.9) return true
  const compactExpected = expected.replace(/\s+/g, '')
  const compactActual = actual.replace(/\s+/g, '')
  return compactActual.length >= minOutboundEchoFragmentLength(compactActual) && compactExpected.includes(compactActual)
}

function minOutboundEchoFragmentLength(value: string): number {
  const cjkCount = Array.from(value).filter((char) => /\p{Script=Han}/u.test(char)).length
  return cjkCount >= 3 ? 4 : 8
}

function shouldMoveOutboundToManualReview(record: WeChatChannelOutboundRecord, now: Date): boolean {
  if ((record.observeAttemptsAfterSent ?? 0) >= MANUAL_REVIEW_AFTER_OBSERVE_ATTEMPTS) return true
  if (!record.sentAt) return false
  const sentAt = new Date(record.sentAt).getTime()
  return Number.isFinite(sentAt) && now.getTime() - sentAt >= MANUAL_REVIEW_AFTER_MS
}

function normalizeOutboundTextPayload(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : ''
}
