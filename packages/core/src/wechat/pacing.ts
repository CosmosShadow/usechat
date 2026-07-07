// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-outbound-sender.test.ts

const DEFAULT_WECHAT_CHANNEL_PACING_MS: Record<string, number> = {
  'send-focus-stabilize': 320,
  'send-focus-retry': 420,
  'send-post-paste': 500,
}

const lastByKey = new Map<string, number>()

export async function waitForWeChatChannelPacing(
  bucket: string,
  key: string,
  minIntervalMs?: number,
): Promise<void> {
  const intervalMs = minIntervalMs ?? DEFAULT_WECHAT_CHANNEL_PACING_MS[bucket] ?? 0
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return
  const now = Date.now()
  const previous = lastByKey.get(`${bucket}:${key}`) ?? 0
  const waitMs = Math.max(0, previous + intervalMs - now)
  lastByKey.set(`${bucket}:${key}`, now + waitMs)
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
}
