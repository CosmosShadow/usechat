// @covers ../wechat/runtime.ts

import { describe, expect, it } from 'vitest'
import { openConversation, type HelperTransport } from '../wechat/runtime.js'
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
