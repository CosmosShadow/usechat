// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-doctor.test.ts

import {
  resolveWeChatChannelHelperAsset,
  USECHAT_WECHAT_CHANNEL_HELPER_DIR_ENV,
  type WeChatChannelHelperAssetResolution,
} from './helper-assets.js'
import { WeChatChannelHelperClient } from './helper-client.js'
import {
  requiredWeChatChannelHelperCapabilitiesForProfile,
  requiredWindowsWeChatChannelHelperCapabilitiesForProfile,
  WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION,
} from './helper-protocol.js'
import type { WeChatDoctorCheck, WeChatDoctorResult } from './types.js'

export type RunWeChatDoctorInput = {
  helperPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform | string
  verifyIntegrity?: boolean
  checkModel?: boolean
  modelConfigured?: boolean
}

export async function runWeChatDoctor(input: RunWeChatDoctorInput = {}): Promise<WeChatDoctorResult> {
  const platform = input.platform ?? process.platform
  const checks: WeChatDoctorCheck[] = []
  if (platform !== 'darwin' && platform !== 'win32') {
    checks.push({ id: 'platform', ok: false, reasonCode: 'unsupported_platform', message: 'UseChat 微信连接器当前只支持 macOS 和 Windows。' })
    return { ok: false, platform, checks }
  }
  checks.push({ id: 'platform', ok: true, message: `平台支持：${platform}` })

  if (input.checkModel !== false) {
    if (input.modelConfigured) checks.push({ id: 'model', ok: true, message: '模型配置已设置。' })
    else checks.push({ id: 'model', ok: false, reasonCode: 'model_not_configured', message: '模型未完整配置；read 需要 model.provider/baseUrl/name/apiKeyEnv。' })
  }

  const resolved = resolveDoctorHelper(input)
  if (!resolved.ok) {
    checks.push({ id: 'helper', ok: false, reasonCode: mapHelperResolutionReason(resolved.reasonCode), message: resolved.message })
    return { ok: false, platform, checks }
  }
  checks.push({ id: 'helper', ok: true, message: `Helper 已找到：${resolved.helperPath}`, details: { helperDir: resolved.helperDir, version: resolved.version } })
  if (resolved.manifest.protocolVersion !== WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION) {
    checks.push({ id: 'helper-protocol', ok: false, reasonCode: 'helper_protocol_mismatch', message: `Helper protocol ${resolved.manifest.protocolVersion} 与 UseChat protocol ${WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION} 不一致。` })
    return doctorResult(platform, checks, resolved)
  }
  checks.push({ id: 'helper-protocol', ok: true, message: `Helper protocol ${resolved.manifest.protocolVersion}。` })

  const requiredCapabilities = platform === 'win32'
    ? requiredWindowsWeChatChannelHelperCapabilitiesForProfile('send')
    : requiredWeChatChannelHelperCapabilitiesForProfile('send')
  const client = new WeChatChannelHelperClient({
    helperPath: resolved.helperPath,
    expectedHelperVersion: resolved.version,
    requiredCapabilities,
    guardUnsafeWindowsCommands: false,
  })
  try {
    const ready = await client.start()
    checks.push({ id: 'helper-health', ok: true, message: `Helper 已启动：${ready.helperVersion}` })
    const health = await client.healthCheck(`doctor-${Date.now().toString(36)}`)
    if (health.ok) checks.push({ id: 'helper-health-command', ok: true, message: 'Helper health.check 通过。', details: health.result })
    else checks.push({ id: 'helper-health-command', ok: false, reasonCode: health.errorCode ?? 'helper_health_failed', message: health.errorSummary ?? 'Helper health.check 失败。' })

    const permissions = await client.request<Record<string, unknown>>('permissions.check', {}, `doctor-permissions-${Date.now().toString(36)}`)
    if (!permissions.ok) {
      checks.push({ id: 'permissions', ok: false, reasonCode: normalizeDoctorReasonCode(permissions.errorCode, 'permission_missing'), message: permissions.errorSummary ?? '权限检查失败。' })
    } else {
      const permissionResult = await enrichDoctorPermissionResultWithWindowProbe({
        result: permissions.result ?? {},
        platform,
        client,
        traceId: `doctor-window-probe-${Date.now().toString(36)}`,
      })
      const permissionChecks = permissionChecksFromResult(permissionResult, platform)
      checks.push(...permissionChecks)
    }
  } catch (error) {
    checks.push({ id: 'helper-runtime', ok: false, reasonCode: normalizeDoctorReasonCode(errorReasonCode(error), 'helper_runtime_failed'), message: error instanceof Error ? error.message : String(error) })
  } finally {
    await client.stop().catch(() => {})
  }
  return doctorResult(platform, checks, resolved)
}

