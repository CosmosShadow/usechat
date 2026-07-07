// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-outbound-sender.test.ts

import fs from 'node:fs'
import path from 'node:path'
import type { HelperTransport } from './runtime.js'
import type { WeChatScreenPoint } from './types.js'
import { waitForWeChatChannelPacing } from './pacing.js'
import {
  guardWeChatOutboundRevision,
  markWeChatOutboundFailed,
  markWeChatOutboundManualReview,
  markWeChatOutboundCommitStage,
  markWeChatOutboundSending,
  markWeChatOutboundSentUnconfirmed,
  markWeChatOutboundUserActiveTimeout,
  markWeChatOutboundWaitingUserIdle,
  shouldFailWeChatOutboundForUserActiveTimeout,
  type WeChatChannelOutboundLedger,
  type WeChatChannelOutboundRecord,
  type WeChatChannelOutboundCommitStage,
} from './outbound-ledger.js'
import {
  decideWeChatChannelActivityGate,
  nextWeChatChannelActivityRetryAt,
  normalizeWeChatChannelActivitySnapshot,
  type WeChatChannelActivityGatePolicy,
} from './human-coordination.js'
import type { WeChatChannelHumanActivityReasonCode, WeChatChannelHumanActivitySnapshot } from './helper-protocol.js'

const DEFAULT_WECHAT_OUTBOUND_USER_ACTIVITY_WAIT_MS = 10 * 60 * 1000
const DEFAULT_WECHAT_OUTBOUND_FOCUS_SETTLE_MS = 520

function focusSingleCallEnabled(): boolean {
  return process.env.USECHAT_WECHAT_FOCUS_SINGLE_CALL !== '0' && process.env.SHENNIAN_WECHAT_FOCUS_SINGLE_CALL !== '0'
}

export type WeChatChannelOutboundSendResult = {
  sentRecords: WeChatChannelOutboundRecord[]
  staleRecords: WeChatChannelOutboundRecord[]
  failedRecords: WeChatChannelOutboundRecord[]
  waitingRecords: WeChatChannelOutboundRecord[]
  manualReviewRecords: WeChatChannelOutboundRecord[]
}

export async function sendQueuedWeChatOutboundRecords(input: {
  ledger: WeChatChannelOutboundLedger
  bindingId: string
  currentLastInboundRevision: number
  sender: WeChatChannelOutboundSender
  now?: Date
  maxUserActivityWaitMs?: number
}): Promise<WeChatChannelOutboundSendResult> {
  const result: WeChatChannelOutboundSendResult = {
    sentRecords: [],
    staleRecords: [],
    failedRecords: [],
    waitingRecords: [],
    manualReviewRecords: [],
  }
  const now = input.now ?? new Date()
  const maxUserActivityWaitMs = input.maxUserActivityWaitMs ?? DEFAULT_WECHAT_OUTBOUND_USER_ACTIVITY_WAIT_MS
  const queued = input.ledger.records.filter((record) => record.bindingId === input.bindingId && record.sendStatus === 'queued')
  for (const record of queued) {
    if (shouldFailWeChatOutboundForUserActiveTimeout({ record, now, maxWaitMs: maxUserActivityWaitMs })) {
      markWeChatOutboundUserActiveTimeout(record, now)
      result.failedRecords.push(record)
      continue
    }
    const guard = guardWeChatOutboundRevision({
      record,
      currentLastInboundRevision: input.currentLastInboundRevision,
    })
    if (!guard.ok) {
      result.staleRecords.push(record)
      continue
    }
    try {
      const startDecision = await input.sender.canStart(record, now)
      if (startDecision.ok === false) {
        markWeChatOutboundWaitingUserIdle({
          record,
          reasonCode: startDecision.reasonCode,
          nextAttemptAt: startDecision.nextAttemptAt,
          now,
        })
        if (shouldFailWeChatOutboundForUserActiveTimeout({ record, now, maxWaitMs: maxUserActivityWaitMs })) {
          markWeChatOutboundUserActiveTimeout(record, now)
          result.failedRecords.push(record)
        } else {
          result.waitingRecords.push(record)
        }
        continue
      }
      markWeChatOutboundSending(record)
      await input.sender.send(record)
      markWeChatOutboundSentUnconfirmed(record, now)
      result.sentRecords.push(record)
    } catch (error) {
      if (error instanceof WeChatChannelUserTakeoverAbort) {
        if (shouldManualReviewAfterTakeover(error)) {
          markWeChatOutboundManualReview(
            record,
            'user_takeover_before_return',
            'User activity was detected after paste and before Return; manual WeChat inspection is required',
            error.stage,
          )
          result.manualReviewRecords.push(record)
          continue
        }
        markWeChatOutboundWaitingUserIdle({
          record,
          reasonCode: error.reasonCode,
          nextAttemptAt: error.nextAttemptAt,
          now,
        })
        if (shouldFailWeChatOutboundForUserActiveTimeout({ record, now, maxWaitMs: maxUserActivityWaitMs })) {
          markWeChatOutboundUserActiveTimeout(record, now)
          result.failedRecords.push(record)
        } else {
          result.waitingRecords.push(record)
        }
        continue
      }
      markWeChatOutboundFailed(record, classifyOutboundSendFailure(error), error instanceof Error ? error.message : String(error))
      result.failedRecords.push(record)
    }
  }
  return result
}

