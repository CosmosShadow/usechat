// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-runtime.test.ts

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  resolveWeChatChannelHelperAsset,
  WECHAT_CHANNEL_HELPER_DIR_ENV,
} from './helper-assets.js'
import { WeChatChannelHelperClient } from './helper-client.js'
import {
  requiredWeChatChannelHelperCapabilitiesForProfile,
  requiredWindowsWeChatChannelHelperCapabilitiesForProfile,
  type WeChatChannelHelperCommandName,
  type WeChatChannelHelperResponse,
} from './helper-protocol.js'
import { applyMessageLimit, formatWeChatMessagesMarkdown } from './format.js'
import { fallbackMessageInputPoint, fallbackSearchPoint, screenPointForClassifierRect } from './points.js'
import { validateWeChatMessages } from './message-quality.js'
import { readUseChatAttachment, type UseChatAttachmentPayload } from './attachment.js'
import { enqueueWeChatOutboundReply, type WeChatChannelOutboundLedger } from './outbound-ledger.js'
import { sendQueuedWeChatOutboundRecords, WeChatChannelOutboundSender } from './outbound-sender.js'
import { resolveUseChatObservedMessageMedia } from './inbound-media.js'
import type {
  WeChatObservedMessage,
  WeChatOcrResult,
  WeChatReadResult,
  WeChatScreenshot,
  WeChatScreenshotWithData,
  WeChatScreenPoint,
  WeChatWindowInfo,
  WeChatWriteResult,
} from './types.js'

export const WECHAT_CHANNEL_RECENT_MESSAGE_WINDOW = 20

export type HelperTransport = {
  request<T = unknown>(command: WeChatChannelHelperCommandName, params?: Record<string, unknown>, traceId?: string): Promise<WeChatChannelHelperResponse<T>>
}

export type WeChatVisionProvider = {
  structureVisibleWindow(input: {
    screenshots: Array<{ mimeType: string; dataBase64: string; width: number; height: number; windowId?: string | null }>
    edgeOcrBlocks?: unknown[]
    visibleConversationFingerprints?: unknown[]
    chatName?: string
    traceId?: string
  }): Promise<{ ok: true; structuredMessages?: unknown[]; observedMessages?: unknown[] }>
  classifyWindow?(input: {
    screenshot: { mimeType: string; dataBase64: string; width: number; height: number; windowId?: string | null }
    chatName?: string
    traceId?: string
  }): Promise<{
    ok: true
    windowKind?: string
    layout?: {
      messageInputRect?: { x?: number; y?: number; width?: number; height?: number; coordinateSpace?: string } | null
      searchInputRect?: { x?: number; y?: number; width?: number; height?: number; coordinateSpace?: string } | null
    } | null
  }>
}

export type CreateWeChatRuntimeInput = {
  helperPath?: string
  helperTransport?: HelperTransport & { stop?: () => Promise<void> }
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform | string
  verifyIntegrity?: boolean
  provider?: WeChatVisionProvider
  skipUserActivityGuard?: boolean
  macosSubmitText?: (input: {
    text: string
    window: WeChatWindowInfo
    inputPoint: WeChatScreenPoint | null
    traceId?: string
  }) => Promise<void>
}

export type WeChatRuntime = {
  read(input: { chat: string; limit?: number; format?: 'markdown' | 'json'; download?: 'never' | 'auto'; traceId?: string }): Promise<WeChatReadResult>
  write(input: { chat: string; text?: string; file?: string; image?: string; video?: string; yes?: boolean; dryRun?: boolean; traceId?: string }): Promise<WeChatWriteResult>
  stop(): Promise<void>
}

