// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-format.test.ts

export type WeChatWindowInfo = {
  windowId: string
  appName?: string | null
  title?: string | null
  className?: string | null
  visible?: boolean | null
  minimized?: boolean | null
  bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  zOrder?: number | null
  rootProcessId?: number | null
}

export type WeChatScreenPoint = {
  x: number
  y: number
  coordinateSpace: 'screen'
}

export type WeChatScreenshot = {
  mimeType: string
  dataBase64?: string
  width: number
  height: number
  windowId?: string | null
  bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
}

export type WeChatScreenshotWithData = WeChatScreenshot & { dataBase64: string }

export type WeChatOcrBlock = {
  text?: string
  bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  confidence?: number
}

export type WeChatOcrResult = {
  blocks?: WeChatOcrBlock[]
  visibleConversationFingerprints?: unknown[]
}

export type WeChatObservedMessage = {
  stableMessageKey: string
  senderRole: 'self' | 'contact' | 'system' | 'unknown'
  senderName?: string | null
  kind: string
  normalizedText?: string | null
  anchorText?: string | null
  anchorMetadata?: unknown
  neighborContext?: unknown
  textExcerpt?: string | null
  bbox?: unknown
  mediaMetadata?: unknown
  isBaseline?: boolean
  deliveryStatus?: string
  observedAt?: string
  visualBlocks?: Array<{
    stableMessageKey?: string
    blockId: string
    blockKind: string
    bbox?: unknown
    model?: string
    modelVersion?: string | null
    dims?: number
    vectorBase64?: string
    vectorStoreKey?: string
    signature?: string
  }>
}

export type WeChatReadResult = {
  ok: true
  app: 'wechat'
  chat: string
  messages: WeChatObservedMessage[]
  markdown: string
  traceId: string
  window?: WeChatWindowInfo
  quality?: {
    ok: boolean
    warnings: Array<{
      code: string
      message: string
      messageIndex?: number
      stableMessageKey?: string
      details?: Record<string, unknown>
    }>
    metrics: Record<string, number>
  }
}

export type WeChatWriteResult = {
  ok: true
  app: 'wechat'
  chat: string
  text: string
  attachment?: {
    kind: 'image' | 'video' | 'file'
    name: string
    mimeType: string
    size: number
    localPath: string
  }
  attachments: Array<{
    kind: 'image' | 'video' | 'file'
    name: string
    mimeType: string
    size: number
    localPath: string
  }>
  sent: boolean
  status: 'sent-unconfirmed' | 'dry-run'
  traceId: string
  warnings?: string[]
}

export type WeChatDoctorCheck = {
  id: string
  ok: boolean
  reasonCode?: string
  message: string
  details?: unknown
}

export type WeChatDoctorResult = {
  ok: boolean
  platform: NodeJS.Platform | string
  checks: WeChatDoctorCheck[]
  helper?: {
    path?: string
    dir?: string
    version?: string
    protocolVersion?: number
  }
}
