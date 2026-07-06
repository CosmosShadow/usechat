// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-runtime.test.ts

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
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform | string
  verifyIntegrity?: boolean
  provider?: WeChatVisionProvider
  skipUserActivityGuard?: boolean
}

export type WeChatRuntime = {
  read(input: { chat: string; limit?: number; format?: 'markdown' | 'json'; traceId?: string }): Promise<WeChatReadResult>
  write(input: { chat: string; text: string; yes?: boolean; dryRun?: boolean; traceId?: string }): Promise<WeChatWriteResult>
  stop(): Promise<void>
}

export function createWeChatRuntime(input: CreateWeChatRuntimeInput = {}): WeChatRuntime {
  const platform = input.platform ?? process.platform
  const resolved = resolveWeChatHelperOrThrow(input)
  const requiredCapabilities = platform === 'win32'
    ? requiredWindowsWeChatChannelHelperCapabilitiesForProfile('send')
    : requiredWeChatChannelHelperCapabilitiesForProfile('send')
  const helper = new WeChatChannelHelperClient({
    helperPath: resolved.helperPath,
    expectedHelperVersion: resolved.version,
    requiredCapabilities,
    guardUnsafeWindowsCommands: platform === 'win32',
    skipUserActivityGuard: input.skipUserActivityGuard,
  })
  return {
    async read(readInput) {
      if (!input.provider) throw new Error('model_not_configured: read requires a VisionModelProvider')
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
      const messages = applyMessageLimit(normalizeObservedMessages(structured.structuredMessages ?? structured.observedMessages ?? []), readInput.limit)
      return {
        ok: true,
        app: 'wechat',
        chat: readInput.chat,
        messages,
        markdown: formatWeChatMessagesMarkdown(messages),
        traceId,
        window: opened.window,
      }
    },
    async write(writeInput) {
      const traceId = writeInput.traceId ?? `write-${randomUUID()}`
      if (writeInput.dryRun) {
        return { ok: true, app: 'wechat', chat: writeInput.chat, text: writeInput.text, sent: false, status: 'dry-run', traceId }
      }
      const opened = await openConversation({ helper, chat: writeInput.chat, provider: input.provider, traceId, platform, needInputPoint: true })
      const inputPoint = opened.inputPoint ?? fallbackMessageInputPoint(opened.window)
      const focus = await helper.request('wechat.focusMessageInput', {
        windowId: opened.window.windowId,
        ...(inputPoint ? { inputPoint } : {}),
        waitMs: 260,
      }, traceId)
      assertHelperOk(focus, 'wechat.focusMessageInput')
      const snapshot = await helper.request('clipboard.snapshot', {}, traceId)
      assertHelperOk(snapshot, 'clipboard.snapshot')
      const warnings: string[] = []
      let committed = false
      try {
        const submitted = await helper.request('wechat.pasteAndSubmit', {
          text: writeInput.text,
          windowId: opened.window.windowId,
          ...(inputPoint ? { inputPoint } : {}),
          waitMs: 260,
          pasteWaitMs: 900,
        }, traceId)
        assertHelperOk(submitted, 'wechat.pasteAndSubmit')
        committed = true
      } finally {
        const restoreParams = snapshot.result && typeof snapshot.result === 'object' ? snapshot.result as Record<string, unknown> : {}
        const restore = await helper.request('clipboard.restore', restoreParams, traceId)
        if (!restore.ok) {
          if (committed) warnings.push(`clipboard_restore_failed:${restore.errorSummary ?? restore.errorCode ?? 'unknown'}`)
          else assertHelperOk(restore, 'clipboard.restore')
        }
      }
      return { ok: true, app: 'wechat', chat: writeInput.chat, text: writeInput.text, sent: true, status: 'sent-unconfirmed', traceId, ...(warnings.length ? { warnings } : {}) }
    },
    stop() {
      return helper.stop()
    },
  }
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
  let searchPoint = fallbackSearchPoint(window)
  let inputPoint = fallbackMessageInputPoint(window)
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
  // Press Enter to open the top search result. This is intentionally simple for
  // UseChat's first independent path; title verification is added after the
  // basic read/write smoke is stable.
  const enter = await input.helper.request('keyboard.shortcut', { key: 'return', modifiers: [] }, input.traceId)
  assertHelperOk(enter, 'keyboard.shortcut')
  await sleep(900)
  return { opened: true, window, searchPoint, inputPoint }
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
  return ready.result
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
  return value.map((item, index) => normalizeObservedMessage(item, index)).filter((item): item is WeChatObservedMessage => item !== null)
}

function normalizeObservedMessage(value: unknown, index: number): WeChatObservedMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const senderRole = normalizeSenderRole(record.senderRole)
  const kind = String(record.kind ?? 'unknown').trim() || 'unknown'
  const text = nullableString(record.normalizedText ?? record.text ?? record.textExcerpt)
  const anchor = nullableString(record.anchorText) ?? text
  return {
    stableMessageKey: nullableString(record.stableMessageKey) ?? `visible:${index}:${senderRole}:${kind}:${(anchor ?? '').slice(0, 80)}`,
    senderRole,
    senderName: nullableString(record.senderName),
    kind,
    normalizedText: text,
    anchorText: anchor,
    textExcerpt: nullableString(record.textExcerpt) ?? text,
    bbox: record.bbox,
    mediaMetadata: record.mediaMetadata,
    observedAt: nullableString(record.observedAt) ?? new Date().toISOString(),
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
