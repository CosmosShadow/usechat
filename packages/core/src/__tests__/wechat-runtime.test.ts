// @covers ../wechat/runtime.ts

import { describe, expect, it } from 'vitest'
import { createWeChatRuntime, openConversation, type HelperTransport, type WeChatVisionProvider } from '../wechat/runtime.js'
import type { WeChatChannelHelperCommandName, WeChatChannelHelperResponse } from '../wechat/helper-protocol.js'

type HelperCall = {
  command: WeChatChannelHelperCommandName
  params?: Record<string, unknown>
}

describe('wechat runtime openConversation', () => {
  it('does not search when the target conversation title is already visible', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([{ text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } }])),
    ])

    const result = await openConversation({ helper, chat: 'ABC', platform: 'win32' })

    expect(result.opened).toBe(true)
    expect(helper.commands()).not.toContain('wechat.searchConversation')
    expect(helper.commands()).not.toContain('keyboard.shortcut')
  })

  it('clicks an exact visible search result before falling back to Enter', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([{ text: '文件传输助手', bbox: { x: 470, y: 50, width: 150, height: 32 } }])),
      ok({ searched: true }),
      ok(captureAndOcr([
        { text: 'ABC', bbox: { x: 170, y: 145, width: 70, height: 36 } },
        { text: '外部测试群。', bbox: { x: 170, y: 185, width: 150, height: 32 } },
      ])),
      ok({ clicked: true }),
    ])

    await openConversation({ helper, chat: 'ABC', platform: 'win32' })

    expect(helper.commands()).toContain('wechat.searchConversation')
    expect(helper.commands()).toContain('mouse.click')
    expect(helper.commands()).not.toContain('keyboard.shortcut')
  })

  it('stops before searching when WeChat requires login', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: '微信', bbox: { x: 100, y: 50, width: 80, height: 32 } },
        { text: '扫码登录', bbox: { x: 400, y: 150, width: 120, height: 40 } },
        { text: '仅传输文件', bbox: { x: 420, y: 720, width: 140, height: 36 } },
      ])),
    ])

    await expect(openConversation({ helper, chat: 'ABC', platform: 'win32' })).rejects.toThrow('wechat_login_required')
    expect(helper.commands()).not.toContain('wechat.searchConversation')
    expect(helper.commands()).not.toContain('keyboard.shortcut')
  })
})

