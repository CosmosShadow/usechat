// @arch docs/features/wechat-rpa/platform-contract.md
// @arch docs/features/wechat-rpa/windows-runtime/architecture.md
// @test src/__tests__/wechat-channel-helper-client.test.ts

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net, { type Socket } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import {
  normalizeWeChatChannelActivitySnapshot,
  waitForWeChatChannelActivityGate,
} from './human-coordination.js'
import {
  createWeChatChannelHelperHello,
  extractWeChatChannelHelperWarmupSnapshot,
  timeoutForWeChatChannelHelperCommand,
  validateWeChatChannelHelperReady,
  type WeChatChannelHelperCommandName,
  type WeChatChannelHelperCapability,
  type WeChatChannelHelperHealthResult,
  type WeChatChannelHelperReady,
  type WeChatChannelHelperResponse,
  type WeChatChannelHelperWarmupSnapshot,
} from './helper-protocol.js'

export type WeChatChannelHelperClientOptions = {
  helperPath: string
  expectedHelperVersion: string
  args?: string[]
  cwd?: string
  requiredCapabilities?: WeChatChannelHelperCapability[]
  guardUnsafeWindowsCommands?: boolean
  skipUserActivityGuard?: boolean
  cleanupWindowsOverlays?: boolean
  requestLogger?: (event: WeChatChannelHelperRequestTraceEvent) => void
  openHelperAppForTest?: (command: string, args: string[]) => Promise<void>
  macosRuntimeInitialReadyTimeoutMs?: number
  macosRuntimeRelaunchReadyTimeoutMs?: number
}

export type WeChatChannelHelperRequestTraceEvent = {
  phase: 'request' | 'response' | 'error'
  at: string
  id: string
  command: WeChatChannelHelperCommandName
  traceId?: string
  timeoutMs?: number
  durationMs?: number
  params?: Record<string, unknown>
  ok?: boolean
  errorCode?: string
  errorSummary?: string
  latencyMs?: number
  result?: unknown
}

const RUNTIME_ENV_PROPERTY = ['en', 'v'].join('')
const HELPER_STOP_GRACE_MS = 1_500
// How long a passing guard probe stays valid for back-to-back read-only
// commands. Short enough that a real safety change (login lost, window
// destroyed, user takes over) is still caught within a beat by the next
// dangerous action — which always re-probes — yet long enough to collapse the
// dense capture/ocr burst of a single observe pass into one probe instead of
// dozens.
const READ_ONLY_GUARD_THROTTLE_MS = 1_500
// Dangerous actions (click/paste/focus/keyboard) historically re-probed
// permissions.check before every command. On Windows a single send fires ~14
// probes at ~1.6s each (~22s), which is the largest single contributor to
// send latency. Extend the throttle to dangerous commands too, but keep TTL
// short enough that a real safety change (login lost, window destroyed, user
// takes over) is still caught within a beat. Override with the env var below
// (0 disables the throttle for dangerous commands and restores the old
// re-probe-every-time behavior).
const DEFAULT_DANGEROUS_GUARD_THROTTLE_MS = 8_000
const DANGEROUS_GUARD_THROTTLE_ENV = 'SHENNIAN_WECHAT_DANGEROUS_GUARD_THROTTLE_MS'
const USER_ACTIVITY_MAX_WAIT_MS = 6_500
const USER_ACTIVITY_MAX_WAIT_ENV = 'USECHAT_WECHAT_USER_ACTIVITY_MAX_WAIT_MS'
const LEGACY_USER_ACTIVITY_MAX_WAIT_ENV = 'SHENNIAN_WECHAT_USER_ACTIVITY_MAX_WAIT_MS'

class HelperVersionMismatchError extends Error {
  constructor(message: string, readonly helperPid: number | null) {
    super(message)
    this.name = 'HelperVersionMismatchError'
  }
}

function readDangerousGuardThrottleMs(): number {
  const raw = process.env[DANGEROUS_GUARD_THROTTLE_ENV]
  if (raw === undefined || raw === '') return DEFAULT_DANGEROUS_GUARD_THROTTLE_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DANGEROUS_GUARD_THROTTLE_MS
  return parsed
}

function readUserActivityMaxWaitMs(): number {
  const raw = process.env[USER_ACTIVITY_MAX_WAIT_ENV] ?? process.env[LEGACY_USER_ACTIVITY_MAX_WAIT_ENV]
  if (raw === undefined || raw === '') return USER_ACTIVITY_MAX_WAIT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return USER_ACTIVITY_MAX_WAIT_MS
  return Math.min(parsed, 60_000)
}

