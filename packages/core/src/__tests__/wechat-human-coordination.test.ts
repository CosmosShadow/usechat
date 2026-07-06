// @covers ../wechat/human-coordination.ts

import { describe, expect, it } from 'vitest'
import {
  decideWeChatChannelActivityGate,
  waitForWeChatChannelActivityGate,
  type WeChatChannelHumanActivitySnapshot,
} from '../wechat/human-coordination.js'

describe('wechat human activity coordination', () => {
  it('blocks dangerous actions while recent keyboard activity is present', () => {
    const decision = decideWeChatChannelActivityGate({
      stage: 'dangerous_action',
      snapshot: { keyDownSecondsAgo: 1 },
    })
    expect(decision).toMatchObject({
      ok: false,
      reasonCode: 'recent_keyboard_activity',
      waitMs: 4000,
    })
  })

  it('waits until the desktop is quiet', async () => {
    const snapshots: WeChatChannelHumanActivitySnapshot[] = [
      { keyDownSecondsAgo: 1 },
      { keyDownSecondsAgo: 6 },
    ]
    const sleeps: number[] = []
    const decision = await waitForWeChatChannelActivityGate({
      stage: 'dangerous_action',
      maxWaitMs: 5000,
      readSnapshot: async () => snapshots.shift(),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(decision.ok).toBe(true)
    expect(sleeps).toEqual([4000])
  })

  it('returns the last blocking decision after max wait', async () => {
    const decision = await waitForWeChatChannelActivityGate({
      stage: 'dangerous_action',
      maxWaitMs: 1000,
      readSnapshot: async () => ({ keyDownSecondsAgo: 0 }),
      sleep: async () => {},
    })
    expect(decision).toMatchObject({
      ok: false,
      reasonCode: 'recent_keyboard_activity',
    })
  })
})
