// @covers ../wechat/outbound-sender.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WeChatChannelHelperCommandName, WeChatChannelHelperResponse } from '../wechat/helper-protocol.js'
import {
  enqueueWeChatOutboundReply,
  type WeChatChannelOutboundLedger,
} from '../wechat/outbound-ledger.js'
import {
  sendQueuedWeChatOutboundRecords,
  WeChatChannelOutboundSender,
} from '../wechat/outbound-sender.js'

type HelperCall = {
  command: WeChatChannelHelperCommandName
  params?: Record<string, unknown>
}

describe('WeChat outbound sender', () => {
  it('sends local file attachments through file clipboard without uploading originals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-outbound-file-'))
    const filePath = path.join(dir, 'report.pdf')
    fs.writeFileSync(filePath, 'pdf')
    const ledger = createLedger()
    enqueueWeChatOutboundReply({
      ledger,
      replyId: 'reply1',
      idempotencyKey: 'idem1',
      bindingId: 'binding1',
      runtimeId: 'runtime1',
      sessionId: 'session1',
      conversationName: 'ABC',
      replyBaseRevision: 1,
      attachmentLocalRefs: [filePath],
    })
    const helper = scriptedHelper()
    const sender = new WeChatChannelOutboundSender({
      helper,
      takeoverCheck: false,
      platform: 'darwin',
      openConversation: async () => ({ opened: true, reason: 'fingerprint' }),
      postPasteSettleMs: 0,
    })

    await sendQueuedWeChatOutboundRecords({
      ledger,
      bindingId: 'binding1',
      currentLastInboundRevision: 1,
      sender,
    })

    expect(ledger.records[0]?.sendStatus).toBe('sent_unconfirmed')
    expect(helper.calls.find((call) => call.command === 'clipboard.setFiles')?.params).toEqual({
      filePaths: [filePath],
    })
    expect(JSON.stringify(helper.calls)).not.toContain('dataBase64')
  })

  it('sends Windows image attachments through image clipboard instead of file drop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-outbound-image-'))
    const filePath = path.join(dir, 'photo.png')
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const ledger = createLedger()
    enqueueWeChatOutboundReply({
      ledger,
      replyId: 'reply1',
      idempotencyKey: 'idem1',
      bindingId: 'binding1',
      runtimeId: 'runtime1',
      sessionId: 'session1',
      conversationName: 'ABC',
      replyBaseRevision: 1,
      attachmentLocalRefs: [filePath],
    })
    const helper = scriptedHelper()
    const sender = new WeChatChannelOutboundSender({
      helper,
      takeoverCheck: false,
      platform: 'win32',
      openConversation: async () => ({
        opened: true,
        reason: 'fingerprint',
        inputPoint: { x: 720, y: 900, coordinateSpace: 'screen' },
      }),
      postPasteSettleMs: 0,
    })

    await sendQueuedWeChatOutboundRecords({
      ledger,
      bindingId: 'binding1',
      currentLastInboundRevision: 1,
      sender,
    })

    expect(ledger.records[0]?.sendStatus).toBe('sent_unconfirmed')
    expect(helper.calls.find((call) => call.command === 'clipboard.setImage')?.params).toEqual({ filePath })
    expect(helper.calls.find((call) => call.command === 'keyboard.shortcut')?.params).toEqual({
      key: 'v',
      modifiers: ['control'],
    })
    expect(helper.commands()).not.toContain('clipboard.setFiles')
  })
})

class FakeHelper {
  readonly calls: HelperCall[] = []

  async request<T = unknown>(command: WeChatChannelHelperCommandName, params?: Record<string, unknown>): Promise<WeChatChannelHelperResponse<T>> {
    this.calls.push({ command, params })
    return { id: 'test', ok: true, result: { leaseId: 'lease1' } as T, latencyMs: 1 }
  }

  commands(): WeChatChannelHelperCommandName[] {
    return this.calls.map((call) => call.command)
  }
}

function scriptedHelper(): FakeHelper {
  return new FakeHelper()
}

function createLedger(): WeChatChannelOutboundLedger {
  return { version: 1, runtimeId: 'runtime1', records: [] }
}