export function createWeChatRuntime(input: CreateWeChatRuntimeInput = {}): WeChatRuntime {
  const platform = input.platform ?? process.platform
  const helper = input.helperTransport ?? createDefaultHelperTransport(input, platform)
  return {
    async read(readInput) {
      if (!input.provider) throw new Error('model_not_configured: read requires a VisionModelProvider')
      if (readInput.download && !['never', 'auto'].includes(readInput.download)) throw new Error(`download_mode_unsupported: ${readInput.download}`)
      const traceId = readInput.traceId ?? `read-${randomUUID()}`
      const opened = await openConversation({ helper, chat: readInput.chat, provider: input.provider, traceId, platform })
      const observation = await captureAndRecognizeWeChatWindow(helper, opened.window.windowId, traceId, opened.window.bounds)
      const structured = await input.provider.structureVisibleWindow({
        screenshots: [{
          mimeType: observation.capture.mimeType,
          dataBase64: observation.capture.dataBase64,
          width: observation.capture.width,
          height: observation.capture.height,
          windowId: opened.window.windowId,
        }],
        edgeOcrBlocks: observation.ocr.blocks ?? [],
        visibleConversationFingerprints: observation.ocr.visibleConversationFingerprints ?? [],
        chatName: readInput.chat,
        traceId,
      })
      const structuredMessages = normalizeObservedMessages(structured.structuredMessages ?? structured.observedMessages ?? [])
      const resolvedMessages = readInput.download === 'auto'
        ? await resolveUseChatObservedMessageMedia({
            helper,
            messages: structuredMessages,
            window: opened.window,
            screenshot: observation.capture,
            windowId: opened.window.windowId,
            chatName: readInput.chat,
            traceId,
            platform,
            verifyConversationTitle: async () => {
              const verified = await captureAndRecognizeWeChatWindow(helper, opened.window.windowId, traceId, opened.window.bounds)
              throwIfWeChatLoginRequired(verified)
              return visibleTopTitleMatches(readInput.chat, verified)
                ? { ok: true as const }
                : { ok: false as const, reasonCode: 'conversation_title_not_confirmed' }
            },
          })
        : structuredMessages
      const messages = applyMessageLimit(resolvedMessages, readInput.limit)
      const quality = validateWeChatMessages({
        messages,
        windowBounds: {
          width: observation.capture.width,
          height: observation.capture.height,
        },
      })
      return {
        ok: true,
        app: 'wechat',
        chat: readInput.chat,
        messages,
        markdown: formatWeChatMessagesMarkdown(messages),
        traceId,
        window: opened.window,
        quality,
      }
    },
    async write(writeInput) {
      const traceId = writeInput.traceId ?? `write-${randomUUID()}`
      const attachments = resolveWriteAttachments(writeInput, input.env)
      const text = writeInput.text ?? ''
      if (!text.trim() && attachments.length === 0) throw new Error('wechat_write_empty: text or attachment is required')
      if (writeInput.dryRun) {
        return { ok: true, app: 'wechat', chat: writeInput.chat, text, attachment: attachments[0], attachments, sent: false, status: 'dry-run', traceId }
      }
      const bindingId = `direct:${stableLocalKey(writeInput.chat)}`
      const ledger: WeChatChannelOutboundLedger = { version: 1, runtimeId: 'usechat-direct', records: [] }
      enqueueWeChatOutboundReply({
        ledger,
        replyId: traceId,
        idempotencyKey: traceId,
        bindingId,
        runtimeId: 'usechat-direct',
        sessionId: 'usechat-direct',
        conversationName: writeInput.chat,
        replyBaseRevision: 0,
        text,
        attachmentLocalRefs: attachments.map((attachment) => attachment.localPath),
      })
      const sender = new WeChatChannelOutboundSender({
        helper,
        traceId,
        platform,
        activityGatePolicy: {
          mouseMovedThresholdMs: 0,
          mouseClickThresholdMs: 0,
          scrollWheelThresholdMs: 0,
          keyDownThresholdMs: 0,
        },
        takeoverCheck: false,
        openConversation: async (conversationName) => {
          const opened = await openConversation({ helper, chat: conversationName, provider: input.provider, traceId, platform, needInputPoint: true })
          return {
            opened: true,
            reason: 'current-conversation-title-confirmed',
            windowId: opened.window.windowId,
            inputPoint: opened.inputPoint ?? fallbackMessageInputPoint(opened.window),
          }
        },
      })
      const result = await sendQueuedWeChatOutboundRecords({
        ledger,
        bindingId,
        currentLastInboundRevision: 0,
        sender,
      })
      const failed = result.failedRecords[0] ?? result.manualReviewRecords[0] ?? result.waitingRecords[0] ?? result.staleRecords[0]
      if (failed) {
        throw new Error(`${failed.failureCode ?? failed.deferReason ?? failed.sendStatus}: ${failed.lastErrorSummary ?? failed.sendStatus}`)
      }
      return { ok: true, app: 'wechat', chat: writeInput.chat, text, attachment: attachments[0], attachments, sent: true, status: 'sent-unconfirmed', traceId }
    },
    stop() {
      return helper.stop?.() ?? Promise.resolve()
    },
  }
}

