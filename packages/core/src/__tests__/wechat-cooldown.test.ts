// @covers ../wechat/cooldown.ts

import { describe, expect, it } from 'vitest'
import {
  WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_MS,
  clearExpiredWeChatChannelCooldown,
  isWeChatChannelCooldownActive,
  noteWeChatChannelInterruption,
  noteWeChatChannelStableRun,
} from '../wechat/cooldown.js'

describe('WeChat channel cooldown policy', () => {
  it('enters cooldown after repeated interruptions and clears after expiry', () => {
    const now = new Date('2026-06-12T00:00:00.000Z')
    let state = noteWeChatChannelInterruption({ now, reason: 'user_activity' })
    state = noteWeChatChannelInterruption({ state, now, reason: 'user_activity' })
    expect(isWeChatChannelCooldownActive(state, now)).toBe(false)
    state = noteWeChatChannelInterruption({ state, now, reason: 'user_activity' })
    expect(isWeChatChannelCooldownActive(state, now)).toBe(true)
    expect(state.cooldownUntil).toBe(new Date(now.getTime() + WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_MS).toISOString())

    const cleared = clearExpiredWeChatChannelCooldown(state, new Date(now.getTime() + WECHAT_CHANNEL_INTERRUPTION_COOLDOWN_MS + 1))
    expect(cleared.cooldownUntil).toBeNull()
  })

  it('resets interruption counter on stable run', () => {
    const state = noteWeChatChannelInterruption({ now: new Date('2026-06-12T00:00:00.000Z') })
    expect(noteWeChatChannelStableRun(state).consecutiveInterruptions).toBe(0)
  })
})