export class WeChatChannelOutboundSender {
  private activeAutomationLeaseId: string | null = null
  private focus?: { windowId?: string; inputPoint?: WeChatScreenPoint | null }
  private windowsTextClipboardPrimed = false

  constructor(private options: {
    helper: HelperTransport
    openConversation: (conversationName: string) => Promise<{ opened: boolean; reason: string; windowId?: string | null; inputPoint?: WeChatScreenPoint | null }>
    traceId?: string
    activityGatePolicy?: Partial<WeChatChannelActivityGatePolicy>
    takeoverCheck?: boolean
    platform?: NodeJS.Platform | string
    postPasteSettleMs?: number
    onAfterPaste?: (input: { record: WeChatChannelOutboundRecord; kind: 'text' | 'attachment' }) => Promise<void> | void
  }) {}

  async canStart(_record: WeChatChannelOutboundRecord, now = new Date()): Promise<{
    ok: true
  } | {
    ok: false
    reasonCode: WeChatChannelHumanActivityReasonCode
    nextAttemptAt: Date
  }> {
    const snapshot = await this.activitySnapshot()
    await assertMacInputPermissions(this.options.helper, snapshot, this.options.platform, this.options.traceId)
    const decision = decideWeChatChannelActivityGate({
      snapshot,
      stage: 'send_start',
      policy: this.options.activityGatePolicy,
    })
    if (decision.ok === false) {
      return {
        ok: false,
        reasonCode: decision.reasonCode,
        nextAttemptAt: nextWeChatChannelActivityRetryAt(now, decision.waitMs),
      }
    }
    return { ok: true }
  }

  async send(record: WeChatChannelOutboundRecord): Promise<void> {
    await this.withAutomationLease(record, () => this.sendWithLease(record))
  }

  private async sendWithLease(record: WeChatChannelOutboundRecord): Promise<void> {
    await this.ensureStageIdle(record, 'open_conversation')
    markWeChatOutboundCommitStage(record, 'open_conversation')
    const opened = await this.options.openConversation(record.conversationName)
    if (!opened.opened) throw new Error(opened.reason || 'conversation_not_opened')
    if (requiresVisionInputPoint(this.options.platform) && !opened.inputPoint) {
      throw new Error('wechat_message_input_point_required: Windows send requires a vision-detected message input point')
    }

    markWeChatOutboundCommitStage(record, 'focus_input')
    this.focus = {
      windowId: opened.windowId ?? undefined,
      inputPoint: opened.inputPoint ?? undefined,
    }
    await this.focusMessageInputWithRetry(record)

    await this.ensureStageIdle(record, 'clipboard_snapshot')
    markWeChatOutboundCommitStage(record, 'clipboard_snapshot')
    const snapshot = await this.options.helper.request('clipboard.snapshot', {}, this.options.traceId)
    assertHelperOk(snapshot, 'clipboard.snapshot')
    let committedSend = false
    try {
      await this.sendTextIfPresent(record, () => {
        committedSend = true
      })
      await this.sendAttachmentsIfPresent(record, () => {
        committedSend = true
      })
    } finally {
      const restoreParams = snapshot.result && typeof snapshot.result === 'object'
        ? snapshot.result as Record<string, unknown>
        : {}
      const restore = await this.options.helper.request('clipboard.restore', restoreParams, this.options.traceId)
      if (!committedSend) {
        assertHelperOk(restore, 'clipboard.restore')
      }
    }
  }

