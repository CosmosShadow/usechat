// @arch docs/features/wechat-rpa/platform-contract.md
// @test src/__tests__/wechat-channel-helper-protocol.test.ts

export const WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION = 1

export const WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS = {
  healthCheck: 2_000,
  permissionsCheck: 10_000,
  activitySnapshot: 1_000,
  automationLease: 6_000,
  windowList: 10_000,
  windowsEnsureReady: 20_000,
  ocrRecognize: 10_000,
  windowsCapture: 5_000,
  mouseKeyboard: 3_000,
  clipboard: 5_000,
  menuPickItem: 5_000,
  savePanel: 10_000,
  wechatSearch: 6_000,
  wechatInteraction: 15_000,
} as const

export type WeChatChannelHelperCapability =
  | 'screenCapture'
  | 'visionOcr'
  | 'windowList'
  | 'windowFocus'
  | 'mouseKeyboard'
  | 'clipboard'
  | 'contextMenu'
  | 'imageCropHash'
  | 'wechatSearch'
  | 'humanActivity'
  | 'automationLease'
  | 'overlayCleanup'
  | 'wechatRecovery'

export type WeChatChannelHelperCapabilityProfile = 'observe' | 'download' | 'send'

export const WECHAT_CHANNEL_OBSERVE_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = [
  'screenCapture',
  'visionOcr',
  'windowList',
  'windowFocus',
  'mouseKeyboard',
  'clipboard',
  'imageCropHash',
  'wechatSearch',
  'humanActivity',
]

export const WECHAT_CHANNEL_DOWNLOAD_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = [
  ...WECHAT_CHANNEL_OBSERVE_HELPER_CAPABILITIES,
  'contextMenu',
]

export const WECHAT_CHANNEL_SEND_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = [
  ...WECHAT_CHANNEL_DOWNLOAD_HELPER_CAPABILITIES,
  'automationLease',
]

export const WECHAT_CHANNEL_REQUIRED_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = WECHAT_CHANNEL_SEND_HELPER_CAPABILITIES

export const WECHAT_CHANNEL_WINDOWS_OBSERVE_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = [
  ...WECHAT_CHANNEL_OBSERVE_HELPER_CAPABILITIES,
  'overlayCleanup',
  'wechatRecovery',
]

export const WECHAT_CHANNEL_WINDOWS_DOWNLOAD_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = [
  ...WECHAT_CHANNEL_WINDOWS_OBSERVE_HELPER_CAPABILITIES,
  'contextMenu',
]

export const WECHAT_CHANNEL_WINDOWS_SEND_HELPER_CAPABILITIES: WeChatChannelHelperCapability[] = [
  ...WECHAT_CHANNEL_WINDOWS_DOWNLOAD_HELPER_CAPABILITIES,
  'automationLease',
]

export function requiredWeChatChannelHelperCapabilitiesForProfile(
  profile: WeChatChannelHelperCapabilityProfile,
): WeChatChannelHelperCapability[] {
  if (profile === 'observe') return [...WECHAT_CHANNEL_OBSERVE_HELPER_CAPABILITIES]
  if (profile === 'download') return [...WECHAT_CHANNEL_DOWNLOAD_HELPER_CAPABILITIES]
  return [...WECHAT_CHANNEL_SEND_HELPER_CAPABILITIES]
}

export function requiredWindowsWeChatChannelHelperCapabilitiesForProfile(
  profile: WeChatChannelHelperCapabilityProfile,
): WeChatChannelHelperCapability[] {
  if (profile === 'observe') return [...WECHAT_CHANNEL_WINDOWS_OBSERVE_HELPER_CAPABILITIES]
  if (profile === 'download') return [...WECHAT_CHANNEL_WINDOWS_DOWNLOAD_HELPER_CAPABILITIES]
  return [...WECHAT_CHANNEL_WINDOWS_SEND_HELPER_CAPABILITIES]
}