export async function enrichDoctorPermissionResultWithWindowProbe(input: {
  result: Record<string, unknown>
  platform: NodeJS.Platform | string
  client: {
    request<T = unknown>(command: 'windows.list' | 'windows.ensureReady', params?: Record<string, unknown>, traceId?: string): Promise<{ ok: boolean; result?: T }>
  }
  traceId?: string
}): Promise<Record<string, unknown>> {
  const next = { ...input.result }
  if (next.wechatWindowAvailable === true || next.wechatRunning === false) return next
  const probed = await probeWeChatWindowAvailable(input.client, input.traceId)
  if (probed === true) next.wechatWindowAvailable = true
  if (next.wechatWindowAvailable !== true) {
    const ready = await probeWeChatEnsureReady(input.client, input.platform, input.traceId)
    if (ready === true) next.wechatWindowAvailable = true
  }
  return next
}

async function probeWeChatWindowAvailable(
  client: {
    request<T = unknown>(command: 'windows.list', params?: Record<string, unknown>, traceId?: string): Promise<{ ok: boolean; result?: T }>
  },
  traceId?: string,
): Promise<boolean | null> {
  try {
    const listed = await client.request<{ windows?: unknown[] }>('windows.list', {}, traceId)
    if (!listed.ok) return null
    return (listed.result?.windows ?? []).some(isUsableWeChatWindow)
  } catch {
    return null
  }
}

async function probeWeChatEnsureReady(
  client: {
    request<T = unknown>(command: 'windows.ensureReady', params?: Record<string, unknown>, traceId?: string): Promise<{ ok: boolean; result?: T }>
  },
  platform: NodeJS.Platform | string,
  traceId?: string,
): Promise<boolean | null> {
  try {
    const params = platform === 'win32'
      ? { activate: false, allowRecovery: false, allowLaunch: false }
      : { restore: true, focus: false }
    const ready = await client.request<unknown>('windows.ensureReady', params, traceId)
    if (!ready.ok) return null
    return isUsableWeChatWindow(ready.result)
  } catch {
    return null
  }
}

function isUsableWeChatWindow(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.visible === false || record.minimized === true) return false
  const appName = String(record.appName ?? '').normalize('NFKC').toLowerCase()
  const title = String(record.title ?? '').normalize('NFKC')
  if (!appName.includes('wechat') && !appName.includes('微信') && title !== '微信' && !title.startsWith('微信 ')) return false
  const bounds = record.bounds
  if (bounds && typeof bounds === 'object' && !Array.isArray(bounds)) {
    const boundsRecord = bounds as Record<string, unknown>
    const width = Number(boundsRecord.width)
    const height = Number(boundsRecord.height)
    if (Number.isFinite(width) && width <= 0) return false
    if (Number.isFinite(height) && height <= 0) return false
  }
  return true
}

function resolveDoctorHelper(input: RunWeChatDoctorInput): WeChatChannelHelperAssetResolution {
  if (input.helperPath) {
    return resolveWeChatChannelHelperAsset({
      platform: input.platform,
      baseDir: input.helperPath,
      verifyIntegrity: input.verifyIntegrity,
      env: input.env,
    })
  }
  return resolveWeChatChannelHelperAsset({
    platform: input.platform,
    verifyIntegrity: input.verifyIntegrity,
    env: {
      ...(input.env ?? process.env),
      ...(input.helperPath ? { [USECHAT_WECHAT_CHANNEL_HELPER_DIR_ENV]: input.helperPath } : {}),
    },
    includeInstalledDesktop: true,
  })
}