function resolveWriteAttachments(
  input: { file?: string; image?: string; video?: string },
  env?: NodeJS.ProcessEnv,
): UseChatAttachmentPayload[] {
  const result: UseChatAttachmentPayload[] = []
  if (input.file) result.push(readUseChatAttachment(input.file, 'file', { env }))
  if (input.image) result.push(readUseChatAttachment(input.image, 'image', { env }))
  if (input.video) result.push(readUseChatAttachment(input.video, 'video', { env }))
  return result
}

function stableLocalKey(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '').slice(0, 80) || 'chat'
}

async function macosPasteAndSubmitWithSystemEvents(input: {
  text: string
  window: WeChatWindowInfo,
  inputPoint: WeChatScreenPoint | null,
  traceId?: string
}): Promise<void> {
  const point = input.inputPoint ?? fallbackMessageInputPoint(input.window)
  if (!point) throw new Error('wechat_input_point_required')

  const script = buildMacOsPasteAndSubmitScript(point)
  const submitted = spawnSync('/usr/bin/osascript', [], {
    input: script,
    encoding: 'utf8',
    timeout: 15_000,
  })
  assertProcessOk(submitted, 'wechat_submit_failed')
  await sleep(500)
}

function buildMacOsPasteAndSubmitScript(point: WeChatScreenPoint): string {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('wechat_input_point_invalid')
  return [
    'tell application "System Events"',
    '  if not (exists process "WeChat") then error "wechat_not_running"',
    '  tell process "WeChat"',
    '    set frontmost to true',
    '    delay 0.15',
    `    click at {${x}, ${y}}`,
    '    delay 0.2',
    '    keystroke "a" using command down',
    '    delay 0.05',
    '    key code 51',
    '    delay 0.05',
    '    keystroke "v" using command down',
    '    delay 0.18',
    '    key code 36',
    '  end tell',
    'end tell',
    '',
  ].join('\n')
}

function assertProcessOk(result: ReturnType<typeof spawnSync>, reasonCode: string): void {
  if (result.error) throw new Error(`${reasonCode}: ${result.error.message}`)
  if (typeof result.status === 'number' && result.status !== 0) {
    const summary = String(result.stderr || result.stdout || '').trim().split(/\r?\n/)[0] || `exit ${result.status}`
    throw new Error(`${reasonCode}: ${summary}`)
  }
  if (result.signal) throw new Error(`${reasonCode}: signal ${result.signal}`)
}

function createDefaultHelperTransport(input: CreateWeChatRuntimeInput, platform: NodeJS.Platform | string): WeChatChannelHelperClient {
  const resolved = resolveWeChatHelperOrThrow(input)
  const requiredCapabilities = platform === 'win32'
    ? requiredWindowsWeChatChannelHelperCapabilitiesForProfile('send')
    : requiredWeChatChannelHelperCapabilitiesForProfile('send')
  return new WeChatChannelHelperClient({
    helperPath: resolved.helperPath,
    expectedHelperVersion: resolved.version,
    requiredCapabilities,
    guardUnsafeWindowsCommands: platform === 'win32',
    skipUserActivityGuard: input.skipUserActivityGuard,
  })
}

