// @covers ../wechat/attachment.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readUseChatAttachment } from '../wechat/attachment.js'

describe('UseChat WeChat attachments', () => {
  it('reads local attachment metadata and infers MIME from extension', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-attachment-'))
    const filePath = path.join(dir, 'brief.pdf')
    fs.writeFileSync(filePath, 'brief')

    expect(readUseChatAttachment(filePath, 'file')).toEqual({
      kind: 'file',
      name: 'brief.pdf',
      mimeType: 'application/pdf',
      size: 5,
      localPath: filePath,
    })
  })

  it('rejects oversized attachments before helper clipboard operations', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-attachment-large-'))
    const filePath = path.join(dir, 'large.zip')
    fs.writeFileSync(filePath, Buffer.alloc(4))

    expect(() => readUseChatAttachment(filePath, 'file', {
      env: { USECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES: '3' },
    })).toThrow(/Attachment is too large/)
  })
})
