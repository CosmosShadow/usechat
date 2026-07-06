// @arch ../../docs/ARCHITECTURE.md
// @test src/__tests__/sdk.test.ts

import {
  createWeChatRuntime,
  runWeChatDoctor,
  type WeChatRuntime,
  type RunWeChatDoctorInput,
} from '@shennian/usechat-core'
import type { VisionModelProvider } from '@shennian/usechat-model-provider'

export type UseChatClientOptions = {
  helperPath?: string
  provider?: VisionModelProvider
}

export type UseChatClient = {
  doctor(input?: RunWeChatDoctorInput): ReturnType<typeof runWeChatDoctor>
  read(input: { app: 'wechat'; chat: string; limit?: number; format?: 'markdown' | 'json' }): ReturnType<WeChatRuntime['read']>
  write(input: { app: 'wechat'; chat: string; text: string; yes?: boolean; dryRun?: boolean }): ReturnType<WeChatRuntime['write']>
  close(): Promise<void>
}

export function createUseChat(options: UseChatClientOptions = {}): UseChatClient {
  let runtime: WeChatRuntime | null = null
  const getRuntime = () => {
    runtime ??= createWeChatRuntime({ helperPath: options.helperPath, provider: options.provider })
    return runtime
  }
  return {
    doctor(input) {
      return runWeChatDoctor({ ...input, helperPath: input?.helperPath ?? options.helperPath })
    },
    read(input) {
      assertWechat(input.app)
      return getRuntime().read(input)
    },
    write(input) {
      assertWechat(input.app)
      return getRuntime().write(input)
    },
    close() {
      return runtime?.stop() ?? Promise.resolve()
    },
  }
}

function assertWechat(app: string): void {
  if (app !== 'wechat') throw new Error(`unsupported_app: ${app}`)
}