function doctorResult(platform: NodeJS.Platform | string, checks: WeChatDoctorCheck[], resolved: Extract<WeChatChannelHelperAssetResolution, { ok: true }>): WeChatDoctorResult {
  return {
    ok: checks.every((check) => check.ok),
    platform,
    checks,
    helper: {
      path: resolved.helperPath,
      dir: resolved.helperDir,
      version: resolved.version,
      protocolVersion: resolved.manifest.protocolVersion,
    },
  }
}

function permissionChecksFromResult(result: Record<string, unknown>, platform: NodeJS.Platform | string): WeChatDoctorCheck[] {
  const checks: WeChatDoctorCheck[] = []
  if (platform === 'darwin') {
    checks.push(booleanCheck('permission-screen-recording', result.screenRecording, 'permission_missing', 'macOS 屏幕录制权限'))
    checks.push(booleanCheck('permission-accessibility', result.accessibility, 'permission_missing', 'macOS 辅助功能权限'))
    checks.push(booleanCheck('permission-input-monitoring', result.inputMonitoring, 'permission_missing', 'macOS 输入监听权限'))
    if (typeof result.automation === 'boolean') checks.push(booleanCheck('permission-automation', result.automation, 'permission_missing', 'macOS 自动化权限'))
  } else if (platform === 'win32') {
    checks.push(booleanCheck('visible-desktop', result.windowsVisibleDesktopAvailable ?? result.rdpVisibleDesktopAvailable ?? result.desktopSessionVisible, 'windows_visible_desktop_unavailable', 'Windows 可见桌面会话'))
    if (result.screenLocked === true || result.rdpDisconnected === true) {
      checks.push({ id: 'visible-desktop-state', ok: false, reasonCode: 'windows_visible_desktop_unavailable', message: 'Windows 当前可能锁屏或 RDP 断开。' })
    }
  }
  checks.push(booleanCheck('wechat-process', result.wechatRunning, 'wechat_not_running', '微信进程'))
  checks.push(booleanCheck('wechat-window', result.wechatWindowAvailable, 'wechat_window_not_found', '微信可见窗口'))
  if (typeof result.wechatMainWindowResponsive === 'boolean') checks.push(booleanCheck('wechat-responsive', result.wechatMainWindowResponsive, 'wechat_window_unresponsive', '微信窗口响应'))
  return checks
}

function booleanCheck(id: string, value: unknown, reasonCode: string, label: string): WeChatDoctorCheck {
  if (value === false) return { id, ok: false, reasonCode, message: `${label}不可用。` }
  if (value === true) return { id, ok: true, message: `${label}可用。` }
  return { id, ok: true, message: `${label}未报告明确异常。` }
}

function mapHelperResolutionReason(reasonCode: string): string {
  const map: Record<string, string> = {
    helper_runtime_required: 'helper_missing',
    manifest_missing: 'helper_manifest_missing',
    helper_missing: 'helper_missing',
    integrity_mismatch: 'helper_invalid_manifest',
    helper_not_executable: 'helper_missing',
    unsupported_platform: 'unsupported_platform',
  }
  return map[reasonCode] ?? reasonCode
}

function normalizeDoctorReasonCode(value: unknown, fallback: string): string {
  const code = typeof value === 'string' && value.trim() ? value.trim().split(':')[0] : fallback
  if (code === 'permission_screen_recording_missing' || code === 'permission_accessibility_missing' || code === 'permission_input_monitoring_missing' || code === 'permission_automation_missing') return 'permission_missing'
  if (code === 'wechat_window_unavailable') return 'wechat_window_not_found'
  return code
}

function errorReasonCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  return error.message.split(':')[0]?.trim()
}
