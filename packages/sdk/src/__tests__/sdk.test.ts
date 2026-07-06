// @covers ../index.ts

import { describe, expect, it } from 'vitest'
import { createUseChat } from '../index.js'

describe('sdk', () => {
  it('creates a client', async () => {
    const client = createUseChat({ helperPath: '/tmp/nonexistent' })
    expect(client).toHaveProperty('doctor')
    await client.close()
  })
})
