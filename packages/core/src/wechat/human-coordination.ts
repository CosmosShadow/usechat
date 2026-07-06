// @arch docs/features/wechat-rpa/human-coordination.md
// @test src/__tests__/wechat-channel-human-coordination.test.ts

import type {
  WeChatChannelHumanActivityReasonCode,
  WeChatChannelHumanActivitySnapshot,
} from './helper-protocol.js'

export type WeChatChannelActivityGateStage =
  | 'observe'
  | 'send_start'
  | 'download'
  | 'open_conversation'
  | 'dangerous_action'

export type WeChatChannelActivityGatePolicy = {
  mouseMovedThresholdMs: number
  mouseClickThresholdMs: number
  scrollWheelThresholdMs: number
  keyDownThresholdMs: number
}

export type WeChatChannelActivityGateDecision =
  | {
    ok: true
    stage: WeChatChannelActivityGateStage
  }
  | {
    ok: false
    stage: WeChatChannelActivityGateStage
    reasonCode: WeChatChannelHumanActivityReasonCode
    waitMs: number
  }

export const DEFAULT_WECHAT_CHANNEL_ACTIVITY_GATE_POLICY: WeChatChannelActivityGatePolicy = {
  mouseMovedThresholdMs: 2_000,
  mouseClickThresholdMs: 3_000,
  scrollWheelThresholdMs: 3_000,
  keyDownThresholdMs: 5_000,
}

export function decideWeChatChannelActivityGate(input: {
  snapshot: WeChatChannelHumanActivitySnapshot | null | undefined
  stage: WeChatChannelActivityGateStage
  policy?: Partial<WeChatChannelActivityGatePolicy>
}): WeChatChannelActivityGateDecision {
  const snapshot = input.snapshot
  if (!snapshot) return { ok: true, stage: input.stage }
  const policy = { ...DEFAULT_WECHAT_CHANNEL_ACTIVITY_GATE_POLICY, ...input.policy }
  const candidates: Array<{
    reasonCode: WeChatChannelHumanActivityReasonCode
    secondsAgo?: number
    thresholdMs: number
  }> = [
    {
      reasonCode: 'recent_keyboard_activity',
      secondsAgo: snapshot.keyDownSecondsAgo,
      thresholdMs: policy.keyDownThresholdMs,
    },
    {
      reasonCode: 'recent_mouse_click',
      secondsAgo: Math.min(
        finiteOrInfinity(snapshot.leftMouseDownSecondsAgo),
        finiteOrInfinity(snapshot.rightMouseDownSecondsAgo),
      ),
      thresholdMs: policy.mouseClickThresholdMs,
    },
    {
      reasonCode: 'recent_scroll_activity',
      secondsAgo: snapshot.scrollWheelSecondsAgo,
      thresholdMs: policy.scrollWheelThresholdMs,
    },
    {
      reasonCode: 'recent_mouse_activity',
      secondsAgo: snapshot.mouseMovedSecondsAgo,
      thresholdMs: policy.mouseMovedThresholdMs,
    },
  ]

  let blocked: { reasonCode: WeChatChannelHumanActivityReasonCode; waitMs: number } | null = null
  for (const candidate of candidates) {
    const elapsedMs = secondsToMs(candidate.secondsAgo)
    if (elapsedMs == null || elapsedMs >= candidate.thresholdMs) continue
    const waitMs = Math.ceil(candidate.thresholdMs - elapsedMs)
    if (!blocked || waitMs > blocked.waitMs) blocked = { reasonCode: candidate.reasonCode, waitMs }
  }

  if (!blocked) return { ok: true, stage: input.stage }
  return {
    ok: false,
    stage: input.stage,
    reasonCode: blocked.reasonCode,
    waitMs: blocked.waitMs,
  }
}

export function normalizeWeChatChannelActivitySnapshot(value: unknown): WeChatChannelHumanActivitySnapshot | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  const snapshot: WeChatChannelHumanActivitySnapshot = {}
  copyNumber(source, snapshot, 'mouseMovedSecondsAgo')
  copyNumber(source, snapshot, 'leftMouseDownSecondsAgo')
  copyNumber(source, snapshot, 'rightMouseDownSecondsAgo')
  copyNumber(source, snapshot, 'scrollWheelSecondsAgo')
  copyNumber(source, snapshot, 'keyDownSecondsAgo')
  if (source.frontmostApp && typeof source.frontmostApp === 'object') {
    const app = source.frontmostApp as Record<string, unknown>
    snapshot.frontmostApp = {
      bundleId: stringOrUndefined(app.bundleId),
      localizedName: stringOrUndefined(app.localizedName),
    }
  }
  if (source.permissions && typeof source.permissions === 'object') {
    const permissions = source.permissions as Record<string, unknown>
    snapshot.permissions = {
      accessibilityTrusted: booleanOrUndefined(permissions.accessibilityTrusted),
      iohidListenGranted: booleanOrUndefined(permissions.iohidListenGranted),
      iohidPostGranted: booleanOrUndefined(permissions.iohidPostGranted),
    }
  }
  if (source.privacy && typeof source.privacy === 'object') {
    const privacy = source.privacy as Record<string, unknown>
    snapshot.privacy = {
      capturesKeyContent: booleanOrUndefined(privacy.capturesKeyContent),
      capturesMousePath: booleanOrUndefined(privacy.capturesMousePath),
    }
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null
}

export function nextWeChatChannelActivityRetryAt(now: Date, waitMs: number): Date {
  const retryDelayMs = Math.max(1_000, Math.ceil(waitMs / 1000) * 1000)
  return new Date(now.getTime() + retryDelayMs)
}

function secondsToMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value * 1000
}

function finiteOrInfinity(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

function copyNumber(
  source: Record<string, unknown>,
  target: WeChatChannelHumanActivitySnapshot,
  key: keyof Pick<WeChatChannelHumanActivitySnapshot,
    'mouseMovedSecondsAgo' | 'leftMouseDownSecondsAgo' | 'rightMouseDownSecondsAgo' | 'scrollWheelSecondsAgo' | 'keyDownSecondsAgo'>,
): void {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) target[key] = value
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}