export type WeChatChannelHelperWarmState = 'cold' | 'warming' | 'warm' | 'failed'

export type WeChatChannelHelperWarmupMetrics = {
  startedAt?: string
  readyAt?: string
  warmupStartedAt?: string
  warmupCompletedAt?: string
  coldStartMs?: number
  warmupMs?: number
  firstOcrMs?: number
  warmOcrMs?: number
  lastOcrMs?: number
  ocrSampleCount?: number
  errorCode?: string
  errorSummary?: string
}

export type WeChatChannelHelperWarmupSnapshot = {
  warmState: WeChatChannelHelperWarmState
  metrics?: WeChatChannelHelperWarmupMetrics
}

export type WeChatChannelHelperHello = {
  type: 'hello'
  protocolVersion: number
  expectedHelperVersion: string
  capabilities: WeChatChannelHelperCapability[]
}

export type WeChatChannelHelperReady = {
  type: 'ready'
  helperVersion: string
  protocolVersion: number
  capabilities: WeChatChannelHelperCapability[]
  pid: number
  warmState?: WeChatChannelHelperWarmState
  warmup?: WeChatChannelHelperWarmupMetrics
}

export type WeChatChannelHelperHealthResult = {
  ok?: boolean
  helperVersion?: string
  protocolVersion?: number
  capabilities?: WeChatChannelHelperCapability[]
  pid?: number
  uptimeMs?: number
  warmState?: WeChatChannelHelperWarmState
  warmup?: WeChatChannelHelperWarmupMetrics
}

export type WeChatChannelHumanActivityReasonCode =
  | 'recent_mouse_activity'
  | 'recent_mouse_click'
  | 'recent_scroll_activity'
  | 'recent_keyboard_activity'
  | 'frontmost_app_changed'
  | 'user_activity_unknown'

export type WeChatChannelHumanActivitySnapshot = {
  mouseMovedSecondsAgo?: number
  leftMouseDownSecondsAgo?: number
  rightMouseDownSecondsAgo?: number
  scrollWheelSecondsAgo?: number
  keyDownSecondsAgo?: number
  frontmostApp?: {
    bundleId?: string
    localizedName?: string
  } | null
  permissions?: {
    accessibilityTrusted?: boolean
    iohidListenGranted?: boolean
    iohidPostGranted?: boolean
  }
  privacy?: {
    capturesKeyContent?: boolean
    capturesMousePath?: boolean
  }
}

export type WeChatChannelHelperCommandName =
  | 'health.check'
  | 'processes.list'
  | 'permissions.check'
  | 'permissions.requestScreenRecording'
  | 'permissions.requestAccessibility'
  | 'permissions.requestInputMonitoring'
  | 'activity.snapshot'
  | 'automation.lease.acquire'
  | 'automation.lease.release'
  | 'automation.lease.status'
  | 'automation.lease.simulateInterruption'
  | 'windows.ensureReady'
  | 'windows.list'
  | 'windows.enumerateRaw'
  | 'windows.focus'
  | 'windows.closeWindow'
  | 'windows.capture'
  | 'windows.captureAndOcr'
  | 'windows.cleanupOverlays'
  | 'windows.recoverWeChat'
  | 'screen.capture'
  | 'ocr.recognize'
  | 'mouse.click'
  | 'mouse.rightClick'
  | 'mouse.scroll'
  | 'keyboard.type'
  | 'keyboard.shortcut'
  | 'keyboard.primeTextPaste'
  | 'clipboard.snapshot'
  | 'clipboard.restore'
  | 'clipboard.setText'
  | 'clipboard.setFiles'
  | 'clipboard.setImage'
  | 'clipboard.readFileUrls'
  | 'clipboard.readAttachment'
  | 'menu.pickItem'
  | 'savePanel.saveToPath'
  | 'image.cropHash'
  | 'wechat.searchConversation'
  | 'wechat.focusMessageInput'
  | 'wechat.pasteAndSubmit'
  | 'wechat.healthProbe'

