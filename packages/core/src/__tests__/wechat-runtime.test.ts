// @covers ../wechat/runtime.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

    const tracePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-runtime-trace-')), 'read.jsonl')

    const result = await runtime.read({ chat: 'ABC', limit: 10, format: 'json', download: 'never', traceId: 'read-trace-test', traceJsonlPath: tracePath })

    expect(result.messages).toHaveLength(1)
    expect(result.markdown).toContain('ABC: hello from ABC')
    expect(result.traceSummary).toMatchObject({
      traceId: 'read-trace-test',
      operation: 'read',
      status: 'ok',
      jsonlPath: tracePath,
    })
    expect(result.traceSummary?.phases.map((phase) => phase.phase)).toEqual(expect.arrayContaining([
      'preflight',
      'open_conversation',
      'capture_window',
      'structure_window_request',
      'structure_window_response',
      'normalize_messages',
      'media_resolve_attempt',
      'validate_messages',
      'run_summary',
    ]))
    const traceLines = fs.readFileSync(tracePath, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
    expect(traceLines.some((line) => line.phase === 'capture_window')).toBe(true)
    expect(JSON.stringify(traceLines)).not.toContain('dataBase64')
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


  it('resolves inbound media during read --download auto through the copied Shennian media resolver', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-inbound-source-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = new FakeHelper([
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
      ])),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: 'photo', bbox: { x: 520, y: 320, width: 180, height: 120 } },
      ])),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
      ])),
      ok({ changeCount: 1 }),
      ok({ clicked: true }),
      ok({ mimeType: 'image/png', dataBase64: 'menu-png', width: 1200, height: 900 }),
      ok({ blocks: [{ text: '复制图片', bbox: { x: 620, y: 360, width: 80, height: 24 } }] }),
      ok({ clicked: true }),
      ok({ filePaths: [sourcePath], changeCount: 2 }),
      ok({ restored: true }),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
      ])),
    ])
    const provider = new FakeProvider([
      {
        stableMessageKey: 'img-1',
        senderRole: 'contact',
        kind: 'image',
        anchorText: 'photo',
        bbox: { x: 520, y: 320, width: 180, height: 120 },
        mediaMetadata: {
          attachment: { type: 'image', name: 'photo.png', availability: 'metadata-only' },
        },
      },
    ])
    const runtime = createWeChatRuntime({ helperTransport: helper, provider, platform: 'darwin' })

    const result = await runtime.read({ chat: 'ABC', format: 'json', download: 'auto' })
    expect(result.messages[0]?.mediaMetadata).toMatchObject({
      mediaStatus: 'downloaded',
      edgeResolveReasonCode: 'edge_local',
      attachment: {
        type: 'image',
        name: 'photo.png',
        availability: 'edge-local',
        sourceAction: 'materialize-clipboard',
        materializationKind: 'original-file',
        isOriginal: true,
      },
    })
    const metadata = result.messages[0]?.mediaMetadata as { attachment?: { localPath?: string } }
    expect(metadata.attachment?.localPath).toContain('attachments')
    expect(fs.existsSync(metadata.attachment?.localPath || '')).toBe(true)
    expect(helper.commands()).toContain('mouse.rightClick')
    expect(helper.commands()).toContain('clipboard.readAttachment')
  })

  it('does not resolve or call helper during dry run writes', async () => {
    const helper = new FakeHelper([])
    const runtime = createWeChatRuntime({ helperTransport: helper, platform: 'win32' })

    const result = await runtime.write({ chat: 'ABC', text: 'hello', dryRun: true, yes: true, traceId: 'dry-run-write-trace' })

    expect(result).toMatchObject({ ok: true, sent: false, status: 'dry-run' })
    expect(result.traceSummary).toMatchObject({
      traceId: 'dry-run-write-trace',
      operation: 'write',
      status: 'ok',
    })
    expect(helper.commands()).toEqual([])
  })

  it('runs a Windows write flow with one atomic paste-and-submit helper call', async () => {
    const helper = new FakeHelper([
      ok(activitySnapshot()),
      ok({ leaseId: 'lease1' }),
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: '发送', bbox: { x: 1030, y: 760, width: 60, height: 36 } },
      ])),
      ok({ focused: true }),
      ok({ sequenceNumber: 1 }),
      ok({ submitted: true }),
      ok({ restored: true }),
      ok({ released: true }),
    ])
    const runtime = createWeChatRuntime({ helperTransport: helper, platform: 'win32' })

    const result = await runtime.write({ chat: 'ABC', text: 'hello', yes: true })

    expect(result).toMatchObject({ ok: true, sent: true, status: 'sent-unconfirmed' })
    expect(helper.commands()).toEqual([
      'activity.snapshot',
      'automation.lease.acquire',
      'permissions.check',
      'windows.ensureReady',
      'windows.captureAndOcr',
      'wechat.focusMessageInput',
      'clipboard.snapshot',
      'wechat.pasteAndSubmit',
      'clipboard.restore',
      'automation.lease.release',
    ])
    expect(helper.calls.find((call) => call.command === 'wechat.pasteAndSubmit')?.params).toMatchObject({
      text: 'hello',
      windowId: '100',
      inputPoint: { coordinateSpace: 'screen' },
    })
  })

  it('runs a macOS write flow through the copied Shennian outbound sender path', async () => {
    const helper = new FakeHelper([
      ok(activitySnapshot()),
      ok({ leaseId: 'lease1' }),
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: '发送', bbox: { x: 1030, y: 760, width: 60, height: 36 } },
      ])),
      ok({ focused: true }),
      ok({ sequenceNumber: 1 }),
      ok({ key: 'a' }),
      ok({ key: 'backspace' }),
      ok({ copied: true }),
      ok({ key: 'v' }),
      ok({ key: 'return' }),
      ok({ restored: true }),
      ok({ released: true }),
    ])
    const runtime = createWeChatRuntime({
      helperTransport: helper,
      platform: 'darwin',
    })

    const result = await runtime.write({ chat: 'ABC', text: 'hello', yes: true })

    expect(result).toMatchObject({ ok: true, sent: true, status: 'sent-unconfirmed' })
    expect(helper.commands()).toEqual([
      'activity.snapshot',
      'automation.lease.acquire',
      'permissions.check',
      'windows.ensureReady',
      'windows.captureAndOcr',
      'wechat.focusMessageInput',
      'clipboard.snapshot',
      'keyboard.shortcut',
      'keyboard.shortcut',
      'clipboard.setText',
      'keyboard.shortcut',
      'keyboard.shortcut',
      'clipboard.restore',
      'automation.lease.release',
    ])
    expect(helper.calls.find((call) => call.command === 'clipboard.setText')?.params).toEqual({ text: 'hello' })
    expect(helper.calls.filter((call) => call.command === 'keyboard.shortcut').map((call) => call.params)).toEqual([
      { key: 'a', modifiers: ['command'] },
      { key: 'backspace', modifiers: [] },
      { key: 'v', modifiers: ['command'] },
      { key: 'return', modifiers: [] },
    ])
  })

  it('runs attachment writes through the copied Shennian clipboard file path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-runtime-attachment-'))
    const filePath = path.join(dir, 'brief.pdf')
    fs.writeFileSync(filePath, 'brief')
    const helper = new FakeHelper([
      ok(activitySnapshot()),
      ok({ leaseId: 'lease1' }),
      ok({ wechatRunning: true }),
      ok(windowInfo()),
      ok(captureAndOcr([
        { text: 'ABC(3)', bbox: { x: 480, y: 50, width: 90, height: 32 } },
        { text: '发送', bbox: { x: 1030, y: 760, width: 60, height: 36 } },
      ])),
      ok({ focused: true }),
      ok({ sequenceNumber: 1 }),
      ok({ copiedFiles: true }),
      ok({ key: 'v' }),
      ok({ key: 'return' }),
      ok({ restored: true }),
      ok({ released: true }),
    ])
    const runtime = createWeChatRuntime({ helperTransport: helper, platform: 'darwin' })

    const result = await runtime.write({ chat: 'ABC', file: filePath, yes: true })

    expect(result).toMatchObject({
      ok: true,
      sent: true,
      text: '',
      attachment: {
        kind: 'file',
        name: 'brief.pdf',
        localPath: filePath,
      },
    })
    expect(helper.calls.find((call) => call.command === 'clipboard.setFiles')?.params).toEqual({
      filePaths: [filePath],
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

function activitySnapshot() {
  return {
    keyDownSecondsAgo: 10,
    mouseMovedSecondsAgo: 10,
    leftMouseDownSecondsAgo: 10,
    rightMouseDownSecondsAgo: 10,
    scrollWheelSecondsAgo: 10,
    permissions: {
      accessibilityTrusted: true,
      iohidListenGranted: true,
      iohidPostGranted: true,
    },
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