  private async sendTextIfPresent(
    record: WeChatChannelOutboundRecord,
    noteCommitted: () => void,
  ): Promise<void> {
    if (!record.text) return
    if (shouldUseAtomicPasteAndSubmit(this.options.platform)) {
      await this.ensureStageIdle(record, 'clipboard_set')
      markWeChatOutboundCommitStage(record, 'clipboard_set')
      await this.ensureStageIdle(record, 'paste')
      markWeChatOutboundCommitStage(record, 'paste')
      const submitted = await this.options.helper.request('wechat.pasteAndSubmit', {
        text: record.text,
        waitMs: DEFAULT_WECHAT_OUTBOUND_FOCUS_SETTLE_MS,
        pasteWaitMs: this.options.postPasteSettleMs ?? 900,
        ...(this.focus?.windowId ? { windowId: this.focus.windowId } : {}),
        ...(this.focus?.inputPoint ? { inputPoint: this.focus.inputPoint } : {}),
      }, this.options.traceId)
      assertHelperOk(submitted, 'wechat.pasteAndSubmit')
      noteCommitted()
      markWeChatOutboundCommitStage(record, 'after_return')
      return
    }
    await this.ensureStageIdle(record, 'clipboard_set')
    markWeChatOutboundCommitStage(record, 'clipboard_set')
    if (!shouldSkipTextClearBeforePaste(this.options.platform)) {
      await pressShortcut(this.options.helper, 'a', pasteModifiersForPlatform(this.options.platform), this.options.traceId)
      await pressShortcut(this.options.helper, 'backspace', [], this.options.traceId)
    }
    const setText = await this.options.helper.request('clipboard.setText', { text: record.text }, this.options.traceId)
    assertHelperOk(setText, 'clipboard.setText')
    if (shouldRefocusAfterClipboardSet(this.options.platform)) {
      await this.focusMessageInputWithRetry(record, 'clipboard_set')
    }
    await this.ensureStageIdle(record, 'paste')
    markWeChatOutboundCommitStage(record, 'paste')
    await this.primeWindowsTextPasteIfNeeded(record)
    await pressShortcut(this.options.helper, 'v', pasteModifiersForPlatform(this.options.platform), this.options.traceId)
    await this.waitAfterPaste(record)
    await this.options.onAfterPaste?.({ record, kind: 'text' })
    await this.ensureStageIdle(record, 'before_return')
    markWeChatOutboundCommitStage(record, 'before_return')
    await pressShortcut(this.options.helper, 'return', [], this.options.traceId)
    noteCommitted()
    markWeChatOutboundCommitStage(record, 'after_return')
  }

  private async primeWindowsTextPasteIfNeeded(record: WeChatChannelOutboundRecord): Promise<void> {
    if (!shouldPrimeWindowsTextPaste(this.options.platform) || this.windowsTextClipboardPrimed) return
    const primed = await this.options.helper.request('keyboard.primeTextPaste', {}, this.options.traceId)
    assertHelperOk(primed, 'keyboard.primeTextPaste')
    this.windowsTextClipboardPrimed = true
    await this.ensureStageIdle(record, 'paste')
  }

