// @arch ../../../docs/ARCHITECTURE.md
// @arch docs/features/wechat-rpa/outbound-ledger.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-cooldown.test.ts

export type WeChatChannelCooldownState = {
  consecutiveInterruptions: number
  cooldownUntil?: string | null
  manualReviewReason?: string | null
}

export const WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_THRESHOLD = 3
export const WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_MS = 5 * 60 * 1000
export const WECHAT_CHANNEL_BILLING_PAUSE_MS = 30 * 60 * 1000

export function isWeChatChannelCooldownActive(state: WeChatChannelCooldownState | undefined, now = new Date()): boolean {
  if (!state?.cooldownUntil) return false
  const until = new Date(state.cooldownUntil).getTime()
  return Number.isFinite(until) && until > now.getTime()
}

export function noteWeChatChannelInterruption(input: {
  state?: WeChatChannelCooldownState
  reason?: string
  now?: Date
}): WeChatChannelCooldownState {
  const now = input.now ?? new Date()
  const previous = input.state ?? { consecutiveInterruptions: 0 }
  const consecutiveInterruptions = previous.consecutiveInterruptions + 1
  const next: WeChatChannelCooldownState = {
    consecutiveInterruptions,
    cooldownUntil: previous.cooldownUntil ?? null,
    manualReviewReason: previous.manualReviewReason ?? null,
  }
  if (consecutiveInterruptions >= WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_THRESHOLD) {
    next.cooldownUntil = new Date(now.getTime() + WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_MS).toISOString()
    next.manualReviewReason = input.reason || 'user_interruption_cooldown'
  }
  return next
}

export function noteWeChatChannelStableRun(state?: WeChatChannelCooldownState): WeChatChannelCooldownState {
  return {
    consecutiveInterruptions: 0,
    cooldownUntil: state?.cooldownUntil ?? null,
    manualReviewReason: state?.manualReviewReason ?? null,
  }
}

export function clearExpiredWeChatChannelCooldown(state: WeChatChannelCooldownState, now = new Date()): WeChatChannelCooldownState {
  if (isWeChatChannelCooldownActive(state, now)) return state
  return { ...state, cooldownUntil: null }
}

export function noteWeChatChannelBillingPause(input: {
  state?: WeChatChannelCooldownState
  reason?: string
  now?: Date
}): WeChatChannelCooldownState {
  const now = input.now ?? new Date()
  return {
    consecutiveInterruptions: 0,
    cooldownUntil: new Date(now.getTime() + WECHAT_CHANNEL_BILLING_PAUSE_MS).toISOString(),
    manualReviewReason: input.reason || 'insufficient_credits',
  }
}