export async function openConversation(input: {
  helper: HelperTransport
  chat: string
  provider?: WeChatVisionProvider
  traceId?: string
  platform?: NodeJS.Platform | string
  needInputPoint?: boolean
}): Promise<{ opened: true; window: WeChatWindowInfo; searchPoint?: WeChatScreenPoint | null; inputPoint?: WeChatScreenPoint | null }> {
  const window = await ensureWeChatWindowReady(input.helper, input.traceId, { foreground: 'required' })
  const observation = await captureAndRecognizeWeChatWindow(input.helper, window.windowId, input.traceId, window.bounds)
  throwIfWeChatLoginRequired(observation)
  let searchPoint = fallbackSearchPoint(window)
  let inputPoint = fallbackMessageInputPoint(window)
  if (visibleTopTitleMatches(input.chat, observation)) {
    if (input.needInputPoint) inputPoint = inferMessageInputPointFromOcr(observation, window) ?? inputPoint
    return { opened: true, window, searchPoint, inputPoint }
  }
  if (input.provider?.classifyWindow) {
    try {
      const classified = await input.provider.classifyWindow({
        screenshot: {
          mimeType: observation.capture.mimeType,
          dataBase64: observation.capture.dataBase64,
          width: observation.capture.width,
          height: observation.capture.height,
          windowId: window.windowId,
        },
        chatName: input.chat,
        traceId: input.traceId,
      })
      searchPoint = screenPointForClassifierRect(classified.layout?.searchInputRect, observation.capture, window, 'search-input') ?? searchPoint
      inputPoint = screenPointForClassifierRect(classified.layout?.messageInputRect, observation.capture, window, 'message-input') ?? inputPoint
    } catch {
      // Fallback points keep macOS usable and provide a clear helper error on Windows if a point is required.
    }
  }
  if (input.platform === 'win32' && !searchPoint) throw new Error('wechat_search_input_point_required')
  const search = await input.helper.request('wechat.searchConversation', {
    conversationName: input.chat,
    windowId: window.windowId,
    waitMs: 800,
    ...(searchPoint ? { searchPoint } : {}),
  }, input.traceId)
  assertHelperOk(search, 'wechat.searchConversation')
  if (await clickVisibleConversationTitle({ ...input, window })) {
    await sleep(900)
  } else {
    const enter = await input.helper.request('keyboard.shortcut', { key: 'return', modifiers: [] }, input.traceId)
    assertHelperOk(enter, 'keyboard.shortcut')
    await sleep(900)
  }
  if (input.needInputPoint) {
    const postOpen = await captureAndRecognizeWeChatWindow(input.helper, window.windowId, input.traceId, window.bounds)
    throwIfWeChatLoginRequired(postOpen)
    inputPoint = inferMessageInputPointFromOcr(postOpen, window) ?? inputPoint
    assertTargetConversationTitleIfVisible(input.chat, postOpen)
  }
  return { opened: true, window, searchPoint, inputPoint }
}

async function clickVisibleConversationTitle(input: {
  helper: HelperTransport
  chat: string
  window: WeChatWindowInfo
  traceId?: string
}): Promise<boolean> {
  const observed = await captureAndRecognizeWeChatWindow(input.helper, input.window.windowId, input.traceId, input.window.bounds)
  const blocks = observed.ocr.blocks ?? []
  const target = normalizeComparableText(input.chat)
  const match = chooseConversationTitleBlock({
    blocks,
    target,
    captureWidth: observed.capture.width,
    captureHeight: observed.capture.height,
  })
  const point = screenPointForOcrBlock(match, observed.capture, input.window)
  if (!point) return false
  const clicked = await input.helper.request('mouse.click', {
    x: point.x,
    y: point.y,
    coordinateSpace: 'screen',
    windowId: input.window.windowId,
  }, input.traceId)
  assertHelperOk(clicked, 'mouse.click')
  return true
}