  private async sendAttachmentsIfPresent(record: WeChatChannelOutboundRecord, noteCommitted: () => void): Promise<void> {
    for (const attachmentPath of record.attachmentLocalRefs ?? []) {
      assertReadableLocalFile(attachmentPath)
      await this.ensureStageIdle(record, 'clipboard_set')
      markWeChatOutboundCommitStage(record, 'clipboard_set')
      const attachmentKind = detectAttachmentKind(attachmentPath)
      const setClipboard = attachmentKind === 'image' && shouldUseImageClipboard(this.options.platform)
        ? await this.options.helper.request('clipboard.setImage', { filePath: attachmentPath }, this.options.traceId)
        : await this.options.helper.request('clipboard.setFiles', { filePaths: [attachmentPath] }, this.options.traceId)
      assertHelperOk(setClipboard, attachmentKind === 'image' && shouldUseImageClipboard(this.options.platform) ? 'clipboard.setImage' : 'clipboard.setFiles')
      await this.ensureStageIdle(record, 'paste')
      markWeChatOutboundCommitStage(record, 'paste')
      await pressShortcut(this.options.helper, 'v', pasteModifiersForPlatform(this.options.platform), this.options.traceId)
      await this.waitAfterPaste(record)
      await this.options.onAfterPaste?.({ record, kind: 'attachment' })
      await this.ensureStageIdle(record, 'before_return')
      markWeChatOutboundCommitStage(record, 'before_return')
      await pressShortcut(this.options.helper, 'return', [], this.options.traceId)
      noteCommitted()
      markWeChatOutboundCommitStage(record, 'after_return')
    }
  }

  private async withAutomationLease(record: WeChatChannelOutboundRecord, run: () => Promise<void>): Promise<void> {
    const lease = await this.options.helper.request<{ leaseId?: string }>('automation.lease.acquire', {
      owner: 'wechat-channel',
      purpose: `send:${record.bindingId}`,
      ttlMs: 60_000,
    }, this.options.traceId)
    assertHelperOk(lease, 'automation.lease.acquire')
    const leaseId = typeof lease.result?.leaseId === 'string' ? lease.result.leaseId : ''
    try {
      this.activeAutomationLeaseId = leaseId || null
      await run()
    } finally {
      this.activeAutomationLeaseId = null
      if (leaseId) {
        await this.releaseAutomationLease(leaseId)
      }
    }
  }

  private async releaseAutomationLease(leaseId: string): Promise<void> {
    try {
      await this.options.helper.request('automation.lease.release', { leaseId }, this.options.traceId)
    } catch {
      // Lease release is best-effort after the send attempt. A stuck helper release
      // should not turn an already committed Return keypress into a failed send.
    }
  }

  private async waitAfterPaste(record: WeChatChannelOutboundRecord): Promise<void> {
    const defaultSettleMs = (this.options.platform ?? process.platform) === 'win32' ? 1000 : undefined
    await waitForWeChatChannelPacing(
      'send-post-paste',
      `${this.options.traceId || ''}:${record.replyId}:post-paste`,
      this.options.postPasteSettleMs ?? defaultSettleMs,
    )
  }

  private async focusMessageInputWithRetry(record: WeChatChannelOutboundRecord, stage: WeChatChannelOutboundCommitStage = 'focus_input'): Promise<void> {
    await focusMessageInputWithRetry(this.options.helper, this.options.traceId, normalizeFocusForHelper(this.focus))
    await this.ensureStageIdle(record, stage)
  }

  private async ensureStageIdle(
    record: WeChatChannelOutboundRecord,
    stage: WeChatChannelOutboundCommitStage,
  ): Promise<void> {
    if (this.options.takeoverCheck === false) return
    if (this.activeAutomationLeaseId) {
      const leaseDecision = await this.automationLeaseDecision()
      if (leaseDecision.ok === false) {
        throw new WeChatChannelUserTakeoverAbort({
          reasonCode: leaseDecision.reasonCode,
          nextAttemptAt: leaseDecision.nextAttemptAt,
          stage,
          replyId: record.replyId,
        })
      }
      return
    }
    const snapshot = await this.activitySnapshot()
    const decision = decideWeChatChannelActivityGate({
      snapshot,
      stage: stageToActivityGateStage(stage),
      policy: this.options.activityGatePolicy,
    })
    if (decision.ok) return
    throw new WeChatChannelUserTakeoverAbort({
      reasonCode: decision.reasonCode,
      nextAttemptAt: nextWeChatChannelActivityRetryAt(new Date(), decision.waitMs),
      stage,
      replyId: record.replyId,
    })
  }