export type WeChatChannelHelperCommand = {
  id: string
  command: WeChatChannelHelperCommandName
  params?: Record<string, unknown>
  traceId?: string
}

export type WeChatChannelHelperResponse<T = unknown> = {
  id: string
  ok: boolean
  result?: T
  errorCode?: string
  errorSummary?: string
  latencyMs: number
  traceId?: string
  warmState?: WeChatChannelHelperWarmState
  warmup?: WeChatChannelHelperWarmupMetrics
}

export type WeChatChannelHelperErrorCode =
  | 'helper_protocol_mismatch'
  | 'helper_version_mismatch'
  | 'helper_capability_missing'
  | 'helper_command_timeout'
  | 'helper_process_exited'
  | 'helper_invalid_response'
  | 'permission_screen_recording_missing'
  | 'permission_accessibility_missing'
  | 'permission_automation_missing'
  | 'automation_event_tap_unavailable'
  | 'wechat_not_running'
  | 'wechat_window_unavailable'
  | 'wechat_window_not_found'
  | 'wechat_window_minimized'
  | 'wechat_window_unresponsive'
  | 'wechat_recovery_failed'
  | 'wechat_login_required'
  | 'wechat_duplicate_instance'
  | 'wechat_single_main_window_required'
  | 'windows_visible_desktop_unavailable'
  | 'capture_failed'
  | 'screenshot_blank'
  | 'ocr_failed'
  | 'title_not_confirmed'
  | 'user_active'
  | 'user_takeover'
  | 'clipboard_unavailable'
  | 'clipboard_restore_failed'
  | 'menu_item_not_found'
  | 'attachment_unavailable'
  | 'dpi_mapping_failed'
  | 'platform_unsupported'
  | 'platform_runtime_degraded'
  | 'overlay_cleanup_failed'

export function createWeChatChannelHelperHello(
  expectedHelperVersion: string,
  capabilities: WeChatChannelHelperCapability[] = WECHAT_CHANNEL_REQUIRED_HELPER_CAPABILITIES,
): WeChatChannelHelperHello {
  const version = String(expectedHelperVersion || '').trim()
  if (!version) throw new Error('WeChat channel helper expected version is required')
  return {
    type: 'hello',
    protocolVersion: WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION,
    expectedHelperVersion: version,
    capabilities: [...capabilities],
  }
}

export function validateWeChatChannelHelperReady(
  ready: WeChatChannelHelperReady,
  expectedHelperVersion: string,
  requiredCapabilities: WeChatChannelHelperCapability[] = WECHAT_CHANNEL_REQUIRED_HELPER_CAPABILITIES,
): { ok: true } | { ok: false; errorCode: WeChatChannelHelperErrorCode; errorSummary: string } {
  if (!ready || ready.type !== 'ready') {
    return { ok: false, errorCode: 'helper_invalid_response', errorSummary: 'Helper did not send a ready frame' }
  }
  if (ready.protocolVersion !== WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION) {
    return {
      ok: false,
      errorCode: 'helper_protocol_mismatch',
      errorSummary: `Helper protocol ${ready.protocolVersion} does not match ${WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION}`,
    }
  }
  if (ready.helperVersion !== expectedHelperVersion) {
    return {
      ok: false,
      errorCode: 'helper_version_mismatch',
      errorSummary: `Helper version ${ready.helperVersion} does not match ${expectedHelperVersion}`,
    }
  }
  const missing = requiredCapabilities.filter((capability) => !ready.capabilities.includes(capability))
  if (missing.length) {
    return {
      ok: false,
      errorCode: 'helper_capability_missing',
      errorSummary: `Helper missing capabilities: ${missing.join(', ')}`,
    }
  }
  return { ok: true }
}