export async function ensureWeChatWindowReady(
  helper: HelperTransport,
  traceId?: string,
  options: { foreground?: 'required' | 'background' } = {},
): Promise<WeChatWindowInfo> {
  const allowForeground = (options.foreground ?? 'required') !== 'background'
  const preflight = await helper.request<Record<string, unknown>>('permissions.check', {}, traceId)
  assertHelperOk(preflight, 'permissions.check')
  const result = preflight.result ?? {}
  if (result.wechatRunning === false) throw new Error('wechat_not_running')
  if (result.windowsVisibleDesktopAvailable === false || result.rdpVisibleDesktopAvailable === false || result.desktopSessionVisible === false || result.screenLocked === true || result.rdpDisconnected === true) {
    throw new Error('windows_visible_desktop_unavailable')
  }
  if (result.wechatMainWindowResponsive === false) throw new Error('wechat_window_unresponsive')
  const ready = await helper.request<WeChatWindowInfo>('windows.ensureReady', process.platform === 'win32'
    ? { activate: allowForeground, allowRecovery: false, allowLaunch: false }
    : { restore: allowForeground, focus: allowForeground }, traceId)
  assertHelperOk(ready, 'windows.ensureReady')
  if (!ready.result?.windowId) throw new Error('helper_invalid_response: windows.ensureReady missing WeChat window data')
  if (process.platform === 'darwin') return preferMacMainWeChatWindow(helper, ready.result, traceId)
  return ready.result
}

async function preferMacMainWeChatWindow(
  helper: HelperTransport,
  readyWindow: WeChatWindowInfo,
  traceId?: string,
): Promise<WeChatWindowInfo> {
  if (isMacMainWeChatWindow(readyWindow) && readyWindow.title === '微信') return readyWindow
  try {
    const listed = await helper.request<{ windows?: WeChatWindowInfo[] }>('windows.list', {}, traceId)
    assertHelperOk(listed, 'windows.list')
    const windows = listed.result?.windows ?? []
    const mainCandidates = windows.filter((window) => (
      window.windowId
      && window.visible !== false
      && window.minimized !== true
      && isMacMainWeChatWindow(window)
    ))
    const main = mainCandidates.find((window) => window.title === '微信') ?? mainCandidates[0]
    if (!main) return readyWindow
    const focus = await helper.request('windows.focus', { windowId: main.windowId }, traceId)
    assertHelperOk(focus, 'windows.focus')
    return main
  } catch {
    return readyWindow
  }
}

function isMacMainWeChatWindow(window: WeChatWindowInfo): boolean {
  const appName = String(window.appName || '').toLowerCase()
  return appName === 'wechat' && (window.title === '微信' || window.title === '微信 (窗口)')
}

export async function captureAndRecognizeWeChatWindow(
  helper: HelperTransport,
  windowId: string,
  traceId?: string,
  bounds?: WeChatWindowInfo['bounds'],
): Promise<{ capture: WeChatScreenshotWithData; ocr: WeChatOcrResult }> {
  const combined = await helper.request<{ capture?: WeChatScreenshot; ocr?: WeChatOcrResult }>('windows.captureAndOcr', {
    windowId,
    scope: 'full-window',
    ...(bounds ? { bounds } : {}),
  }, traceId)
  if (combined.ok && combined.result?.capture?.dataBase64 && combined.result.ocr) {
    return { capture: combined.result.capture as WeChatScreenshotWithData, ocr: combined.result.ocr }
  }
  if (!combined.ok && combined.errorCode && !['helper_unknown_command', 'helper_command_unsupported'].includes(combined.errorCode)) {
    assertHelperOk(combined, 'windows.captureAndOcr')
  }
  const capture = await helper.request<WeChatScreenshot>('windows.capture', { windowId, scope: 'full-window', ...(bounds ? { bounds } : {}) }, traceId)
  assertHelperOk(capture, 'windows.capture')
  if (!capture.result?.dataBase64) throw new Error('helper_invalid_response: windows.capture missing screenshot data')
  const ocr = await helper.request<WeChatOcrResult>('ocr.recognize', {
    mimeType: capture.result.mimeType,
    dataBase64: capture.result.dataBase64,
    width: capture.result.width,
    height: capture.result.height,
  }, traceId)
  assertHelperOk(ocr, 'ocr.recognize')
  return { capture: capture.result as WeChatScreenshotWithData, ocr: ocr.result ?? {} }
}