  private async activitySnapshot(): Promise<WeChatChannelHumanActivitySnapshot | null> {
    const response = await this.options.helper.request('activity.snapshot', {}, this.options.traceId)
    assertHelperOk(response, 'activity.snapshot')
    return normalizeWeChatChannelActivitySnapshot(response.result)
  }

  private async automationLeaseDecision(): Promise<{
    ok: true
  } | {
    ok: false
    reasonCode: WeChatChannelHumanActivityReasonCode
    nextAttemptAt: Date
  }> {
    if (!this.activeAutomationLeaseId) return { ok: true }
    const response = await this.options.helper.request<{
      active?: boolean
      leaseId?: string
      interrupted?: boolean
      interruptReason?: string
    }>('automation.lease.status', {}, this.options.traceId)
    assertHelperOk(response, 'automation.lease.status')
    const result = response.result ?? {}
    if (result.active === false || result.leaseId !== this.activeAutomationLeaseId || !result.interrupted) {
      return { ok: true }
    }
    return {
      ok: false,
      reasonCode: normalizeTakeoverReason(result.interruptReason),
      nextAttemptAt: new Date(Date.now() + 1_000),
    }
  }
}

export class WeChatChannelUserTakeoverAbort extends Error {
  readonly reasonCode: WeChatChannelHumanActivityReasonCode
  readonly nextAttemptAt: Date
  readonly stage: WeChatChannelOutboundCommitStage
  readonly replyId: string

  constructor(input: {
    reasonCode: WeChatChannelHumanActivityReasonCode
    nextAttemptAt: Date
    stage: WeChatChannelOutboundCommitStage
    replyId: string
  }) {
    super(`user_takeover_aborted:${input.reasonCode}:${input.stage}`)
    this.name = 'WeChatChannelUserTakeoverAbort'
    this.reasonCode = input.reasonCode
    this.nextAttemptAt = input.nextAttemptAt
    this.stage = input.stage
    this.replyId = input.replyId
  }
}

function stageToActivityGateStage(stage: WeChatChannelOutboundCommitStage) {
  if (stage === 'open_conversation') return 'open_conversation'
  if (stage === 'queued') return 'send_start'
  return 'dangerous_action'
}

async function focusMessageInputWithRetry(
  helper: HelperTransport,
  traceId?: string,
  focus?: {
    windowId?: string
    inputPoint?: WeChatScreenPoint
  },
): Promise<void> {
  const params = {
    waitMs: DEFAULT_WECHAT_OUTBOUND_FOCUS_SETTLE_MS,
    ...(focus?.windowId ? { windowId: focus.windowId } : {}),
    ...(focus?.inputPoint ? { inputPoint: focus.inputPoint } : {}),
  }
  const first = await helper.request('wechat.focusMessageInput', params, traceId)
  if (first.ok) {
    if (focusSingleCallEnabled()) return
    await waitForWeChatChannelPacing('send-focus-stabilize', `${traceId || ''}:focus-stabilize`)
    const stable = await helper.request('wechat.focusMessageInput', params, traceId)
    assertHelperOk(stable, 'wechat.focusMessageInput')
    return
  }
  await waitForWeChatChannelPacing('send-focus-retry', `${traceId || ''}:focus-retry`)
  const second = await helper.request('wechat.focusMessageInput', {
    ...params,
    waitMs: Math.max(DEFAULT_WECHAT_OUTBOUND_FOCUS_SETTLE_MS, 700),
  }, traceId)
  assertHelperOk(second, 'wechat.focusMessageInput')
}

async function pressShortcut(
  helper: HelperTransport,
  key: string,
  modifiers: string[],
  traceId?: string,
): Promise<void> {
  const response = await helper.request('keyboard.shortcut', { key, modifiers }, traceId)
  assertHelperOk(response, 'keyboard.shortcut')
}

