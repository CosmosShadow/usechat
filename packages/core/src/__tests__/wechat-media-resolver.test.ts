// @covers ../wechat/media-resolver.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultWeChatChannelAttachmentDir,
  materializeLocalAttachment,
  resolveVisibleWeChatChannelMedia,
} from '../wechat/media-resolver.js'
import { findCachedWeChatInboundMedia } from '../wechat/media-cache-resolver.js'
import type { HelperTransport as WeChatChannelHelperTransport } from '../wechat/runtime.js'
import type { WeChatChannelHelperCommandName, WeChatChannelHelperResponse } from '../wechat/helper-protocol.js'

function ok<T>(id: string, result: T): WeChatChannelHelperResponse<T> {
  return { id, ok: true, result, latencyMs: 1 }
}

describe('WeChat channel media resolver', () => {
  it('defaults inbound attachments to user-level Shennian storage per runtime and binding', () => {
    const priorHome = process.env.USECHAT_DATA_DIR
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-home-'))
    process.env.USECHAT_DATA_DIR = home
    try {
      expect(defaultWeChatChannelAttachmentDir('/work', 'runtime1', 'binding1')).toMatch(
        new RegExp(`${escapeRegExp(path.join(home, 'attachments', 'inbound'))}${escapeRegExp(path.sep)}[a-f0-9]{16}$`),
      )
    } finally {
      if (priorHome === undefined) delete process.env.USECHAT_DATA_DIR
      else process.env.USECHAT_DATA_DIR = priorHome
    }
  })

  it('materializes only local file metadata and bytes, never server URLs', () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'brief.pdf')
    fs.writeFileSync(sourcePath, 'unit pdf bytes')

    const attachment = materializeLocalAttachment({
      messageKey: 'm1',
      kind: 'file',
      fileName: 'brief.pdf',
      mimeType: 'application/pdf',
    }, sourcePath, targetDir)

    expect(attachment).toMatchObject({
      type: 'file',
      name: 'brief.pdf',
      mimeType: 'application/pdf',
      size: 'unit pdf bytes'.length,
      extension: '.pdf',
      availability: 'edge-local',
    })
    expect(attachment.localPath).toContain(targetDir)
    expect(attachment.url).toBeUndefined()
    expect(attachment.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('resolves visible media through right-click copy and clipboard file URLs', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制图片'),
      ['clipboard.readAttachment', ok('files', { fileUrls: [`file://${sourcePath}`], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'm1',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ messageKey: 'm1', reasonCode: 'edge_local' })
    expect(result[0].attachment).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      size: 'png bytes'.length,
      extension: '.png',
      availability: 'edge-local',
      sourceAction: 'materialize-clipboard',
    })
    expect(helper.request).toHaveBeenNthCalledWith(2, 'mouse.rightClick', {
      x: 60,
      y: 60,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
  })

  it('uses file-specific copy menu labels for document cards', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'brief.txt')
    fs.writeFileSync(sourcePath, 'txt bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制文件'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'file1',
        kind: 'file',
        fileName: 'brief.txt',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(helper.request).toHaveBeenNthCalledWith(3, 'windows.capture', expect.objectContaining({
      windowId: 'win1',
      scope: 'full-window',
    }), undefined)
    expect(helper.request).toHaveBeenNthCalledWith(4, 'ocr.recognize', expect.objectContaining({
      dataBase64: 'menu-png',
    }), undefined)
  })

  it('retries document card context menus from alternate in-card points before giving up', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'brief.txt')
    fs.writeFileSync(sourcePath, 'txt bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-title', { clicked: true })],
      ...ocrMenuMiss(),
      ['keyboard.shortcut', ok('escape-after-title-menu', { pressed: true })],
      ['mouse.rightClick', ok('right-click-body', { clicked: true })],
      ...ocrMenu('复制文件'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'file-retry-point',
        kind: 'file',
        fileName: 'brief.txt',
        bbox: { x: 100, y: 200, width: 300, height: 120, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'file-retry-point',
      reasonCode: 'edge_local',
      attachment: {
        type: 'file',
        availability: 'edge-local',
        name: 'brief.txt',
        extension: '.txt',
      },
    })
    expect(helper.request).toHaveBeenNthCalledWith(2, 'mouse.rightClick', {
      x: 202,
      y: 238.4,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
    expect(helper.request).toHaveBeenNthCalledWith(5, 'keyboard.shortcut', {
      key: 'escape',
      modifiers: [],
    }, undefined)
    expect(helper.request).toHaveBeenNthCalledWith(6, 'mouse.rightClick', {
      x: 238,
      y: 269.6,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
    expect(result[0]?.resolveTrace?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'copy-before-download',
        pointAttempt: 1,
        pointRole: 'file-title',
        ok: false,
        reasonCode: 'menu_ocr_copy_not_found',
      }),
      expect.objectContaining({
        phase: 'copy-before-download',
        pointAttempt: 2,
        pointRole: 'file-body',
        ok: true,
        pickedLabel: '复制文件',
      }),
    ]))
  })

  it('retries image context menus from alternate in-bubble points before giving up', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-top-left-first', { clicked: true })],
      ['screen.capture', ok('miss-capture', { mimeType: 'image/png', dataBase64: 'menu-png', width: 500, height: 500 })],
      ['ocr.recognize', ok('miss-ocr', { blocks: [{ text: '引用', bbox: { x: 100, y: 100, width: 80, height: 24, coordinateSpace: 'screenshotPixel' } }] })],
      ['keyboard.shortcut', ok('escape-after-top-left-menu', { pressed: true })],
      ['mouse.rightClick', ok('right-click-top-right', { clicked: true })],
      ...ocrMenu('复制图片', { capture: 'screen' }),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 0, y: 0, width: 900, height: 700, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'image-retry-point',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 100, y: 200, width: 300, height: 180, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image-retry-point',
      reasonCode: 'edge_local',
      attachment: {
        type: 'image',
        availability: 'edge-local',
        name: 'photo.png',
        extension: '.png',
      },
    })
    expect(helper.request).toHaveBeenNthCalledWith(2, 'mouse.rightClick', {
      x: 148,
      y: 232.4,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
    expect(helper.request).toHaveBeenNthCalledWith(5, 'keyboard.shortcut', {
      key: 'escape',
      modifiers: [],
    }, undefined)
    expect(helper.request).toHaveBeenNthCalledWith(6, 'mouse.rightClick', {
      x: 352,
      y: 232.4,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
    expect(result[0]?.resolveTrace?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'copy-before-download',
        pointAttempt: 1,
        pointRole: 'media-top-left',
        ok: false,
        reasonCode: 'menu_ocr_copy_not_found',
      }),
      expect.objectContaining({
        phase: 'copy-before-download',
        pointAttempt: 2,
        pointRole: 'media-top-right',
        ok: true,
        pickedLabel: '复制图片',
      }),
    ]))
  })

  it('retries image copy from another point when the first copy changes no clipboard attachment', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-top-left', { clicked: true })],
      ...ocrMenu('复制', { capture: 'screen' }),
      ...emptyClipboardReads(12),
      ['keyboard.shortcut', ok('escape-after-empty-copy', { pressed: true })],
      ['mouse.rightClick', ok('right-click-top-right', { clicked: true })],
      ...ocrMenu('复制图片', { capture: 'screen' }),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 0, y: 0, width: 900, height: 700, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'image-empty-copy-retry-point',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 100, y: 200, width: 300, height: 180, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image-empty-copy-retry-point',
      reasonCode: 'edge_local',
      attachment: {
        type: 'image',
        availability: 'edge-local',
        name: 'photo.png',
        extension: '.png',
      },
      resolveTrace: {
        attempts: expect.arrayContaining([
          expect.objectContaining({
            phase: 'copy-before-download',
            pointAttempt: 1,
            pointRole: 'media-top-left',
            ok: false,
            reasonCode: 'clipboard_attachment_unavailable',
          }),
          expect.objectContaining({
            phase: 'copy-before-download',
            pointAttempt: 2,
            pointRole: 'media-top-right',
            ok: true,
            pickedLabel: '复制图片',
          }),
        ]),
      },
    })
  })

  it('passes screen search bounds to OCR menu capture when a live window context is available', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制图片', { capture: 'screen' }),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 100, y: 50, width: 1000, height: 800, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'image-with-window',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 580, y: 500, width: 180, height: 90, coordinateSpace: 'screen' },
      }],
    })

    expect(helper.request).toHaveBeenNthCalledWith(3, 'screen.capture', {
      bounds: expect.objectContaining({
        x: 440,
        y: 120,
        width: 440,
        height: 760,
        coordinateSpace: 'screen',
      }),
    }, undefined)
  })

  it('falls back to metadata-only for unsupported cards or missing clipboard file URL', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const noFileHelper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制'),
      ...emptyClipboardReads(12),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper: noFileHelper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [
        { messageKey: 'card1', kind: 'card', fileName: 'card', mediaStatus: 'metadata_only' },
        { messageKey: 'img1', kind: 'image', bbox: { x: 0, y: 0, width: 10, height: 10 }, mediaStatus: 'not_downloaded' },
      ],
    })

    expect(result.map((item) => [item.messageKey, item.reasonCode, item.attachment.availability])).toEqual([
      ['card1', 'unsupported_share_card', 'metadata-only'],
      ['img1', 'clipboard_attachment_unavailable', 'pending-download'],
    ])
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('uses the shared action plan to reject share cards before local media actions', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      candidates: [{
        messageKey: 'video-card',
        kind: 'video-card',
        fileName: 'shared-video',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'video-card',
        reasonCode: 'unsupported_share_card',
        attachment: expect.objectContaining({
          availability: 'metadata-only',
          providerError: 'unsupported_share_card',
        }),
      }),
    ])
    expect(helper.request).not.toHaveBeenCalled()
  })

  it('keeps the observe round alive when a media copy menu is unavailable', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenuMiss(),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    await expect(resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'video1',
        kind: 'video',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        mediaStatus: 'not_downloaded',
      }],
    })).resolves.toEqual([
      expect.objectContaining({
        messageKey: 'video1',
        reasonCode: 'menu_ocr_copy_not_found',
        attachment: expect.objectContaining({
          type: 'video',
          availability: 'pending-download',
          providerError: 'menu_ocr_copy_not_found',
        }),
      }),
    ])
  })

  it('writes a stable reason code when the media right-click action fails', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', { id: 'right-click', ok: false, errorSummary: 'cannot right-click media', latencyMs: 1 }],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      candidates: [{
        messageKey: 'image-right-click-failed',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'image-right-click-failed',
        reasonCode: 'media_right_click_failed',
        attachment: expect.objectContaining({
          type: 'image',
          availability: 'metadata-only',
          providerError: 'media_right_click_failed',
        }),
      }),
    ])
  })

  it('does not count a screenshot preview as a downloaded image original when copy fails', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCArLmtaUAAAAASUVORK5CYII='
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenuMiss(),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      screenshot: { mimeType: 'image/png', dataBase64: sourcePngBase64, width: 2, height: 2 },
      candidates: [{
        messageKey: 'image1',
        kind: 'image',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        screenshotBbox: { x: 0, y: 0, width: 2, height: 2, coordinateSpace: 'screenshotPixel' },
        mediaStatus: 'metadata_only',
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'image1',
        reasonCode: 'menu_ocr_copy_not_found',
        attachment: expect.objectContaining({
          type: 'image',
          availability: 'metadata-only',
          providerError: 'menu_ocr_copy_not_found',
        }),
      }),
    ])
    expect(result[0].attachment.localPath).toBeUndefined()
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('does not count a screenshot preview as a downloaded video original when copy exposes no file URL', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCArLmtaUAAAAASUVORK5CYII='
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ['clipboard.readAttachment', ok('empty', { fileUrls: [], changeCount: 2 })],
      ['clipboard.readAttachment', ok('empty', { fileUrls: [], changeCount: 2 })],
      ['clipboard.readAttachment', ok('empty', { fileUrls: [], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      screenshot: { mimeType: 'image/png', dataBase64: sourcePngBase64, width: 2, height: 2 },
      candidates: [{
        messageKey: 'video-preview',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        screenshotBbox: { x: 0, y: 0, width: 2, height: 2, coordinateSpace: 'screenshotPixel' },
        mediaStatus: 'downloaded',
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'video-preview',
        reasonCode: 'clipboard_file_url_unavailable',
        attemptReasonCodes: ['clipboard_file_url_unavailable'],
        attachment: expect.objectContaining({
          type: 'video',
          name: 'clip.mp4',
          availability: 'metadata-only',
          providerError: 'clipboard_file_url_unavailable',
        }),
      }),
    ])
    expect(result[0].attachment.localPath).toBeUndefined()
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('does not materialize a stale clipboard file or preview as the current video attachment', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const staleTextPath = path.join(sourceDir, 'previous-file.txt')
    fs.writeFileSync(staleTextPath, 'stale bytes')
    const sourcePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCArLmtaUAAAAASUVORK5CYII='
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1, filePaths: [staleTextPath] })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ['clipboard.readAttachment', ok('stale-1', { filePaths: [staleTextPath], mimeType: 'text/plain', changeCount: 2 })],
      ['clipboard.readAttachment', ok('stale-2', { filePaths: [staleTextPath], mimeType: 'text/plain', changeCount: 2 })],
      ['clipboard.readAttachment', ok('stale-3', { filePaths: [staleTextPath], mimeType: 'text/plain', changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      screenshot: { mimeType: 'image/png', dataBase64: sourcePngBase64, width: 2, height: 2 },
      candidates: [{
        messageKey: 'video-stale-clipboard',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        screenshotBbox: { x: 0, y: 0, width: 2, height: 2, coordinateSpace: 'screenshotPixel' },
        mediaStatus: 'downloaded',
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'video-stale-clipboard',
        reasonCode: 'clipboard_file_url_unavailable',
        attemptReasonCodes: ['clipboard_file_url_unavailable'],
        attachment: expect.objectContaining({
          type: 'video',
          name: 'clip.mp4',
          availability: 'metadata-only',
          providerError: 'clipboard_file_url_unavailable',
        }),
      }),
    ])
    expect(result[0].attachment.localPath).toBeUndefined()
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('materializes image bytes from the system clipboard when WeChat copies pixels instead of a file URL', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCArLmtaUAAAAASUVORK5CYII='
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制图片'),
      ['clipboard.readAttachment', ok('image-data', {
        dataBase64: sourcePngBase64,
        mimeType: 'image/png',
        suggestedFileName: 'wechat-copy.png',
        changeCount: 2,
      })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'image-data',
        kind: 'image',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'image-data',
        reasonCode: 'edge_local',
        attachment: expect.objectContaining({
          type: 'image',
          mimeType: 'image/png',
          name: 'wechat-copy.png',
          extension: '.png',
          availability: 'edge-local',
          localPath: expect.stringContaining(targetDir),
          sourceAction: 'materialize-clipboard',
        }),
      }),
    ])
    expect(fs.existsSync(result[0].attachment.localPath || '')).toBe(true)
    expect(fs.readdirSync(targetDir)).toHaveLength(1)
  })

  it('uses the real clipboard video MIME when structure metadata still looks like a preview image', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'clip.mp4')
    fs.writeFileSync(sourcePath, 'mp4 bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'video-real-mp4',
        kind: 'video',
        fileName: 'video-preview.png',
        mimeType: 'image/png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-real-mp4',
      reasonCode: 'edge_local',
      attachment: {
        type: 'video',
        name: 'clip.mp4',
        mimeType: 'video/mp4',
        extension: '.mp4',
        availability: 'edge-local',
        sourceAction: 'materialize-clipboard',
        materializationKind: 'original-file',
        isOriginal: true,
        mimeKindMatches: true,
      },
    })
    expect(fs.existsSync(result[0].attachment.localPath || '')).toBe(true)
  })

  it('locks the current Windows receive path to generic copy plus clipboard FileDropList originals', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const pngPath = path.join(sourceDir, 'wechat-action-smoke-20260616043335.png')
    const mp4Path = path.join(sourceDir, 'wechat-action-smoke-20260616043346.mp4')
    fs.writeFileSync(pngPath, 'png original bytes')
    fs.writeFileSync(mp4Path, 'mp4 original bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot-file', { changeCount: 10 })],
      ['mouse.rightClick', ok('right-click-file', { clicked: true })],
      ...ocrMenu('复制', {
        capture: 'screen',
        captureBounds: { x: 540, y: 140, width: 520, height: 760, coordinateSpace: 'screen' },
        bbox: { x: 230, y: 420, width: 90, height: 24, coordinateSpace: 'screenshotPixel' },
      }),
      ['clipboard.readAttachment', ok('file-path', {
        filePaths: [pngPath],
        fileUrls: [new URL(`file://${pngPath}`).href],
        types: ['FileDrop'],
        changeCount: 11,
      })],
      ['clipboard.restore', ok('restore-file', { restored: true })],
      ['clipboard.snapshot', ok('snapshot-video', { changeCount: 12 })],
      ['mouse.rightClick', ok('right-click-video', { clicked: true })],
      ...ocrMenu('复制', {
        capture: 'screen',
        captureBounds: { x: 550, y: 250, width: 480, height: 760, coordinateSpace: 'screen' },
        bbox: { x: 230, y: 430, width: 90, height: 24, coordinateSpace: 'screenshotPixel' },
      }),
      ['clipboard.readAttachment', ok('video-path', {
        filePaths: [mp4Path],
        fileUrls: [new URL(`file://${mp4Path}`).href],
        types: ['FileDrop'],
        changeCount: 13,
      })],
      ['clipboard.restore', ok('restore-video', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win-current',
      window: { windowId: 'win-current', bounds: { x: 100, y: 50, width: 1344, height: 971, coordinateSpace: 'screen' } },
      platform: 'win32',
      candidates: [
        {
          messageKey: 'current-file-png',
          kind: 'file',
          fileName: 'wechat-action-smoke-20260616043335.png',
          mimeType: 'image/png',
          bbox: { x: 680, y: 520, width: 260, height: 92, coordinateSpace: 'screen' },
        },
        {
          messageKey: 'current-video-mp4',
          kind: 'video-file',
          fileName: 'video-preview.png',
          mimeType: 'image/png',
          bbox: { x: 690, y: 630, width: 220, height: 128, coordinateSpace: 'screen' },
        },
      ],
    })

    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      messageKey: 'current-file-png',
      reasonCode: 'edge_local',
      attachment: {
        type: 'file',
        name: 'wechat-action-smoke-20260616043335.png',
        mimeType: 'image/png',
        extension: '.png',
        size: 'png original bytes'.length,
        availability: 'edge-local',
        sourceAction: 'materialize-clipboard',
        materializationKind: 'original-file',
        isOriginal: true,
        mimeKindMatches: true,
      },
      resolveTrace: {
        attempts: expect.arrayContaining([
          expect.objectContaining({
            phase: 'copy-before-download',
            ok: true,
            pickedLabel: '复制',
            clipboardPayload: expect.objectContaining({
              filePathCount: 1,
              fileUrlCount: 1,
              extensions: ['.png'],
            }),
          }),
        ]),
      },
    })
    expect(result[1]).toMatchObject({
      messageKey: 'current-video-mp4',
      reasonCode: 'edge_local',
      attachment: {
        type: 'video',
        name: 'wechat-action-smoke-20260616043346.mp4',
        mimeType: 'video/mp4',
        extension: '.mp4',
        size: 'mp4 original bytes'.length,
        availability: 'edge-local',
        sourceAction: 'materialize-clipboard',
        materializationKind: 'original-file',
        isOriginal: true,
        mimeKindMatches: true,
      },
      resolveTrace: {
        attempts: expect.arrayContaining([
          expect.objectContaining({
            phase: 'copy-before-download',
            ok: true,
            pickedLabel: '复制',
            clipboardPayload: expect.objectContaining({
              filePathCount: 1,
              fileUrlCount: 1,
              extensions: ['.mp4'],
            }),
          }),
        ]),
      },
    })
    const attempts = result.flatMap((item) => item.resolveTrace?.attempts ?? [])
    expect(attempts.some((attempt) => attempt.phase === 'cache-scan')).toBe(false)
    expect(attempts.some((attempt) => attempt.phase === 'download-action')).toBe(false)
    const menuClickCalls = vi.mocked(helper.request).mock.calls.filter(([command]) => command === 'mouse.click')
    expect(menuClickCalls).toHaveLength(2)
    expect(menuClickCalls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ coordinateSpace: 'screen', windowId: 'win-current' }),
      expect.objectContaining({ coordinateSpace: 'screen', windowId: 'win-current' }),
    ])
    expect(fs.existsSync(result[0].attachment.localPath || '')).toBe(true)
    expect(fs.existsSync(result[1].attachment.localPath || '')).toBe(true)
  })

  it('waits for delayed image file URLs after the WeChat thumbnail copy menu returns', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'delayed-photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('拷贝'),
      ['clipboard.readAttachment', ok('text-only-1', { fileUrls: [], types: ['public.utf8-plain-text'], changeCount: 2 })],
      ['clipboard.readAttachment', ok('text-only-2', { fileUrls: [], types: ['public.utf8-plain-text'], changeCount: 2 })],
      ['clipboard.readAttachment', ok('file-url', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'delayed-image-url',
        kind: 'image',
        fileName: 'delayed-photo.png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'delayed-image-url',
      reasonCode: 'edge_local',
      attachment: { type: 'image', availability: 'edge-local', name: 'delayed-photo.png' },
    })
    expect(fs.existsSync(result[0].attachment.localPath || '')).toBe(true)
  })

  it('does not open the image viewer or save panel when clipboard copy exposes no usable image payload', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-copy', { clicked: true })],
      ...ocrMenu('复制图片'),
      ...emptyClipboardReads(12),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'image-save-as',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image-save-as',
      reasonCode: 'clipboard_attachment_unavailable',
      attachment: { type: 'image', availability: 'metadata-only', name: 'photo.png' },
    })
    expect(helper.request).not.toHaveBeenCalledWith('savePanel.saveToPath', expect.anything(), undefined)
    expect(helper.request).not.toHaveBeenCalledWith('windows.list', expect.anything(), undefined)
  })

  it('does not scan Downloads, WeChat caches, or databases when file copy exposes no local reference', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot-copy', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-copy', { clicked: true })],
      ...ocrMenu('复制文件'),
      ...emptyClipboardReads(3),
      ['clipboard.restore', ok('restore-copy', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'file-no-scan',
        kind: 'file',
        fileName: 'brief.pdf',
        mimeType: 'application/pdf',
        bbox: { x: 10, y: 20, width: 180, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'file-no-scan',
      reasonCode: 'clipboard_file_url_unavailable',
      attachment: {
        type: 'file',
        availability: 'metadata-only',
        name: 'brief.pdf',
        providerError: 'clipboard_file_url_unavailable',
      },
    })
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
    expect(helper.request).not.toHaveBeenCalledWith('savePanel.saveToPath', expect.anything(), undefined)
    expect(helper.request).not.toHaveBeenCalledWith('windows.list', expect.anything(), undefined)
    expect(helper.request).not.toHaveBeenCalledWith('clipboard.readFileUrls', expect.anything(), undefined)
  })

  it('does not use a screenshot preview or image viewer fallback when thumbnail copy cannot expose the original', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYGJAQoAHxcCArLmtaUAAAAASUVORK5CYII='
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot-copy', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-copy', { clicked: true })],
      ...ocrMenu('拷贝'),
      ...emptyClipboardReads(12),
      ['clipboard.restore', ok('restore-copy', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      screenshot: { mimeType: 'image/png', dataBase64: sourcePngBase64, width: 2, height: 2 },
      candidates: [{
        messageKey: 'image-viewer-save',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
        screenshotBbox: { x: 0, y: 0, width: 2, height: 2, coordinateSpace: 'screenshotPixel' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image-viewer-save',
      reasonCode: 'clipboard_attachment_unavailable',
      attachment: { type: 'image', availability: 'metadata-only', name: 'photo.png', providerError: 'clipboard_attachment_unavailable' },
    })
    expect(helper.request).not.toHaveBeenCalledWith('keyboard.shortcut', { key: 's', modifiers: ['command'] }, undefined)
    expect(helper.request).not.toHaveBeenCalledWith('savePanel.saveToPath', expect.anything(), undefined)
    expect(result[0].attachment.localPath).toBeUndefined()
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('uses OCR context-menu clicks to copy visible media', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 5 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ['screen.capture', { id: 'screen-capture', ok: false, errorCode: 'helper_unknown_command', errorSummary: 'Unknown command: screen.capture', latencyMs: 1 }],
      ['windows.capture', ok('menu-capture', { mimeType: 'image/png', dataBase64: 'menu-png', width: 1000, height: 800 })],
      ['ocr.recognize', ok('menu-ocr', {
        blocks: [{ text: '复制图片', bbox: { x: 190, y: 245, width: 80, height: 24, coordinateSpace: 'screenshotPixel' } }],
      })],
      ['mouse.click', ok('menu-click', { clicked: true })],
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 6 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 100, y: 50, width: 500, height: 400, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'image1',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 180, y: 220, width: 120, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image1',
      reasonCode: 'edge_local',
      attachment: { type: 'image', availability: 'edge-local', name: 'photo.png' },
    })
    expect(helper.request).toHaveBeenNthCalledWith(6, 'mouse.click', {
      x: 215,
      y: 179,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
    expect(helper.request).not.toHaveBeenCalledWith('menu.pickItem', expect.anything(), undefined)
  })

  it('captures the screen region around Windows context menus before OCR fallback', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 5 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ['screen.capture', ok('screen-menu-capture', {
        mimeType: 'image/png',
        dataBase64: 'menu-png',
        width: 440,
        height: 760,
        bounds: { x: 440, y: 120, width: 440, height: 760, coordinateSpace: 'screen' },
      })],
      ['ocr.recognize', ok('menu-ocr', {
        blocks: [{ text: '复制图片', bbox: { x: 44, y: 76, width: 80, height: 24, coordinateSpace: 'screenshotPixel' } }],
      })],
      ['mouse.click', ok('menu-click', { clicked: true })],
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 6 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 100, y: 50, width: 1000, height: 800, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'image-windows-menu',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 580, y: 500, width: 180, height: 90, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image-windows-menu',
      reasonCode: 'edge_local',
      attachment: { type: 'image', availability: 'edge-local', name: 'photo.png' },
    })
    expect(helper.request).toHaveBeenNthCalledWith(3, 'screen.capture', {
      bounds: {
        x: 440,
        y: 120,
        width: 440,
        height: 760,
        coordinateSpace: 'screen',
      },
    }, undefined)
    expect(helper.request).toHaveBeenNthCalledWith(5, 'mouse.click', {
      x: 524,
      y: 208,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
  })

  it('prefers OCR menu clicks for image bubbles when a live window context is available', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 10 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制图片', { capture: 'screen' }),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 11 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 100, y: 50, width: 500, height: 400, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'image-ocr-first',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 180, y: 220, width: 120, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'image-ocr-first',
      reasonCode: 'edge_local',
      attachment: { type: 'image', availability: 'edge-local', name: 'photo.png' },
    })
    expect(helper.request).toHaveBeenNthCalledWith(3, 'screen.capture', expect.objectContaining({
      bounds: expect.any(Object),
    }), undefined)
    expect(helper.request).not.toHaveBeenCalledWith('menu.pickItem', expect.anything(), undefined)
  })

  it('prefers OCR menu clicks for file cards when a live window context is available', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'brief.txt')
    fs.writeFileSync(sourcePath, 'brief bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 10 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制文件', { capture: 'screen' }),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 11 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 100, y: 50, width: 500, height: 400, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'file-ocr-first',
        kind: 'file',
        fileName: 'brief.txt',
        bbox: { x: 180, y: 220, width: 120, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'file-ocr-first',
      reasonCode: 'edge_local',
      attachment: { type: 'file', availability: 'edge-local', name: 'brief.txt' },
    })
    expect(helper.request).toHaveBeenNthCalledWith(3, 'screen.capture', expect.objectContaining({
      bounds: expect.any(Object),
    }), undefined)
    expect(helper.request).not.toHaveBeenCalledWith('menu.pickItem', expect.anything(), undefined)
  })

  it('clicks the copy OCR row instead of dangerous context-menu rows closer to the file bubble', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'brief.txt')
    fs.writeFileSync(sourcePath, 'brief bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 10 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ['screen.capture', { id: 'screen-capture', ok: false, errorCode: 'helper_unknown_command', errorSummary: 'Unknown command: screen.capture', latencyMs: 1 }],
      ['windows.capture', ok('menu-capture', { mimeType: 'image/png', dataBase64: 'menu-png', width: 2000, height: 1600 })],
      ['ocr.recognize', ok('menu-ocr', {
        blocks: [
          { text: '复制', bbox: { x: 740, y: 610, width: 80, height: 44, coordinateSpace: 'screenshotPixel' } },
          { text: '引用', bbox: { x: 1170, y: 1040, width: 80, height: 44, coordinateSpace: 'screenshotPixel' } },
          { text: '删除', bbox: { x: 1170, y: 1120, width: 80, height: 44, coordinateSpace: 'screenshotPixel' } },
        ],
      })],
      ['mouse.click', ok('menu-click', { clicked: true })],
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 11 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      window: { windowId: 'win1', bounds: { x: 100, y: 50, width: 1000, height: 800, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'file-copy-not-delete',
        kind: 'file',
        fileName: 'brief.txt',
        bbox: { x: 620, y: 520, width: 220, height: 120, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'file-copy-not-delete',
      reasonCode: 'edge_local',
      attachment: { type: 'file', availability: 'edge-local', name: 'brief.txt' },
    })
    expect(helper.request).toHaveBeenNthCalledWith(6, 'mouse.click', {
      x: 490,
      y: 366,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
  })

  it('refuses visible media actions when the pre-action stability check fails', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([])
    const stabilityCheck = vi.fn(async () => ({ ok: false as const, reasonCode: 'conversation_title_not_confirmed' }))

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      stabilityCheck,
      candidates: [{
        messageKey: 'image-title-mismatch',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'image-title-mismatch',
        reasonCode: 'conversation_title_not_confirmed',
        attachment: expect.objectContaining({
          type: 'image',
          availability: 'metadata-only',
          providerError: 'conversation_title_not_confirmed',
        }),
      }),
    ])
    expect(stabilityCheck).toHaveBeenCalledTimes(1)
    expect(stabilityCheck).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'before-media-action',
      candidate: expect.objectContaining({ messageKey: 'image-title-mismatch' }),
    }))
    expect(helper.request).not.toHaveBeenCalled()
  })

  it('downgrades a copied local attachment when the post-action stability check fails', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'photo.png')
    fs.writeFileSync(sourcePath, 'png bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制图片'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])
    const stabilityCheck = vi.fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValue({ ok: false as const, reasonCode: 'conversation_title_not_confirmed' })

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      stabilityCheck,
      candidates: [{
        messageKey: 'image-post-title-mismatch',
        kind: 'image',
        fileName: 'photo.png',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'image-post-title-mismatch',
        reasonCode: 'conversation_title_not_confirmed',
        attemptReasonCodes: ['edge_local', 'conversation_title_not_confirmed'],
        attachment: expect.objectContaining({
          type: 'image',
          availability: 'metadata-only',
          providerError: 'conversation_title_not_confirmed',
        }),
      }),
    ])
    expect(stabilityCheck).toHaveBeenNthCalledWith(1, expect.objectContaining({ stage: 'before-media-action' }))
    expect(stabilityCheck).toHaveBeenNthCalledWith(2, expect.objectContaining({ stage: 'after-media-action' }))
    expect(stabilityCheck).toHaveBeenNthCalledWith(3, expect.objectContaining({ stage: 'after-media-action' }))
  })

  it('keeps a copied attachment when the post-download title check passes on retry', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'clip.mp4')
    fs.writeFileSync(sourcePath, 'mp4 bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])
    const stabilityCheck = vi.fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: false as const, reasonCode: 'conversation_title_not_confirmed' })
      .mockResolvedValueOnce({ ok: true as const })

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      stabilityCheck,
      candidates: [{
        messageKey: 'video-post-title-retry',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 10, y: 20, width: 100, height: 80, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-post-title-retry',
      reasonCode: 'edge_local',
      attachment: {
        type: 'video',
        availability: 'edge-local',
        extension: '.mp4',
      },
    })
    expect(stabilityCheck).toHaveBeenNthCalledWith(2, expect.objectContaining({ stage: 'after-media-action' }))
    expect(stabilityCheck).toHaveBeenNthCalledWith(3, expect.objectContaining({ stage: 'after-media-action' }))
  })

  it('does not click a download affordance after the conversation becomes unstable', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([])
    const stabilityCheck = vi.fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce({ ok: false as const, reasonCode: 'conversation_title_not_confirmed' })

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      stabilityCheck,
      candidates: [{
        messageKey: 'video-download-title-mismatch',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        downloadActionBbox: { x: 148, y: 232, width: 32, height: 32, coordinateSpace: 'screen' },
        mediaStatus: 'not_downloaded',
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'video-download-title-mismatch',
        reasonCode: 'conversation_title_not_confirmed',
        attachment: expect.objectContaining({
          type: 'video',
          availability: 'pending-download',
          providerError: 'conversation_title_not_confirmed',
        }),
      }),
    ])
    // 第一次 before-media-action 稳定性检查在主循环开头，第二次在点下载前的 gate；
    // 第二次返回标题不符 → 不点下载。
    expect(stabilityCheck).toHaveBeenNthCalledWith(1, expect.objectContaining({ stage: 'before-media-action' }))
    expect(stabilityCheck).toHaveBeenNthCalledWith(2, expect.objectContaining({ stage: 'before-media-action' }))
    expect(stabilityCheck).toHaveBeenCalledTimes(2)
    expect(helper.request).not.toHaveBeenCalledWith('mouse.click', {
      x: 164,
      y: 248,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
  })

  it('clicks an unloaded video download affordance once and returns pending for the next observe', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([
      ['mouse.click', ok('download-click', { clicked: true })],
    ])
    const stabilityCheck = vi.fn().mockResolvedValue({ ok: true as const })

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      stabilityCheck,
      candidates: [{
        messageKey: 'video-download',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        downloadActionBbox: { x: 148, y: 232, width: 32, height: 32, coordinateSpace: 'screen' },
        mediaStatus: 'not_downloaded',
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-download',
      reasonCode: 'download_triggered_pending_next_observe',
      attachment: {
        type: 'video',
        availability: 'pending-download',
        name: 'clip.mp4',
        providerError: 'download_triggered_pending_next_observe',
      },
    })
    // 行为断言：这一轮只点了一次下载，不在同 tick 内右键复制。
    // 不断言点击的具体像素——那是内部坐标计算细节，真实视频尺寸/位置各不相同，交给真机验证。
    expect(helper.request).toHaveBeenCalledTimes(1)
    const clickCalls = vi.mocked(helper.request).mock.calls.filter(([command]) => command === 'mouse.click')
    expect(clickCalls).toHaveLength(1)
    expect(helper.request).not.toHaveBeenCalledWith('mouse.rightClick', expect.anything(), expect.anything())
  })

  it('waits without clicking while an unloaded video is still downloading (loading)', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'video-loading',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        downloadActionBbox: { x: 148, y: 232, width: 32, height: 32, coordinateSpace: 'screen' },
        mediaStatus: 'loading',
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-loading',
      reasonCode: 'download_in_progress_waiting',
      attachment: { type: 'video', availability: 'pending-download' },
    })
    // 转圈下载中：这一轮纯等待，不发任何界面动作。
    expect(helper.request).not.toHaveBeenCalled()
  })

  it('right-clicks video media from a safe corner before trying the center point', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'clip.mp4')
    fs.writeFileSync(sourcePath, 'mp4 bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot-video', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click-video-safe-corner', { clicked: true })],
      ...ocrMenu('复制视频', {
        capture: 'screen',
        captureBounds: { x: 550, y: 250, width: 480, height: 760, coordinateSpace: 'screen' },
        bbox: { x: 140, y: 392, width: 90, height: 24, coordinateSpace: 'screenshotPixel' },
      }),
      ['clipboard.readAttachment', ok('video-path', { filePaths: [sourcePath], changeCount: 2 })],
      ['clipboard.restore', ok('restore-video', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win-video',
      window: { windowId: 'win-video', bounds: { x: 100, y: 50, width: 1344, height: 971, coordinateSpace: 'screen' } },
      candidates: [{
        messageKey: 'video-safe-right-click',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 690, y: 630, width: 220, height: 128, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-safe-right-click',
      reasonCode: 'edge_local',
      attachment: { type: 'video', availability: 'edge-local', extension: '.mp4' },
    })
    expect(helper.request).toHaveBeenNthCalledWith(2, 'mouse.rightClick', {
      x: 729.6,
      y: 653.04,
      coordinateSpace: 'screen',
      windowId: 'win-video',
    }, undefined)
    expect(result[0]?.resolveTrace?.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        phase: 'copy-before-download',
        pointAttempt: 1,
        pointRole: 'media-top-left',
        ok: true,
      }),
    ]))
  })

  it('right-click copies unloaded files without clicking the visible download affordance', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'brief.txt')
    fs.writeFileSync(sourcePath, 'txt bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 20 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制文件'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 21 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'file-download-first',
        kind: 'file',
        fileName: 'brief.txt',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        downloadActionBbox: { x: 148, y: 232, width: 32, height: 32, coordinateSpace: 'screen' },
        mediaStatus: 'not_downloaded',
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'file-download-first',
      reasonCode: 'edge_local',
      attachment: {
        type: 'file',
        availability: 'edge-local',
        name: 'brief.txt',
        extension: '.txt',
        sourceAction: 'materialize-clipboard',
      },
    })
    expect(helper.request).not.toHaveBeenCalledWith('mouse.click', {
      x: 164,
      y: 248,
      coordinateSpace: 'screen',
      windowId: 'win1',
    }, undefined)
    expect(helper.request).toHaveBeenNthCalledWith(1, 'clipboard.snapshot', {}, undefined)
  })

  it('copies an already-downloaded video via the right-click menu without clicking download', async () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-source-'))
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const sourcePath = path.join(sourceDir, 'clip.mp4')
    fs.writeFileSync(sourcePath, 'mp4 bytes')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 10 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ['clipboard.readAttachment', ok('files', { filePaths: [sourcePath], changeCount: 11 })],
      ['clipboard.restore', ok('restore', { restored: true })],
    ])
    const stabilityCheck = vi.fn().mockResolvedValue({ ok: true as const })

    // 下一轮 observe：微信已经下完，mediaStatus 变成 available、不再是 not_downloaded，
    // gate 关闭，直接走右键复制把原件拷出来。这条覆盖“收割”那一轮。
    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      stabilityCheck,
      candidates: [{
        messageKey: 'video-already-downloaded',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        mediaStatus: 'available',
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-already-downloaded',
      reasonCode: 'edge_local',
      attachment: {
        type: 'video',
        availability: 'edge-local',
        name: 'clip.mp4',
        extension: '.mp4',
        sourceAction: 'materialize-clipboard',
      },
    })
    // 已下载视频不再点下载按钮。
    expect(helper.request).not.toHaveBeenCalledWith('mouse.click', expect.anything(), expect.anything())
  })

  it('keeps the video pending when the download click fails', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const helper = scriptedHelper([
      ['mouse.click', { id: 'download-click', ok: false, errorCode: 'download_action_click_failed', errorSummary: 'cannot click download', latencyMs: 1 }],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      candidates: [{
        messageKey: 'video-download-click-failed',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        downloadActionBbox: { x: 148, y: 232, width: 32, height: 32, coordinateSpace: 'screen' },
        mediaStatus: 'not_downloaded',
      }],
    })

    expect(result).toEqual([
      expect.objectContaining({
        messageKey: 'video-download-click-failed',
        reasonCode: 'download_action_click_failed',
        attachment: expect.objectContaining({
          type: 'video',
          availability: 'pending-download',
          providerError: 'download_action_click_failed',
        }),
      }),
    ])
    const clickCalls = vi.mocked(helper.request).mock.calls.filter(([command]) => command === 'mouse.click')
    expect(clickCalls).toHaveLength(1)
  })

  it('does not scan WeChat cache fallback outside explicit Windows media resolution', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cache-root-'))
    fs.writeFileSync(path.join(cacheRoot, 'clip.mp4'), 'video-data')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ...emptyClipboardReads(3),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      platform: 'darwin',
      wechatCacheRoots: [cacheRoot],
      candidates: [{
        messageKey: 'video-no-cache',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-no-cache',
      reasonCode: 'clipboard_file_url_unavailable',
      attachment: { availability: 'metadata-only', providerError: 'clipboard_file_url_unavailable' },
    })
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('can resolve a Windows video original from an explicit WeChat cache root after clipboard copy misses', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cache-root-'))
    const sourcePath = path.join(cacheRoot, 'clip.mp4')
    fs.writeFileSync(sourcePath, 'video-data')
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ...emptyClipboardReads(3),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      platform: 'win32',
      wechatCacheRoots: [cacheRoot],
      candidates: [{
        messageKey: 'video-cache',
        kind: 'video',
        fileName: 'clip.mp4',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-cache',
      reasonCode: 'edge_local_from_wechat_cache',
      attachment: {
        type: 'video',
        availability: 'edge-local',
        name: 'clip.mp4',
        sourceAction: 'wechat-cache-scan',
        materializationKind: 'original-file',
        isOriginal: true,
      },
      resolveTrace: {
        attempts: expect.arrayContaining([
          expect.objectContaining({
            phase: 'cache-scan',
            ok: true,
            reasonCode: 'wechat_cache_token_match',
          }),
        ]),
      },
    })
    expect(result[0]?.attachment.localPath).toMatch(new RegExp(`${escapeRegExp(targetDir)}.*clip-`))
  })

  it('can resolve a Windows video original from a marker timestamp anchored cache match', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cache-root-'))
    // 缓存匹配有一个相对“现在”的新鲜度窗口（默认两周），所以时间锚必须相对当前时间生成，
    // 否则硬编码的过去日期会随真实时间流逝滑出窗口、让测试某天突然变红。
    const anchored = new Date(Date.now() - 60_000)
    const marker = formatCacheMarkerTimestamp(anchored)
    const sourcePath = path.join(cacheRoot, `video_${marker}_raw.mp4`)
    fs.writeFileSync(sourcePath, 'video-data')
    fs.utimesSync(sourcePath, new Date(anchored.getTime() + 4_000), new Date(anchored.getTime() + 4_000))
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ...emptyClipboardReads(3),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      platform: 'win32',
      wechatCacheRoots: [cacheRoot],
      candidates: [{
        messageKey: 'video-cache-marker',
        kind: 'video',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        contextText: `codex-product-action video ${marker}`,
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-cache-marker',
      reasonCode: 'edge_local_from_wechat_cache',
      attachment: {
        type: 'video',
        availability: 'edge-local',
        name: `video_${marker}_raw.mp4`,
        sourceAction: 'wechat-cache-scan',
      },
      resolveTrace: {
        attempts: expect.arrayContaining([
          expect.objectContaining({
            phase: 'cache-scan',
            ok: true,
            reasonCode: 'wechat_cache_recent_unique_match',
            cacheScan: expect.objectContaining({
              strategy: 'recent-unique',
              hasTimeAnchor: true,
            }),
          }),
        ]),
      },
    })
  })

  it('does not resolve a Windows video from cache without a filename token or marker timestamp anchor', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-target-'))
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cache-root-'))
    const sourcePath = path.join(cacheRoot, 'history.mp4')
    fs.writeFileSync(sourcePath, 'old-video-data')
    fs.utimesSync(sourcePath, new Date('2026-06-16T04:33:50.000Z'), new Date('2026-06-16T04:33:50.000Z'))
    const helper = scriptedHelper([
      ['clipboard.snapshot', ok('snapshot', { changeCount: 1 })],
      ['mouse.rightClick', ok('right-click', { clicked: true })],
      ...ocrMenu('复制视频'),
      ...emptyClipboardReads(3),
      ['clipboard.restore', ok('restore', { restored: true })],
    ])

    const result = await resolveVisibleWeChatChannelMedia({
      helper,
      attachmentsDir: targetDir,
      windowId: 'win1',
      platform: 'win32',
      wechatCacheRoots: [cacheRoot],
      candidates: [{
        messageKey: 'video-cache-no-anchor',
        kind: 'video',
        bbox: { x: 100, y: 200, width: 160, height: 90, coordinateSpace: 'screen' },
        observedAt: '2026-06-16T04:33:46.000Z',
      }],
    })

    expect(result[0]).toMatchObject({
      messageKey: 'video-cache-no-anchor',
      reasonCode: 'clipboard_file_url_unavailable',
      attemptReasonCodes: expect.arrayContaining(['clipboard_file_url_unavailable', 'wechat_cache_lookup_token_missing']),
      attachment: {
        type: 'video',
        availability: 'metadata-only',
        providerError: 'clipboard_file_url_unavailable',
      },
      resolveTrace: {
        attempts: expect.arrayContaining([
          expect.objectContaining({
            phase: 'cache-scan',
            ok: false,
            reasonCode: 'wechat_cache_lookup_token_missing',
          }),
        ]),
      },
    })
    expect(fs.readdirSync(targetDir)).toHaveLength(0)
  })

  it('does not use parent directory names as cache lookup tokens for Windows-style paths', () => {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-cache-root-'))
    fs.writeFileSync(path.join(cacheRoot, 'users.mp4'), 'unrelated-video')

    const result = findCachedWeChatInboundMedia({
      kind: 'video',
      fileName: 'C:\\Users\\simpl\\Videos\\target.mp4',
    }, {
      roots: [cacheRoot],
    })

    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'wechat_cache_file_not_found',
      trace: expect.objectContaining({
        tokens: ['target'],
      }),
    })
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 生成 YYYYMMDDHHMMSS 形式的缓存标记时间戳（UTC，与 resolver 里 timestampFromContextText 的
// Date.UTC 解析一致）。测试用它从“现在”派生锚点，避免硬编码过去日期随时间滑出新鲜度窗口。
function formatCacheMarkerTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

