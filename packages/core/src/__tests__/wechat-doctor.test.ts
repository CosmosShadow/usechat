// @covers ../wechat/doctor.ts

import { describe, expect, it } from 'vitest'
import { enrichDoctorPermissionResultWithWindowProbe } from '../wechat/doctor.js'

describe('wechat doctor', () => {
  it('trusts windows.list when permissions.check omits or misses the WeChat window flag', async () => {
    const result = await enrichDoctorPermissionResultWithWindowProbe({
      platform: 'darwin',
      result: {
        wechatRunning: true,
        wechatWindowAvailable: false,
      },
      client: {
        async request() {
          return {
            ok: true,
            result: {
              windows: [
                {
                  appName: 'WeChat',
                  title: '微信',
                  visible: true,
                  minimized: false,
                  bounds: { x: 31, y: 70, width: 1010, height: 1208 },
                },
              ],
            },
          }
        },
      },
    })

    expect(result.wechatWindowAvailable).toBe(true)
  })
})