export class WeChatChannelHelperClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private socket: Socket | null = null
  private lines: Interface | null = null
  private readyState: WeChatChannelHelperReady | null = null
  private warmupState: WeChatChannelHelperWarmupSnapshot | null = null
  private stderrTail = ''
  private startPromise: Promise<WeChatChannelHelperReady> | null = null
  private requestQueueTail: Promise<void> = Promise.resolve()
  // Throttle the per-command guard probe for read-only commands. The guard runs
  // a full permissions.check (enumerates every top-level window, ~1.5s) plus an
  // overlay-cleanup pass before each command. During an observe pass we fire
  // dozens of read commands (capture/ocr) back-to-back, so without throttling
  // WeChat sees a dense, metronomic burst of full-window scans — exactly the
  // machine cadence its anti-RPA self-protection reads as "not a human" and
  // responds to by tearing the shell down to the login screen. We cache the last
  // *passing* guard result and reuse it for read-only commands that arrive
  // within a short window. Dangerous actions (click/search/focus/paste/keyboard/
  // clipboard) always re-probe fresh — they are the moments that actually need
  // an up-to-date safety check, and they are infrequent enough not to form a
  // burst.
  private lastGuardPassAtMs = 0
  private pending = new Map<string, {
    resolve: (value: WeChatChannelHelperResponse) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  constructor(private options: WeChatChannelHelperClientOptions) {}

  async start(): Promise<WeChatChannelHelperReady> {
    if (this.hasTransport() && this.readyState) return this.readyState
    if (this.startPromise) return this.startPromise
    if (this.hasTransport()) await this.stop()

    this.startPromise = this.startFresh().catch(async (error) => {
      await this.stop().catch(() => {})
      throw error
    }).finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async startFresh(): Promise<WeChatChannelHelperReady> {
    const launch = helperLaunchSpec(this.options.helperPath, this.options.args ?? [])
    if (launch.transport === 'macos-socket') return this.startDarwinAppSocketFresh(launch)
    return this.startStdioFresh(launch)
  }

  private async startStdioFresh(launch: LegacyRawHelperLaunchSpec): Promise<WeChatChannelHelperReady> {
    const child = spawn(launch.command, launch.args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.stderrTail = ''
    this.lines = createInterface({ input: child.stdout })
    this.lines.on('line', (line) => this.handleLine(line))
    child.stderr.on('data', (chunk) => {
      this.captureStderr(chunk)
    })
    child.stdin.on('error', (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)))
    })
    child.once('error', (error) => {
      if (this.child === child) {
        this.child = null
        this.readyState = null
        this.lines?.close()
        this.lines = null
      }
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)))
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null
        this.readyState = null
        this.lines?.close()
        this.lines = null
      }
      this.rejectAllPending(new Error(this.formatHelperExitMessage(code, signal)))
    })

    const readyPromise = new Promise<WeChatChannelHelperReady>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WeChat channel helper handshake timed out')), 10_000)
      const onError = (error: Error) => {
        clearTimeout(timer)
        this.lines?.off('line', onLine)
        child.off('exit', onExit)
        reject(new Error(`WeChat channel helper failed to start: ${error.message}`))
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer)
        child.off('error', onError)
        this.lines?.off('line', onLine)
        reject(new Error(this.formatHelperExitMessage(code, signal)))
      }
      const onLine = (line: string) => {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          clearTimeout(timer)
          child.off('error', onError)
          this.lines?.off('line', onLine)
          reject(new Error('WeChat channel helper sent invalid handshake JSON'))
          return
        }
        if (!isReadyFrame(frame)) return
        clearTimeout(timer)
        child.off('error', onError)
        child.off('exit', onExit)
        this.lines?.off('line', onLine)
        const validation = validateWeChatChannelHelperReady(frame, this.options.expectedHelperVersion, this.options.requiredCapabilities)
        if (!validation.ok) reject(new Error(`${validation.errorCode}: ${validation.errorSummary}`))
        else {
          this.readyState = frame
          this.captureWarmupSnapshot(frame)
          resolve(frame)
        }
      }
      child.once('error', onError)
      child.once('exit', onExit)
      this.lines?.on('line', onLine)
    })

    try {
      child.stdin.write(`${JSON.stringify(createWeChatChannelHelperHello(this.options.expectedHelperVersion, this.options.requiredCapabilities))}\n`)
    } catch (error) {
      await this.stop().catch(() => {})
      throw error
    }
    return readyPromise
  }

  private async startDarwinAppSocketFresh(
    launch: DarwinAppSocketHelperLaunchSpec,
    allowStaleRuntimeRecovery = true,
  ): Promise<WeChatChannelHelperReady> {
    const socket = await this.connectDarwinHelperSocket(launch)
    this.socket = socket
    this.stderrTail = ''
    this.lines = createInterface({ input: socket })
    this.lines.on('line', (line) => this.handleLine(line))
    socket.on('error', (error) => {
      if (this.socket === socket) {
        this.socket = null
        this.readyState = null
        this.lines?.close()
        this.lines = null
      }
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)))
    })
    socket.once('close', () => {
      if (this.socket === socket) {
        this.socket = null
        this.readyState = null
        this.lines?.close()
        this.lines = null
      }
      this.rejectAllPending(new Error('WeChat channel helper socket closed'))
    })

    const readyPromise = new Promise<WeChatChannelHelperReady>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WeChat channel helper socket handshake timed out')), 10_000)
      const onError = (error: Error) => {
        clearTimeout(timer)
        this.lines?.off('line', onLine)
        socket.off('close', onClose)
        reject(new Error(`WeChat channel helper socket failed: ${error.message}`))
      }
      const onClose = () => {
        clearTimeout(timer)
        socket.off('error', onError)
        this.lines?.off('line', onLine)
        reject(new Error('WeChat channel helper socket closed before handshake'))
      }
      const onLine = (line: string) => {
        let frame: unknown
        try {
          frame = JSON.parse(line)
        } catch {
          clearTimeout(timer)
          socket.off('error', onError)
          socket.off('close', onClose)
          this.lines?.off('line', onLine)
          reject(new Error('WeChat channel helper sent invalid socket handshake JSON'))
          return
        }
        if (!isReadyFrame(frame)) return
        clearTimeout(timer)
        socket.off('error', onError)
        socket.off('close', onClose)
        this.lines?.off('line', onLine)
        const validation = validateWeChatChannelHelperReady(frame, this.options.expectedHelperVersion, this.options.requiredCapabilities)
        if (!validation.ok) {
          const message = `${validation.errorCode}: ${validation.errorSummary}`
          reject(validation.errorCode === 'helper_version_mismatch'
            ? new HelperVersionMismatchError(message, Number.isInteger(frame.pid) ? frame.pid : null)
            : new Error(message))
        }
        else {
          this.readyState = frame
          this.captureWarmupSnapshot(frame)
          resolve(frame)
        }
      }
      socket.once('error', onError)
      socket.once('close', onClose)
      this.lines?.on('line', onLine)
    })

    try {
      this.writeFrame(createWeChatChannelHelperHello(this.options.expectedHelperVersion, this.options.requiredCapabilities))
    } catch (error) {
      await this.stop().catch(() => {})
      throw error
    }
    try {
      return await readyPromise
    } catch (error) {
      if (allowStaleRuntimeRecovery && error instanceof HelperVersionMismatchError) {
        await this.stop().catch(() => {})
        await terminateMacosRuntimePid(error.helperPid)
        fs.rmSync(launch.runtimeFile, { force: true })
        return this.startDarwinAppSocketFresh(launch, false)
      }
      throw error
    }
  }

  async request<T = unknown>(command: WeChatChannelHelperCommandName, params?: Record<string, unknown>, traceId?: string): Promise<WeChatChannelHelperResponse<T>> {
    const run = this.requestQueueTail.catch(() => {}).then(() => this.sendRequest<T>(command, params, traceId))
    this.requestQueueTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async sendRequest<T = unknown>(command: WeChatChannelHelperCommandName, params?: Record<string, unknown>, traceId?: string): Promise<WeChatChannelHelperResponse<T>> {
    await this.guardUnsafeWindowsCommand(command, traceId)
    try {
      return await this.sendRawRequest<T>(command, params, traceId)
    } finally {
      await this.cleanupWindowsOverlaysAfterCommand(command, traceId).catch(() => {})
    }
  }

  private async sendRawRequest<T = unknown>(command: WeChatChannelHelperCommandName, params?: Record<string, unknown>, traceId?: string): Promise<WeChatChannelHelperResponse<T>> {
    if (!this.hasTransport() || !this.readyState) await this.start()
    if (!this.hasTransport()) throw new Error('WeChat channel helper is not started')
    const id = randomUUID()
    const timeoutMs = timeoutForWeChatChannelHelperCommand(command)
    const startedAtMs = Date.now()
    this.emitRequestTrace({
      phase: 'request',
      at: new Date(startedAtMs).toISOString(),
      id,
      command,
      traceId,
      params,
      timeoutMs,
    })
    const promise = new Promise<WeChatChannelHelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        void this.stopAfterCommandTimeout(command).finally(() => {
          reject(new Error(`helper_command_timeout: ${command}`))
        })
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
    })
    try {
      this.writeFrame({ id, command, params, traceId })
    } catch (error) {
      const pending = this.pending.get(id)
      if (pending) clearTimeout(pending.timer)
      this.pending.delete(id)
      this.emitRequestTrace({
        phase: 'error',
        at: new Date().toISOString(),
        id,
        command,
        traceId,
        durationMs: Date.now() - startedAtMs,
        errorSummary: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    try {
      const response = await promise as WeChatChannelHelperResponse<T>
      this.emitRequestTrace({
        phase: 'response',
        at: new Date().toISOString(),
        id,
        command,
        traceId,
        durationMs: Date.now() - startedAtMs,
        ok: response.ok,
        errorCode: response.errorCode,
        errorSummary: response.errorSummary,
        latencyMs: response.latencyMs,
        result: response.result,
      })
      this.captureWarmupSnapshot(response)
      this.captureWarmupSnapshot(response.result)
      return response
    } catch (error) {
      this.emitRequestTrace({
        phase: 'error',
        at: new Date().toISOString(),
        id,
        command,
        traceId,
        durationMs: Date.now() - startedAtMs,
        errorSummary: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  private async guardUnsafeWindowsCommand(command: WeChatChannelHelperCommandName, traceId?: string): Promise<void> {
    if (!this.options.guardUnsafeWindowsCommands || !isGuardedWindowsCommand(command)) return
    // Collapse the dense read-only burst of an observe pass: if a full guard
    // probe passed moments ago, reuse it for capture/ocr instead of enumerating
    // every window again. Dangerous actions fall through and always re-probe.
    // Read-only bursts (capture/ocr) collapse onto a very short TTL — a real
    // safety change is still caught within ~1.5s. Dangerous actions used to
    // re-probe on every command, but on Windows that means ~14 probes at
    // ~1.6s each within a single send. Fold them under a longer TTL so a
    // fresh probe still runs every few seconds (catching stuck-shell / lost
    // login) but not before every click. activity.snapshot for dangerous
    // actions still runs below regardless of this throttle.
    // Same TTL for read-only and dangerous commands: within a single send
    // flow the two categories interleave (open-read → send-text), and giving
    // read-only a very short TTL just forces the next dangerous action to
    // re-probe anyway. Keep read-only floored at 1500ms as a safety net for
    // legacy call sites that opt out of the dangerous throttle.
    const dangerousThrottle = readDangerousGuardThrottleMs()
    const throttleMs = isReadOnlyGuardedWindowsCommand(command)
      ? Math.max(READ_ONLY_GUARD_THROTTLE_MS, dangerousThrottle)
      : dangerousThrottle
    if (
      throttleMs > 0
      && this.lastGuardPassAtMs > 0
      && Date.now() - this.lastGuardPassAtMs < throttleMs
    ) {
      // Dangerous actions still need the real-time user-activity gate and
      // the pre-command overlay cleanup, even when the permissions probe is
      // fresh. Skip only the expensive permissions.check + stuck-shell
      // recovery + window availability re-derivation.
      if (!isReadOnlyGuardedWindowsCommand(command)) {
        if (!this.options.skipUserActivityGuard && isUserActivityGuardedWindowsCommand(command)) {
          await this.waitForQuietUserActivity(command, traceId)
        }
        await this.cleanupWindowsOverlays('before', command, traceId)
      }
      return
    }
    let permissions = await this.sendRawRequest<WeChatChannelPermissionsCheckResult>('permissions.check', {}, traceId)
    if (!permissions.ok) throw new Error(`${permissions.errorCode ?? 'permissions_check_failed'}: ${permissions.errorSummary ?? command}`)
    let result = permissions.result ?? {}
    // Auto-recover from "stuck shell" lockouts: WeChat process tree is alive
    // but every top-level window has been destroyed by its own anti-RPA
    // self-protection. The user cannot reach the tray "退出" menu in this
    // state, so doing nothing leaves them permanently stuck. Probe + restart
    // once before falling through to the normal availability checks.
    if (result.wechatRunning !== false && looksLikeStuckShell(result)) {
      const recovered = await this.tryRecoverFromStuckShell(traceId)
      if (recovered) {
        permissions = await this.sendRawRequest<WeChatChannelPermissionsCheckResult>('permissions.check', {}, traceId)
        if (!permissions.ok) throw new Error(`${permissions.errorCode ?? 'permissions_check_failed'}: ${permissions.errorSummary ?? command}`)
        result = permissions.result ?? {}
      }
    }
    if (isMacHelperPreflightPlatform(result.platform)) {
      const missingMacPermission = await this.requestFirstMissingMacPermissionPrompt(result, traceId)
      if (missingMacPermission === 'screen-recording') throw new Error('permission_screen_recording_missing')
      if (missingMacPermission === 'accessibility') throw new Error('permission_accessibility_missing')
      if (missingMacPermission === 'input-monitoring') throw new Error('permission_input_monitoring_missing')
      if (result.automation === false) throw new Error('permission_automation_missing')
    }
    if (result.wechatRunning === false) throw new Error('wechat_not_running')
    if (hasLoginRequiredGuardState(result)) throw new Error('wechat_login_required')
    if (hasUnavailableVisibleDesktopGuardState(result)) throw new Error('windows_visible_desktop_unavailable')
    if (result.dpiMappingAvailable === false || result.displayTopologySupported === false) throw new Error('dpi_mapping_failed')
    if (result.wechatWindowAvailable === false) throw new Error('wechat_window_unavailable')
    if (result.wechatMainWindowResponsive === false) throw new Error('wechat_window_unresponsive')

    if (!this.options.skipUserActivityGuard && isUserActivityGuardedWindowsCommand(command)) {
      await this.waitForQuietUserActivity(command, traceId)
    }

    await this.cleanupWindowsOverlays('before', command, traceId)
    // Guard fully passed; let the next read-only burst reuse this result.
    this.lastGuardPassAtMs = Date.now()
  }

  private async waitForQuietUserActivity(command: WeChatChannelHelperCommandName, traceId?: string): Promise<void> {
    const decision = await waitForWeChatChannelActivityGate({
      stage: 'dangerous_action',
      maxWaitMs: readUserActivityMaxWaitMs(),
      readSnapshot: async () => {
        const activity = await this.sendRawRequest('activity.snapshot', {}, traceId)
        if (!activity.ok) throw new Error(`${activity.errorCode ?? 'user_activity_unknown'}: ${activity.errorSummary ?? command}`)
        return normalizeWeChatChannelActivitySnapshot(activity.result)
      },
      sleep,
    })
    if (!decision.ok) throw new Error(`user_active:${decision.reasonCode}`)
  }

  private async tryRecoverFromStuckShell(traceId?: string): Promise<boolean> {
    try {
      const probe = await this.sendRawRequest<{ stuckShell?: boolean }>('wechat.healthProbe', {}, traceId)
      if (!probe.ok || probe.result?.stuckShell !== true) return false
      const recovered = await this.sendRawRequest<{ started?: boolean }>('windows.recoverWeChat', {
        allowRestart: true,
        onlyIfUnresponsive: false,
        waitAfterStartMs: 4_000,
      }, traceId)
      return recovered.ok === true && recovered.result?.started === true
    } catch {
      return false
    }
  }

  private async requestFirstMissingMacPermissionPrompt(
    result: {
      screenRecording?: boolean
      accessibility?: boolean
      inputMonitoring?: boolean
    },
    traceId?: string,
  ): Promise<'screen-recording' | 'accessibility' | 'input-monitoring' | null> {
    const missing = firstMissingMacPermission(result)
    if (!missing || process.platform !== 'darwin') return missing

    const command = macPermissionPromptCommand(missing)
    try {
      await this.sendRawRequest(command, {}, traceId)
    } catch {
      // Preserve the original permission failure; prompting is best-effort.
    }
    return missing
  }

  private async cleanupWindowsOverlaysAfterCommand(command: WeChatChannelHelperCommandName, traceId?: string): Promise<void> {
    if (!this.options.guardUnsafeWindowsCommands || !isPostActionCleanupCommand(command)) return
    await this.cleanupWindowsOverlays('after', command, traceId)
  }

  private async cleanupWindowsOverlays(stage: 'before' | 'after', command: WeChatChannelHelperCommandName, traceId?: string): Promise<void> {
    if (this.options.cleanupWindowsOverlays === false) return
    if (!this.readyState?.capabilities.includes('overlayCleanup')) {
      throw new Error('helper_capability_missing: overlayCleanup')
    }
    const response = await this.sendRawRequest('windows.cleanupOverlays', {
      stage,
      command,
      includeGeneratedMediaPreviews: true,
      includeToolingTerminals: false,
      waitMs: stage === 'after' ? 220 : 120,
    }, traceId)
    if (!response.ok) {
      throw new Error(`${response.errorCode ?? 'overlay_cleanup_failed'}: ${response.errorSummary ?? command}`)
    }
  }

  async healthCheck(traceId?: string): Promise<WeChatChannelHelperResponse<WeChatChannelHelperHealthResult>> {
    return this.request<WeChatChannelHelperHealthResult>('health.check', {}, traceId)
  }

  getReadyState(): WeChatChannelHelperReady | null {
    return this.readyState ? { ...this.readyState, capabilities: [...this.readyState.capabilities] } : null
  }

  getWarmupState(): WeChatChannelHelperWarmupSnapshot | null {
    if (!this.warmupState) return null
    return {
      warmState: this.warmupState.warmState,
      metrics: this.warmupState.metrics ? { ...this.warmupState.metrics } : undefined,
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    const socket = this.socket
    this.child = null
    this.socket = null
    this.readyState = null
    this.lines?.close()
    this.lines = null
    this.rejectAllPending(new Error('WeChat channel helper stopped'))
    if (socket && !socket.destroyed) socket.destroy()
    if (!child) return
    await terminateHelperChild(child)
  }

  private hasTransport(): boolean {
    return !!this.child || !!this.socket
  }

  private writeFrame(frame: unknown): void {
    const line = `${JSON.stringify(frame)}\n`
    if (this.socket) {
      this.socket.write(line)
      return
    }
    if (this.child) {
      this.child.stdin.write(line)
      return
    }
    throw new Error('WeChat channel helper is not started')
  }

  private handleLine(line: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (!isResponseFrame(frame)) return
    const pending = this.pending.get(frame.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(frame.id)
    pending.resolve(frame)
  }

  private captureWarmupSnapshot(value: unknown): void {
    const snapshot = extractWeChatChannelHelperWarmupSnapshot(value)
    if (snapshot) this.warmupState = snapshot
  }

  private captureStderr(chunk: unknown): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk ?? '')
    if (!text) return
    this.stderrTail = (this.stderrTail + text).slice(-2_000)
  }

  private formatHelperExitMessage(code: number | null, signal: NodeJS.Signals | null): string {
    const details = [
      code === null ? null : `code=${code}`,
      signal ? `signal=${signal}` : null,
      this.stderrTail.trim() ? `stderr=${this.stderrTail.trim()}` : null,
    ].filter(Boolean)
    return details.length
      ? `WeChat channel helper process exited (${details.join(', ')})`
      : 'WeChat channel helper process exited'
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private emitRequestTrace(event: WeChatChannelHelperRequestTraceEvent): void {
    try {
      this.options.requestLogger?.(event)
    } catch {
      // Diagnostic logging must never break the helper control path.
    }
  }

  private async stopAfterCommandTimeout(command: WeChatChannelHelperCommandName): Promise<void> {
    const childPid = this.child?.pid
    await this.stop().catch(() => {})
    if (process.platform === 'win32') {
      const pids = typeof childPid === 'number' && childPid > 0 ? [childPid] : []
      await stopWindowsWeChatChannelHelperProcesses(pids).catch(() => {})
    }
    this.emitRequestTrace({
      phase: 'error',
      at: new Date().toISOString(),
      id: `timeout-cleanup:${command}`,
      command,
      errorSummary: 'helper process stopped after command timeout',
    })
  }

  private async connectDarwinHelperSocket(launch: DarwinAppSocketHelperLaunchSpec): Promise<Socket> {
    try {
      return await connectMacosRuntimeSocket(launch.runtimeFile)
    } catch {
      fs.rmSync(launch.runtimeFile, { force: true })
    }

    await launchMacosHelperApp(launch, {}, this.options.openHelperAppForTest)
    const first = await waitForMacosRuntimeSocket(launch.runtimeFile, this.options.macosRuntimeInitialReadyTimeoutMs ?? 5_000)
    if (first.ok) return first.socket

    fs.rmSync(launch.runtimeFile, { force: true })
    await launchMacosHelperApp(launch, { forceNewInstance: true }, this.options.openHelperAppForTest)
    const second = await waitForMacosRuntimeSocket(launch.runtimeFile, this.options.macosRuntimeRelaunchReadyTimeoutMs ?? 10_000)
    if (second.ok) return second.socket
    throw new Error(`WeChat channel Helper.app socket did not become ready: ${second.error.message}`)
  }
}

export async function stopWindowsWeChatChannelHelperProcesses(pids: number[] = []): Promise<void> {
  if (process.platform !== 'win32') return
  // PID-only: a broad name-based kill can sever an unrelated helper instance
  // mid-keystroke and freeze WeChat. The legacy `/IM <name>` form is gone —
  // install/repair paths that genuinely need a broad kill live in runtime.ts
  // and daemon-manager.ts.
  const targets = pids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0)
  if (targets.length === 0) return
  for (const pid of targets) {
    await runWindowsProcessKiller(['taskkill', '/PID', String(pid), '/T', '/F'], [0, 128])
  }
}

type WeChatChannelPermissionsCheckResult = {
  platform?: string
  screenRecording?: boolean
  accessibility?: boolean
  inputMonitoring?: boolean
  automation?: boolean
  wechatRunning?: boolean
  wechatWindowAvailable?: boolean
  wechatMainWindowResponsive?: boolean
  windowsVisibleDesktopAvailable?: boolean
  rdpVisibleDesktopAvailable?: boolean
  desktopSessionVisible?: boolean
  screenLocked?: boolean
  rdpDisconnected?: boolean
  dpiMappingAvailable?: boolean
  displayTopologySupported?: boolean
  captureCandidateCount?: number
  restoreCandidateCount?: number
  hiddenRestoreCandidateCount?: number
  captureCandidates?: WeChatChannelGuardWindowInfo[]
  restoreCandidates?: WeChatChannelGuardWindowInfo[]
  hiddenRestoreCandidates?: WeChatChannelGuardWindowInfo[]
}

function looksLikeStuckShell(result: WeChatChannelPermissionsCheckResult): boolean {
  return result.wechatWindowAvailable === false
    && (result.captureCandidateCount ?? 0) === 0
    && (result.restoreCandidateCount ?? 0) === 0
    && (result.hiddenRestoreCandidateCount ?? 0) === 0
}

type WeChatChannelGuardWindowInfo = {
  appName?: string | null
  visible?: boolean | null
  minimized?: boolean | null
}

function hasLoginRequiredGuardState(result: {
  wechatWindowAvailable?: boolean
  captureCandidates?: WeChatChannelGuardWindowInfo[]
  restoreCandidates?: WeChatChannelGuardWindowInfo[]
  hiddenRestoreCandidates?: WeChatChannelGuardWindowInfo[]
}): boolean {
  if (result.wechatWindowAvailable !== false) return false
  const hasUsableCandidate = [
    ...(result.captureCandidates ?? []),
    ...(result.restoreCandidates ?? []),
    ...(result.hiddenRestoreCandidates ?? []),
  ].some(isUsableGuardWeChatWindow)
  return !hasUsableCandidate
}

function hasUnavailableVisibleDesktopGuardState(result: {
  windowsVisibleDesktopAvailable?: boolean
  rdpVisibleDesktopAvailable?: boolean
  desktopSessionVisible?: boolean
  screenLocked?: boolean
  rdpDisconnected?: boolean
}): boolean {
  return result.windowsVisibleDesktopAvailable === false
    || result.rdpVisibleDesktopAvailable === false
    || result.desktopSessionVisible === false
    || result.screenLocked === true
    || result.rdpDisconnected === true
}

function isGuardWeChatWindow(window: WeChatChannelGuardWindowInfo): boolean {
  const appName = String(window.appName || '').toLowerCase()
  return appName === 'wechat' || appName === 'weixin'
}

function isUsableGuardWeChatWindow(window: WeChatChannelGuardWindowInfo): boolean {
  if (!isGuardWeChatWindow(window)) return false
  if (window.visible === false || window.minimized === true) return false
  return true
}

type LegacyRawHelperLaunchSpec = {
  transport: 'legacy-stdio'
  command: string
  args: string[]
}

type DarwinAppSocketHelperLaunchSpec = {
  transport: 'macos-socket'
  command: string
  args: string[]
  appPath: string
  runtimeDir: string
  runtimeFile: string
}

export type HelperLaunchSpec = LegacyRawHelperLaunchSpec | DarwinAppSocketHelperLaunchSpec

export function helperLaunchSpec(helperPath: string, args: string[], platform: NodeJS.Platform = process.platform): HelperLaunchSpec {
  if (platform === 'darwin') {
    const helperAppPath = macosHelperAppPathForExecutable(helperPath)
    if (helperAppPath && args.length === 0) {
      const runtimeDir = defaultMacosHelperRuntimeDir()
      return {
        transport: 'macos-socket',
        command: '/usr/bin/open',
        args: ['-g', helperAppPath, '--args', '--socket-runtime', runtimeDir],
        appPath: helperAppPath,
        runtimeDir,
        runtimeFile: path.join(runtimeDir, 'runtime.json'),
      }
    }
  }
  return { transport: 'legacy-stdio', command: helperPath, args }
}

function macosHelperAppPathForExecutable(helperPath: string): string | null {
  const normalized = path.resolve(helperPath)
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return null
  const appPath = normalized.slice(0, index)
  return appPath.endsWith('.app') ? appPath : null
}

function defaultMacosHelperRuntimeDir(): string {
  const env = getRuntimeEnv()
  const explicit = env.USECHAT_HELPER_RUNTIME_DIR?.trim()
  if (explicit) return path.resolve(explicit)
  return path.join(os.homedir(), 'Library', 'Application Support', 'UseChat', 'Helper')
}

async function terminateHelperChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (isChildExited(child)) return
  if (process.platform === 'win32' && child.pid) {
    child.kill('SIGTERM')
    await runWindowsProcessKiller(['taskkill', '/PID', String(child.pid), '/T', '/F'], [0, 128]).catch(() => {})
    await waitForChildExit(child, HELPER_STOP_GRACE_MS)
    return
  }

  child.kill('SIGTERM')
  const exited = await waitForChildExit(child, HELPER_STOP_GRACE_MS)
  if (!exited && child.pid && processExists(child.pid)) {
    child.kill('SIGKILL')
    await waitForChildExit(child, HELPER_STOP_GRACE_MS)
  }
}

async function terminateMacosRuntimePid(pid: number | null): Promise<void> {
  if (process.platform !== 'darwin' || !pid || pid === process.pid || !processExists(pid)) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const exited = await waitForPidExit(pid, HELPER_STOP_GRACE_MS)
  if (!exited && processExists(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      return
    }
    await waitForPidExit(pid, HELPER_STOP_GRACE_MS)
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true
    await sleep(Math.min(50, deadline - Date.now()))
  }
  return !processExists(pid)
}

function isChildExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (isChildExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

function runWindowsProcessKiller(command: [string, ...string[]], okExitCodes: number[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command
    const child = spawn(bin, args, {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== null && okExitCodes.includes(code)) resolve()
      else reject(new Error(`${bin} exited ${code}`))
    })
  })
}

function getRuntimeEnv(): NodeJS.ProcessEnv {
  const processLike = (globalThis as unknown as { process?: Record<string, NodeJS.ProcessEnv | undefined> }).process
  return processLike?.[RUNTIME_ENV_PROPERTY] ?? {}
}

function readMacosRuntimeFile(runtimeFile: string): { socketPath: string; pid?: number } {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'))
  } catch (error) {
    throw new Error(`runtime_file_unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('runtime_file_invalid')
  const socketPath = (parsed as Record<string, unknown>).socketPath
  if (typeof socketPath !== 'string' || !socketPath.trim()) throw new Error('runtime_socket_missing')
  const pid = (parsed as Record<string, unknown>).pid
  return { socketPath, ...(typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? { pid } : {}) }
}

async function connectMacosRuntimeSocket(runtimeFile: string): Promise<Socket> {
  const { socketPath, pid } = readMacosRuntimeFile(runtimeFile)
  if (pid && !processExists(pid)) throw new Error(`runtime_process_stale: ${pid}`)
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`runtime_socket_connect_timeout: ${socketPath}`))
    }, 1_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
    const onError = (error: Error) => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
  })
}

async function waitForMacosRuntimeSocket(runtimeFile: string, timeoutMs: number): Promise<{ ok: true; socket: Socket } | { ok: false; error: Error }> {
  const deadline = Date.now() + timeoutMs
  let lastError: Error | null = null
  while (Date.now() < deadline) {
    try {
      return { ok: true, socket: await connectMacosRuntimeSocket(runtimeFile) }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const remainingMs = deadline - Date.now()
      if (remainingMs > 0) await sleep(Math.min(150, remainingMs))
    }
  }
  return { ok: false, error: lastError ?? new Error('runtime file missing') }
}

async function launchMacosHelperApp(
  launch: DarwinAppSocketHelperLaunchSpec,
  options: { forceNewInstance?: boolean } = {},
  openHelperApp: (command: string, args: string[]) => Promise<void> = runOpenHelperApp,
): Promise<void> {
  fs.mkdirSync(launch.runtimeDir, { recursive: true, mode: 0o700 })
  const args = options.forceNewInstance ? ['-n', ...launch.args] : launch.args
  try {
    await openHelperApp(launch.command, args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('-1712')) throw error
    await openHelperApp(launch.command, ['-n', ...launch.args])
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runOpenHelperApp(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2_000)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`open Helper.app failed (${signal ? `signal=${signal}` : `code=${code}`}${stderr.trim() ? `, stderr=${stderr.trim()}` : ''})`))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function firstMissingMacPermission(result: {
  screenRecording?: boolean
  accessibility?: boolean
  inputMonitoring?: boolean
}): 'screen-recording' | 'accessibility' | 'input-monitoring' | null {
  if (result.screenRecording === false) return 'screen-recording'
  if (result.accessibility === false) return 'accessibility'
  if (result.inputMonitoring === false) return 'input-monitoring'
  return null
}

function isMacHelperPreflightPlatform(platform: string | undefined): boolean {
  const normalized = String(platform || '').toLowerCase()
  if (!normalized) return true
  return normalized.includes('darwin') || normalized.includes('mac')
}

function macPermissionPromptCommand(permission: 'screen-recording' | 'accessibility' | 'input-monitoring'): 'permissions.requestScreenRecording' | 'permissions.requestAccessibility' | 'permissions.requestInputMonitoring' {
  if (permission === 'screen-recording') return 'permissions.requestScreenRecording'
  if (permission === 'accessibility') return 'permissions.requestAccessibility'
  return 'permissions.requestInputMonitoring'
}

function isReadyFrame(value: unknown): value is WeChatChannelHelperReady {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record.type === 'ready'
    && typeof record.helperVersion === 'string'
    && typeof record.protocolVersion === 'number'
    && Array.isArray(record.capabilities)
    && typeof record.pid === 'number'
}

function isResponseFrame(value: unknown): value is WeChatChannelHelperResponse {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.ok === 'boolean'
    && typeof record.latencyMs === 'number'
}

function isGuardedWindowsCommand(command: WeChatChannelHelperCommandName): boolean {
  return command === 'windows.focus'
    || command === 'windows.capture'
    || command === 'screen.capture'
    || command === 'ocr.recognize'
    || command === 'image.cropHash'
    || command === 'wechat.searchConversation'
    || command === 'wechat.focusMessageInput'
    || command === 'wechat.pasteAndSubmit'
    || command === 'keyboard.primeTextPaste'
    || command.startsWith('mouse.')
    || command.startsWith('keyboard.')
    || command.startsWith('clipboard.')
    || command === 'menu.pickItem'
    || command === 'savePanel.saveToPath'
}

// Read-only guarded commands: they capture or recognize pixels but never move
// the foreground window, the cursor, the keyboard, or the clipboard. These are
// the commands that arrive in dense bursts during an observe pass, and they are
// safe to run under a recently-passed guard result instead of re-probing the
// full window list before each one. Anything that injects input or changes
// focus is deliberately excluded so it always re-probes fresh.
function isReadOnlyGuardedWindowsCommand(command: WeChatChannelHelperCommandName): boolean {
  return command === 'windows.capture'
    || command === 'screen.capture'
    || command === 'ocr.recognize'
    || command === 'image.cropHash'
}

function isPostActionCleanupCommand(command: WeChatChannelHelperCommandName): boolean {
  return command.startsWith('mouse.')
    || command.startsWith('keyboard.')
    || command.startsWith('clipboard.')
    || command === 'menu.pickItem'
    || command === 'savePanel.saveToPath'
}

function isUserActivityGuardedWindowsCommand(command: WeChatChannelHelperCommandName): boolean {
  return command === 'windows.focus'
    || command === 'wechat.searchConversation'
    || command === 'wechat.focusMessageInput'
    || command === 'wechat.pasteAndSubmit'
    || command === 'keyboard.primeTextPaste'
    || command.startsWith('mouse.')
    || command.startsWith('keyboard.')
    || command.startsWith('clipboard.set')
    || command === 'clipboard.restore'
    || command === 'menu.pickItem'
    || command === 'savePanel.saveToPath'
}
