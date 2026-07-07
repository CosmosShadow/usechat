// @covers ../wechat/vector-store.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultWeChatChannelVectorStorePath,
  loadWeChatChannelVectorStore,
  saveWeChatChannelVectorStore,
  upsertWeChatChannelVectorReferences,
} from '../wechat/vector-store.js'

describe('WeChat channel local vector store', () => {
  it('persists visual vectors locally and returns ledger-safe references', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-vector-store-'))
    const filePath = defaultWeChatChannelVectorStorePath(dir, 'runtime1')
    const store = loadWeChatChannelVectorStore(filePath, 'runtime1')

    const references = upsertWeChatChannelVectorReferences({
      store,
      bindingId: 'binding1',
      blocks: [{
        stableMessageKey: 'm1',
        blockId: 'image-a',
        blockKind: 'image',
        model: 'server-visual-embedding',
        dims: 4,
        vectorBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
        bbox: { x: 10, y: 20, width: 30, height: 40 },
      }],
      now: new Date('2026-06-15T00:00:00.000Z'),
    })

    expect(references).toEqual([
      expect.objectContaining({
        stableMessageKey: 'm1',
        blockId: 'image-a',
        blockKind: 'image',
        vectorStoreKey: expect.stringMatching(/^wcv1_/),
        dims: 4,
        signature: expect.stringMatching(/^sha256:/),
      }),
    ])
    expect(JSON.stringify(references)).not.toContain('AQIDBA==')

    saveWeChatChannelVectorStore(filePath, store)
    const loaded = loadWeChatChannelVectorStore(filePath, 'runtime1')
    const record = Object.values(loaded.bindings.binding1.vectors)[0]
    expect(record).toMatchObject({
      stableMessageKey: 'm1',
      blockId: 'image-a',
      vectorBase64: 'AQIDBA==',
      observedAt: '2026-06-15T00:00:00.000Z',
    })
  })
})