function resolveWeChatHelperOrThrow(input: CreateWeChatRuntimeInput): Extract<ReturnType<typeof resolveWeChatChannelHelperAsset>, { ok: true }> {
  const resolved = input.helperPath
    ? resolveWeChatChannelHelperAsset({ platform: input.platform, baseDir: input.helperPath, env: input.env, verifyIntegrity: input.verifyIntegrity })
    : resolveWeChatChannelHelperAsset({
        platform: input.platform,
        env: {
          ...(input.env ?? process.env),
          ...(input.helperPath ? { [WECHAT_CHANNEL_HELPER_DIR_ENV]: input.helperPath } : {}),
        },
        includeInstalledDesktop: true,
        verifyIntegrity: input.verifyIntegrity,
      })
  if (!resolved.ok) throw new Error(`${resolved.reasonCode}: ${resolved.message}`)
  return resolved
}

function normalizeObservedMessages(value: unknown[]): WeChatObservedMessage[] {
  const normalized = value
    .map((item, index) => normalizeObservedMessage(item, index))
    .filter((item): item is WeChatObservedMessage => item !== null)
  return orderMessagesByBboxWhenReliable(normalized)
}

function normalizeObservedMessage(value: unknown, index: number): WeChatObservedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const senderRole = normalizeSenderRole(record.senderRole)
  const kind = String(record.kind ?? 'unknown').trim() || 'unknown'
  const text = nullableString(record.normalizedText ?? record.text ?? record.textExcerpt)
  const anchor = nullableString(record.anchorText) ?? text
  const bbox = sanitizeMessageBbox(record.bbox)
  return {
    stableMessageKey: nullableString(record.stableMessageKey) ?? `visible:${index}:${senderRole}:${kind}:${(anchor ?? '').slice(0, 80)}`,
    senderRole,
    senderName: nullableString(record.senderName),
    kind,
    normalizedText: text,
    anchorText: anchor,
    textExcerpt: nullableString(record.textExcerpt) ?? text,
    ...(bbox ? { bbox } : {}),
    mediaMetadata: record.mediaMetadata,
    observedAt: nullableString(record.observedAt) ?? new Date().toISOString(),
  }
}

type NormalizedMessageBbox = {
  x: number
  y: number
  width: number
  height: number
  coordinateSpace?: string
}

function sanitizeMessageBbox(value: unknown): NormalizedMessageBbox | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const width = Number(record.width)
  const height = Number(record.height)
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  if (width <= 0 || height <= 0) return undefined
  if (Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || width > 100_000 || height > 100_000) return undefined
  return {
    x,
    y,
    width,
    height,
    ...(typeof record.coordinateSpace === 'string' && record.coordinateSpace.trim() ? { coordinateSpace: record.coordinateSpace } : {}),
  }
}

function orderMessagesByBboxWhenReliable(messages: WeChatObservedMessage[]): WeChatObservedMessage[] {
  const withComparableBbox = messages
    .map((message, index) => ({ message, index, bbox: comparableMessageBbox(message.bbox) }))
    .filter((item): item is { message: WeChatObservedMessage; index: number; bbox: NormalizedMessageBbox } => item.bbox !== null)
  if (withComparableBbox.length < 2) return messages
  const boxedIndexes = new Set(withComparableBbox.map((item) => item.index))
  const withoutComparableBbox = messages
    .map((message, index) => ({ message, index }))
    .filter((item) => !boxedIndexes.has(item.index))
  const sorted = [...withComparableBbox].sort((left, right) => {
    const dy = left.bbox.y - right.bbox.y
    if (Math.abs(dy) > Math.max(8, Math.min(left.bbox.height, right.bbox.height) * 0.35)) return dy
    const dx = left.bbox.x - right.bbox.x
    if (Math.abs(dx) > 8) return dx
    return left.index - right.index
  })
  return [
    ...sorted.map((item) => item.message),
    ...withoutComparableBbox.map((item) => item.message),
  ]
}