function assertReadableLocalFile(filePath: string): void {
  const stat = fs.statSync(filePath)
  if (!stat.isFile()) throw new Error(`wechat_channel_attachment_not_file:${filePath}`)
}

function detectAttachmentKind(filePath: string): 'image' | 'video' | 'file' {
  const ext = path.extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'].includes(ext)) return 'video'
  return 'file'
}

function shouldUseImageClipboard(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform ?? process.platform) === 'win32'
}

function pasteModifiersForPlatform(platform: NodeJS.Platform | string | undefined): string[] {
  return (platform ?? process.platform) === 'win32' ? ['control'] : ['command']
}

function normalizeFocusForHelper(focus: { windowId?: string; inputPoint?: WeChatScreenPoint | null } | undefined): {
  windowId?: string
  inputPoint?: WeChatScreenPoint
} | undefined {
  if (!focus) return undefined
  return {
    ...(focus.windowId ? { windowId: focus.windowId } : {}),
    ...(focus.inputPoint ? { inputPoint: focus.inputPoint } : {}),
  }
}

function shouldSkipTextClearBeforePaste(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform ?? process.platform) === 'win32'
}

function shouldRefocusAfterClipboardSet(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform ?? process.platform) === 'win32'
}

function shouldPrimeWindowsTextPaste(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform ?? process.platform) === 'win32'
}

function shouldUseAtomicPasteAndSubmit(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform ?? process.platform) === 'win32'
}

function requiresVisionInputPoint(platform: NodeJS.Platform | string | undefined): boolean {
  return (platform ?? process.platform) === 'win32'
}

async function assertMacInputPermissions(
  helper: HelperTransport,
  snapshot: WeChatChannelHumanActivitySnapshot | null,
  platform: NodeJS.Platform | string | undefined,
  traceId?: string,
): Promise<void> {
  if ((platform ?? process.platform) !== 'darwin') return
  const permissions = snapshot?.permissions
  if (!permissions) return
  const missing = permissions.accessibilityTrusted === false
    ? 'accessibility'
    : permissions.iohidListenGranted === false
      ? 'input-monitoring'
      : null
  if (missing) {
    await requestMacPermissionPrompt(helper, missing === 'accessibility'
      ? 'permissions.requestAccessibility'
      : 'permissions.requestInputMonitoring', traceId)
    throw new Error(`permission_missing:mac_input:${missing}`)
  }
}

async function requestMacPermissionPrompt(
  helper: HelperTransport,
  command: 'permissions.requestAccessibility' | 'permissions.requestInputMonitoring',
  traceId?: string,
): Promise<void> {
  try {
    await helper.request(command, {}, traceId)
  } catch {
    // Preserve the original mac input failure; prompting is best-effort.
  }
}

function classifyOutboundSendFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/conversation_not|conversation.*visible|conversation.*open/i.test(message)) return 'conversation_not_opened'
  if (/wechat_message_input_point_required|wechat_message_input_not_found/i.test(message)) return 'wechat_message_input_not_found'
  if (/permission|accessibility|screen|automation/i.test(message)) return 'permission_missing'
  if (/clipboard/i.test(message)) return 'clipboard_failed'
  if (/attachment|not_file|ENOENT|no such file/i.test(message)) return 'attachment_unavailable'
  return 'send_failed'
}

function normalizeTakeoverReason(value: unknown): WeChatChannelHumanActivityReasonCode {
  if (
    value === 'recent_mouse_activity' ||
    value === 'recent_mouse_click' ||
    value === 'recent_scroll_activity' ||
    value === 'recent_keyboard_activity' ||
    value === 'frontmost_app_changed'
  ) return value
  return 'user_activity_unknown'
}

function shouldManualReviewAfterTakeover(error: WeChatChannelUserTakeoverAbort): boolean {
  return error.stage === 'before_return'
}

function assertHelperOk(response: { ok: boolean; errorCode?: string; errorSummary?: string }, command: string): void {
  if (!response.ok) throw new Error(`${response.errorCode || 'helper_command_failed'}: ${response.errorSummary || command}`)
}