export function extractWeChatChannelHelperWarmupSnapshot(value: unknown): WeChatChannelHelperWarmupSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (!isWeChatChannelHelperWarmState(record.warmState)) return null
  const metrics = normalizeWeChatChannelHelperWarmupMetrics(record.warmup)
  return metrics ? { warmState: record.warmState, metrics } : { warmState: record.warmState }
}

export function timeoutForWeChatChannelHelperCommand(command: WeChatChannelHelperCommandName): number {
  if (command === 'health.check') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.healthCheck
  if (command === 'processes.list') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.windowList
  if (command === 'permissions.check') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.permissionsCheck
  if (command === 'permissions.requestScreenRecording') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.permissionsCheck
  if (command === 'permissions.requestAccessibility') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.permissionsCheck
  if (command === 'permissions.requestInputMonitoring') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.permissionsCheck
  if (command === 'activity.snapshot') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.activitySnapshot
  if (command.startsWith('automation.lease.')) return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.automationLease
  if (command === 'windows.list' || command === 'windows.enumerateRaw') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.windowList
  if (command === 'wechat.healthProbe') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.windowList
  if (command === 'windows.ensureReady' || command === 'windows.cleanupOverlays' || command === 'windows.recoverWeChat' || command === 'windows.closeWindow') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.windowsEnsureReady
  if (command === 'ocr.recognize') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.ocrRecognize
  if (command === 'windows.captureAndOcr') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.ocrRecognize
  if (command === 'windows.capture' || command === 'screen.capture') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.windowsCapture
  if (command.startsWith('mouse.') || command.startsWith('keyboard.')) return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.mouseKeyboard
  if (command.startsWith('clipboard.')) return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.clipboard
  if (command === 'menu.pickItem') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.menuPickItem
  if (command === 'savePanel.saveToPath') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.savePanel
  if (command === 'wechat.pasteAndSubmit' || command === 'wechat.focusMessageInput' || command === 'wechat.searchConversation') return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.wechatInteraction
  if (command.startsWith('wechat.')) return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.wechatSearch
  return WECHAT_CHANNEL_HELPER_COMMAND_TIMEOUT_MS.healthCheck
}

function isWeChatChannelHelperWarmState(value: unknown): value is WeChatChannelHelperWarmState {
  return value === 'cold' || value === 'warming' || value === 'warm' || value === 'failed'
}

function normalizeWeChatChannelHelperWarmupMetrics(value: unknown): WeChatChannelHelperWarmupMetrics | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  const metrics: WeChatChannelHelperWarmupMetrics = {}
  copyStringField(source, metrics, 'startedAt')
  copyStringField(source, metrics, 'readyAt')
  copyStringField(source, metrics, 'warmupStartedAt')
  copyStringField(source, metrics, 'warmupCompletedAt')
  copyNumberField(source, metrics, 'coldStartMs')
  copyNumberField(source, metrics, 'warmupMs')
  copyNumberField(source, metrics, 'firstOcrMs')
  copyNumberField(source, metrics, 'warmOcrMs')
  copyNumberField(source, metrics, 'lastOcrMs')
  copyNumberField(source, metrics, 'ocrSampleCount')
  copyStringField(source, metrics, 'errorCode')
  copyStringField(source, metrics, 'errorSummary')
  return Object.keys(metrics).length > 0 ? metrics : undefined
}

function copyStringField(
  source: Record<string, unknown>,
  target: WeChatChannelHelperWarmupMetrics,
  key: 'startedAt' | 'readyAt' | 'warmupStartedAt' | 'warmupCompletedAt' | 'errorCode' | 'errorSummary',
): void {
  if (typeof source[key] === 'string') target[key] = source[key]
}

function copyNumberField(
  source: Record<string, unknown>,
  target: WeChatChannelHelperWarmupMetrics,
  key: 'coldStartMs' | 'warmupMs' | 'firstOcrMs' | 'warmOcrMs' | 'lastOcrMs' | 'ocrSampleCount',
): void {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] = value
}