describe('wechat runtime read/write', () => {
  it('runs a read flow with a mock helper and provider', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
      ])),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: 'hello from ABC', bbox: { x: 480, y: 320, width: 180, height: 36 } },
      ])),
    ])
    const provider = new FakeProvider([
      { senderRole: 'contact', senderName: 'ABC', kind: 'text', normalizedText: 'hello from ABC' },
    ])
    const runtime = createWeChatRuntime({ helperTransport: helper, provider, platform: 'win32' })

    const result = await runtime.read({ chat: 'ABC', limit: 10, format: 'json', download: 'never' })

    expect(result.messages).toHaveLength(1)
    expect(result.markdown).toContain('ABC: hello from ABC')
    expect(helper.commands()).toEqual([
      'permissions.check',
      'windows.ensureReady',
      'windows.captureAndOcr',
      'windows.captureAndOcr',
    ])
    expect(provider.calls).toHaveLength(1)
  })

  it('orders fully boxed model messages by visible position and removes invalid bboxes', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
      ])),
      ok(captureAndOcr([])),
    ])
    const provider = new FakeProvider([
      { senderRole: 'contact', kind: 'text', normalizedText: 'second', bbox: { x: 520, y: 420, width: 160, height: 36 } },
      { senderRole: 'contact', kind: 'text', normalizedText: 'first', bbox: { x: 520, y: 320, width: 160, height: 36 } },
      { senderRole: 'contact', kind: 'text', normalizedText: 'third', bbox: { x: 520, y: 520, width: -1, height: 36 } },
    ])
    const runtime = createWeChatRuntime({ helperTransport: helper, provider, platform: 'win32' })

    const result = await runtime.read({ chat: 'ABC', format: 'json' })

    expect(result.messages.map((message) => message.normalizedText)).toEqual(['first', 'second', 'third'])
    expect(result.messages[2]?.bbox).toBeUndefined()
    expect(result.quality?.ok).toBe(true)
    expect(result.quality?.metrics).toMatchObject({
      messageCount: 3,
      comparableBboxCount: 2,
      invalidBboxCount: 0,
      nonMonotonicPairCount: 0,
    })
  })

  it('does not resolve or call helper during dry run writes', async () => {
    const helper = new FakeHelper([])
    const runtime = createWeChatRuntime({ helperTransport: helper, platform: 'win32' })

    const result = await runtime.write({ chat: 'ABC', text: 'hello', dryRun: true, yes: true })

    expect(result).toMatchObject({ ok: true, sent: false, status: 'dry-run' })
    expect(helper.commands()).toEqual([])
  })

  it('runs a Windows write flow with one atomic paste-and-submit helper call', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: '发送', bbox: { x: 1030, y: 760, width: 60, height: 36 } },
      ])),
      ok({ sequenceNumber: 1 }),
      ok({ submitted: true }),
      ok({ restored: true }),
    ])
    const runtime = createWeChatRuntime({ helperTransport: helper, platform: 'win32' })

    const result = await runtime.write({ chat: 'ABC', text: 'hello', yes: true })

    expect(result).toMatchObject({ ok: true, sent: true, status: 'sent-unconfirmed' })
    expect(helper.commands()).toEqual([
      'permissions.check',
      'windows.ensureReady',
      'windows.captureAndOcr',
      'clipboard.snapshot',
      'wechat.pasteAndSubmit',
      'clipboard.restore',
    ])
    expect(helper.calls.find((call) => call.command === 'wechat.pasteAndSubmit')?.params).toMatchObject({
      text: 'hello',
      windowId: '100',
      inputPoint: { coordinateSpace: 'screen' },
    })
  })

  it('runs a macOS write flow through the System Events submit hook', async () => {
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: '发送', bbox: { x: 1030, y: 760, width: 60, height: 36 } },
      ])),
      ok({ sequenceNumber: 1 }),
      ok({ copied: true }),
      ok({ restored: true }),
    ])
    const submitted: unknown[] = []
    const runtime = createWeChatRuntime({
      helperTransport: helper,
      platform: 'darwin',
      macosSubmitText: async (input) => {
        submitted.push(input)
      },
    })

    const result = await runtime.write({ chat: 'ABC', text: 'hello', yes: true })

    expect(result).toMatchObject({ ok: true, sent: true, status: 'sent-unconfirmed' })
    expect(helper.commands()).toEqual([
      'permissions.check',
      'windows.ensureReady',
      'windows.captureAndOcr',
      'clipboard.snapshot',
      'clipboard.setText',
      'clipboard.restore',
    ])
    expect(submitted[0]).toMatchObject({
      text: 'hello',
      window: { windowId: '100' },
      inputPoint: { coordinateSpace: 'screen' },
    })
  })
})

class FakeHelper implements HelperTransport {
  readonly calls: HelperCall[] = []

  constructor(private readonly responses: Array<WeChatChannelHelperResponse<unknown>>) {}

  async request<T = unknown>(command: WeChatChannelHelperCommandName, params?: Record<string, unknown>): Promise<WeChatChannelHelperResponse<T>> {
    this.calls.push({ command, params })
    const response = this.responses.shift()
    if (!response) throw new Error(`unexpected command: ${command}`)
    return response as WeChatChannelHelperResponse<T>
  }

  commands(): WeChatChannelHelperCommandName[] {
    return this.calls.map((call) => call.command)
  }
}

function ok<T>(result: T): WeChatChannelHelperResponse<T> {
  return { id: 'test', ok: true, result }
}

function windowInfo() {
  return {
    windowId: '100',
    appName: 'WeChat',
    title: '微信',
    bounds: { x: 0, y: 0, width: 1200, height: 900 },
  }
}

function captureAndOcr(blocks: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }>) {
  return {
    capture: {
      mimeType: 'image/png',
      dataBase64: 'x',
      width: 1200,
      height: 900,
      bounds: { x: 0, y: 0, width: 1200, height: 900 },
    },
    ocr: { blocks },
  }
}

class FakeProvider implements WeChatVisionProvider {
  readonly calls: unknown[] = []

  constructor(private readonly structuredMessages: unknown[]) {}

  async structureVisibleWindow(input: Parameters<WeChatVisionProvider['structureVisibleWindow']>[0]) {
    this.calls.push(input)
    return { ok: true as const, structuredMessages: this.structuredMessages }
  }
}