function scriptedHelper(script: Array<[WeChatChannelHelperCommandName, WeChatChannelHelperResponse]>): WeChatChannelHelperTransport {
  const request = vi.fn(async (command: WeChatChannelHelperCommandName) => {
    const next = script.shift()
    if (!next) throw new Error(`unexpected command ${command}`)
    expect(command).toBe(next[0])
    return next[1]
  })
  return { request: request as WeChatChannelHelperTransport['request'] }
}

function ocrMenu(
  label: string,
  options: {
    capture?: 'window' | 'screen'
    bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
    captureBounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  } = {},
): Array<[WeChatChannelHelperCommandName, WeChatChannelHelperResponse]> {
  const bbox = options.bbox ?? { x: 100, y: 100, width: 90, height: 24, coordinateSpace: 'screenshotPixel' }
  const capture: [WeChatChannelHelperCommandName, WeChatChannelHelperResponse] = options.capture === 'screen'
    ? ['screen.capture', ok('menu-capture', {
        mimeType: 'image/png',
        dataBase64: 'menu-png',
        width: options.captureBounds?.width ?? 500,
        height: options.captureBounds?.height ?? 500,
        bounds: options.captureBounds ?? { x: 0, y: 0, width: 500, height: 500, coordinateSpace: 'screen' },
      })]
    : ['windows.capture', ok('menu-capture', { mimeType: 'image/png', dataBase64: 'menu-png', width: 1000, height: 800 })]
  return [
    capture,
    ['ocr.recognize', ok('menu-ocr', { blocks: [{ text: label, bbox }] })],
    ['mouse.click', ok('menu-click', { clicked: true })],
  ]
}

function ocrMenuMiss(): Array<[WeChatChannelHelperCommandName, WeChatChannelHelperResponse]> {
  return [
    ['windows.capture', ok('menu-capture', { mimeType: 'image/png', dataBase64: 'menu-png', width: 1000, height: 800 })],
    ['ocr.recognize', ok('menu-ocr', { blocks: [{ text: '引用', bbox: { x: 100, y: 100, width: 80, height: 24, coordinateSpace: 'screenshotPixel' } }] })],
  ]
}

function emptyClipboardReads(count: number): Array<[WeChatChannelHelperCommandName, WeChatChannelHelperResponse]> {
  return Array.from({ length: count }, (_, index) => [
    'clipboard.readAttachment',
    ok(`empty-${index + 1}`, { fileUrls: [], filePaths: [], changeCount: 2 }),
  ])
}