function comparableMessageBbox(value: unknown): NormalizedMessageBbox | null {
  const bbox = sanitizeMessageBbox(value)
  return bbox ?? null
}

function normalizeSenderRole(value: unknown): WeChatObservedMessage['senderRole'] {
  return value === 'self' || value === 'contact' || value === 'system' || value === 'unknown' ? value : 'unknown'
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function assertHelperOk(response: WeChatChannelHelperResponse, command: string): void {
  if (!response.ok) throw new Error(`${response.errorCode || 'helper_command_failed'}: ${response.errorSummary || command}`)
}


function chooseConversationTitleBlock(input: {
  blocks: Array<{ text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }>
  target: string
  captureWidth: number
  captureHeight: number
}): { bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } } | undefined {
  const leftPaneMaxX = input.captureWidth * 0.42
  const candidates = input.blocks
    .filter((block) => {
      const bbox = block.bbox
      if (!bbox) return false
      const text = normalizeComparableText(block.text)
      if (text !== input.target) return false
      if (bbox.x >= leftPaneMaxX) return false
      // Exclude the search field and top chrome.
      if (bbox.y < input.captureHeight * 0.08) return false
      return true
    })
    .map((block) => ({ block, score: scoreConversationTitleCandidate(block, input.blocks, input.captureWidth, input.captureHeight) }))
    .sort((left, right) => right.score - left.score)
  return candidates[0]?.block
}

function scoreConversationTitleCandidate(
  block: { text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } },
  blocks: Array<{ text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }>,
  captureWidth: number,
  captureHeight: number,
): number {
  const bbox = block.bbox
  if (!bbox) return Number.NEGATIVE_INFINITY
  let score = 0
  const cy = bbox.y + bbox.height / 2
  // A real conversation title row has a timestamp on the same baseline at the
  // right side of the left pane. A preview line (for example current chat's
  // last message text) usually does not.
  const hasSameRowTime = blocks.some((candidate) => {
    const cb = candidate.bbox
    if (!cb) return false
    if (cb.x < captureWidth * 0.24 || cb.x > captureWidth * 0.42) return false
    if (Math.abs((cb.y + cb.height / 2) - cy) > Math.max(18, bbox.height * 1.4)) return false
    return isLikelyConversationTimeText(candidate.text)
  })
  if (hasSameRowTime) score += 1_000
  // Titles sit above their preview line, so another text block is often below
  // them within the same row.
  const hasPreviewBelow = blocks.some((candidate) => {
    const cb = candidate.bbox
    if (!cb || candidate === block) return false
    if (cb.x < bbox.x - 12 || cb.x > captureWidth * 0.34) return false
    const dy = cb.y - bbox.y
    return dy > bbox.height * 0.6 && dy < Math.max(70, captureHeight * 0.04)
  })
  if (hasPreviewBelow) score += 100
  // Prefer lower results only as a tie breaker; this avoids picking the top
  // selected chat's preview text when it happens to equal the target name.
  score += bbox.y / Math.max(1, captureHeight)
  return score
}

function isLikelyConversationTimeText(value: unknown): boolean {
  const text = String(value ?? '').normalize('NFKC').trim()
  return /^(?:昨天|前天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2})/.test(text)
}

function screenPointForOcrBlock(
  block: { bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } } | undefined,
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
): WeChatScreenPoint | null {
  const bbox = block?.bbox
  if (!bbox) return null
  const x = Number(bbox.x) + Number(bbox.width) * 0.5
  const y = Number(bbox.y) + Number(bbox.height) * 0.5
  if (![x, y].every(Number.isFinite)) return null
  if (bbox.coordinateSpace === 'screen' || !window.bounds) return { x: Math.round(x), y: Math.round(y), coordinateSpace: 'screen' }
  const bounds = screenshot.bounds ?? window.bounds
  const scaleX = bounds.width / screenshot.width
  const scaleY = bounds.height / screenshot.height
  return {
    x: Math.round(bounds.x + x * scaleX),
    y: Math.round(bounds.y + y * scaleY),
    coordinateSpace: 'screen',
  }
}

function inferMessageInputPointFromOcr(
  observation: { capture: WeChatScreenshot; ocr: WeChatOcrResult },
  window: WeChatWindowInfo,
): WeChatScreenPoint | null {
  const sendButton = chooseSendButtonBlock({
    blocks: observation.ocr.blocks ?? [],
    captureWidth: observation.capture.width,
    captureHeight: observation.capture.height,
  })
  const bbox = sendButton?.bbox
  if (!bbox) return null
  const offset = Math.min(Math.max(observation.capture.width * 0.18, 220), 380)
  const x = Math.max(observation.capture.width * 0.34, Number(bbox.x) - offset)
  const y = Number(bbox.y) + Number(bbox.height) * 0.5
  if (![x, y].every(Number.isFinite)) return null
  return screenPointForOcrRelativePoint({ x, y, coordinateSpace: bbox.coordinateSpace }, observation.capture, window)
}

function chooseSendButtonBlock(input: {
  blocks: Array<{ text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }>
  captureWidth: number
  captureHeight: number
}): { bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } } | undefined {
  const candidates = input.blocks
    .filter((block) => {
      const bbox = block.bbox
      if (!bbox) return false
      const text = normalizeComparableText(block.text)
      if (text !== '发送' && text !== 'send') return false
      if (bbox.x < input.captureWidth * 0.50) return false
      if (bbox.y < input.captureHeight * 0.65) return false
      return true
    })
    .map((block) => ({
      block,
      score: (block.bbox?.x ?? 0) / Math.max(1, input.captureWidth) + (block.bbox?.y ?? 0) / Math.max(1, input.captureHeight),
    }))
    .sort((left, right) => right.score - left.score)
  return candidates[0]?.block
}

function assertTargetConversationTitleIfVisible(
  chat: string,
  observation: { capture: WeChatScreenshot; ocr: WeChatOcrResult },
): void {
  if (!visibleTopTitleMatches(chat, observation)) {
    // Best-effort only: OCR may miss the title, so do not block a command that
    // was opened through WeChat's own search result.
  }
}

function visibleTopTitleMatches(
  chat: string,
  observation: { capture: WeChatScreenshot; ocr: WeChatOcrResult },
): boolean {
  const target = normalizeComparableText(chat)
  if (!target) return false
  return (observation.ocr.blocks ?? []).some((block) => {
    const bbox = block.bbox
    if (!bbox) return false
    if (bbox.x < observation.capture.width * 0.23) return false
    if (bbox.y > observation.capture.height * 0.16) return false
    const text = normalizeComparableText(block.text)
    return text === target || text.startsWith(`${target}(`) || text.includes(target)
  })
}

function throwIfWeChatLoginRequired(observation: { ocr: WeChatOcrResult }): void {
  const normalized = (observation.ocr.blocks ?? [])
    .map((block) => normalizeComparableText(block.text))
    .join('')
  if (!normalized) return
  if (
    normalized.includes('扫码登录')
    || normalized.includes('重新登录')
    || normalized.includes('登录微信')
    || normalized.includes('安全验证')
    || normalized.includes('为了你的账号安全')
    || (normalized.includes('仅传输文件') && !normalized.includes('进入微信'))
  ) {
    throw new Error('wechat_login_required')
  }
}

function screenPointForOcrRelativePoint(
  point: { x: number; y: number; coordinateSpace?: string },
  screenshot: WeChatScreenshot,
  window: WeChatWindowInfo,
): WeChatScreenPoint | null {
  if (point.coordinateSpace === 'screen') return { x: Math.round(point.x), y: Math.round(point.y), coordinateSpace: 'screen' }
  const bounds = screenshot.bounds ?? window.bounds
  if (!bounds) return null
  return {
    x: Math.round(bounds.x + point.x * (bounds.width / screenshot.width)),
    y: Math.round(bounds.y + point.y * (bounds.height / screenshot.height)),
    coordinateSpace: 'screen',
  }
}

function normalizeComparableText(value: unknown): string {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
