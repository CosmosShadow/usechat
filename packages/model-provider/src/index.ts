// @arch ../../docs/ARCHITECTURE.md
// @test src/__tests__/model-provider.test.ts

export type UseChatMessageKind =
  | 'text'
  | 'image'
  | 'file'
  | 'video-file'
  | 'video-card'
  | 'link-card'
  | 'official-account-card'
  | 'mini-program-card'
  | 'system'
  | 'recall'
  | 'unknown'

export type UseChatStructuredMessage = {
  stableMessageKey?: string
  senderRole: 'self' | 'contact' | 'system' | 'unknown'
  senderName?: string | null
  kind: UseChatMessageKind
  normalizedText?: string | null
  anchorText?: string | null
  textExcerpt?: string | null
  bbox?: unknown
  mediaMetadata?: unknown
  observedAt?: string
}

export type UseChatClassifyWindowInput = {
  screenshot: UseChatScreenshot
  chatName?: string
  traceId?: string
}

export type UseChatClassifyWindowResult = {
  ok: true
  windowKind?: 'chat_main' | 'article' | 'settings' | 'login' | 'other'
  conversationTitle?: string | null
  isTargetConversation?: boolean
  confidence?: number
  layout?: {
    messageInputRect?: UseChatRect | null
    searchInputRect?: UseChatRect | null
  } | null
  warnings?: string[]
}

export type UseChatStructureVisibleWindowInput = {
  screenshots: UseChatScreenshot[]
  edgeOcrBlocks?: unknown[]
  visibleConversationFingerprints?: unknown[]
  chatName?: string
  traceId?: string
}

export type UseChatStructureVisibleWindowResult = {
  ok: true
  structuredMessages: UseChatStructuredMessage[]
  schemaVersion?: number
  usage?: unknown
  modelVersion?: string | null
}

export type UseChatScreenshot = {
  mimeType: string
  dataBase64: string
  width: number
  height: number
  windowId?: string | null
}

export type UseChatRect = {
  x: number
  y: number
  width: number
  height: number
  coordinateSpace?: string
}

export type VisionModelProvider = {
  structureVisibleWindow(input: UseChatStructureVisibleWindowInput): Promise<UseChatStructureVisibleWindowResult>
  classifyWindow?(input: UseChatClassifyWindowInput): Promise<UseChatClassifyWindowResult>
}

export type OpenAICompatibleProviderConfig = {
  baseUrl: string
  model: string
  apiKeyEnv: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}

export class ModelProviderError extends Error {
  constructor(
    public readonly reasonCode: 'model_not_configured' | 'model_request_failed' | 'model_invalid_json' | 'model_no_messages' | 'model_timeout',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ModelProviderError'
  }
}

const DEFAULT_TIMEOUT_MS = 60_000

export function createOpenAICompatibleVisionProvider(config: OpenAICompatibleProviderConfig): VisionModelProvider {
  const normalized = normalizeOpenAICompatibleConfig(config)
  return {
    async structureVisibleWindow(input) {
      const parsed = await callOpenAICompatibleJson({
        config: normalized,
        systemPrompt: STRUCTURE_WINDOW_SYSTEM_PROMPT,
        userText: buildStructureWindowUserPrompt(input),
        screenshot: input.screenshots[0],
        traceId: input.traceId,
      })
      const messages = normalizeStructuredMessages(parsed.structuredMessages ?? parsed.observedMessages ?? parsed.messages)
      if (!messages.length) throw new ModelProviderError('model_no_messages', '模型没有返回可用消息。')
      return {
        ok: true,
        structuredMessages: messages,
        schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 1,
        usage: parsed.usage,
        modelVersion: typeof parsed.modelVersion === 'string' ? parsed.modelVersion : normalized.model,
      }
    },
    async classifyWindow(input) {
      const parsed = await callOpenAICompatibleJson({
        config: normalized,
        systemPrompt: CLASSIFY_WINDOW_SYSTEM_PROMPT,
        userText: buildClassifyWindowUserPrompt(input),
        screenshot: input.screenshot,
        traceId: input.traceId,
      })
      return {
        ok: true,
        windowKind: normalizeWindowKind(parsed.windowKind),
        conversationTitle: nullableString(parsed.conversationTitle),
        isTargetConversation: typeof parsed.isTargetConversation === 'boolean' ? parsed.isTargetConversation : undefined,
        confidence: numberOrUndefined(parsed.confidence),
        layout: normalizeLayout(parsed.layout),
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : undefined,
      }
    },
  }
}

export function createOcrOnlyVisionProvider(): VisionModelProvider {
  return {
    async structureVisibleWindow(input) {
      const messages = normalizeOcrBlocksAsMessages(input.edgeOcrBlocks ?? [])
      return {
        ok: true,
        structuredMessages: messages,
        schemaVersion: 1,
        modelVersion: 'ocr-only',
      }
    },
    async classifyWindow() {
      return {
        ok: true,
        windowKind: 'chat_main',
        confidence: 0.2,
        warnings: ['ocr_only_layout_fallback'],
      }
    },
  }
}

export function stripJsonMarkdownFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return match ? match[1]!.trim() : trimmed
}

export function normalizeStructuredMessages(value: unknown): UseChatStructuredMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item, index) => normalizeStructuredMessage(item, index))
    .filter((item): item is UseChatStructuredMessage => item !== null)
}

const STRUCTURE_WINDOW_SYSTEM_PROMPT = [
  '你是 UseChat 的可见聊天窗口结构化模块。',
  '只根据截图和 OCR hints 输出当前可见消息，不要编造不可见消息。',
  '返回严格 JSON，不要 markdown fence。',
  'JSON schema: {"schemaVersion":1,"structuredMessages":[{"senderRole":"self|contact|system|unknown","senderName":string|null,"kind":"text|image|file|video-file|video-card|link-card|official-account-card|mini-program-card|system|recall|unknown","normalizedText":string|null,"anchorText":string|null,"textExcerpt":string|null,"bbox":object|null}]}。',
].join('\n')

const CLASSIFY_WINDOW_SYSTEM_PROMPT = [
  '你是 UseChat 的微信窗口布局识别模块。',
  '识别截图是否是聊天主窗口，并返回搜索框和消息输入框的大致矩形。',
  '坐标使用 0-999 的归一化截图坐标。只返回 JSON，不要 markdown fence。',
  'JSON schema: {"windowKind":"chat_main|article|settings|login|other","conversationTitle":string|null,"isTargetConversation":boolean,"confidence":number,"layout":{"searchInputRect":{"x":number,"y":number,"width":number,"height":number,"coordinateSpace":"normalized-0-999"},"messageInputRect":{"x":number,"y":number,"width":number,"height":number,"coordinateSpace":"normalized-0-999"}}}。',
].join('\n')

async function callOpenAICompatibleJson(input: {
  config: NormalizedOpenAICompatibleConfig
  systemPrompt: string
  userText: string
  screenshot?: UseChatScreenshot
  traceId?: string
}): Promise<Record<string, unknown>> {
  const fetchImpl = input.config.fetchImpl ?? globalThis.fetch
  if (!fetchImpl) throw new ModelProviderError('model_not_configured', '当前 Node.js 运行时没有 fetch。')
  const apiKey = input.config.env[input.config.apiKeyEnv]
  if (!apiKey) throw new ModelProviderError('model_not_configured', `环境变量 ${input.config.apiKeyEnv} 未设置。`)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.config.timeoutMs)
  try {
    const response = await fetchImpl(`${input.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.config.model,
        temperature: 0,
        ...(shouldDisableThinking(input.config) ? { enable_thinking: false } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: input.systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: input.userText },
              ...(input.screenshot ? [{
                type: 'image_url',
                image_url: { url: `data:${input.screenshot.mimeType};base64,${input.screenshot.dataBase64}` },
              }] : []),
            ],
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new ModelProviderError('model_request_failed', `模型请求失败：HTTP ${response.status}`, { status: response.status })
    }
    const raw = await response.json() as Record<string, unknown>
    const content = extractChatCompletionContent(raw)
    if (!content) throw new ModelProviderError('model_invalid_json', '模型响应缺少 message.content。')
    try {
      const parsed = JSON.parse(stripJsonMarkdownFence(content)) as Record<string, unknown>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
      return parsed
    } catch (error) {
      throw new ModelProviderError('model_invalid_json', '模型返回的 JSON 无法解析。', { cause: error instanceof Error ? error.message : String(error) })
    }
  } catch (error) {
    if (error instanceof ModelProviderError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new ModelProviderError('model_timeout', '模型请求超时。')
    throw new ModelProviderError('model_request_failed', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timeout)
  }
}

type NormalizedOpenAICompatibleConfig = Required<Pick<OpenAICompatibleProviderConfig, 'baseUrl' | 'model' | 'apiKeyEnv' | 'timeoutMs'>> & {
  fetchImpl?: typeof fetch
  env: NodeJS.ProcessEnv
}

function normalizeOpenAICompatibleConfig(config: OpenAICompatibleProviderConfig): NormalizedOpenAICompatibleConfig {
  if (!config.baseUrl?.trim()) throw new ModelProviderError('model_not_configured', 'model.baseUrl 未配置。')
  if (!config.model?.trim()) throw new ModelProviderError('model_not_configured', 'model.name 未配置。')
  if (!config.apiKeyEnv?.trim()) throw new ModelProviderError('model_not_configured', 'model.apiKeyEnv 未配置。')
  return {
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    model: config.model,
    apiKeyEnv: config.apiKeyEnv,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: config.fetchImpl,
    env: config.env ?? process.env,
  }
}

function shouldDisableThinking(config: NormalizedOpenAICompatibleConfig): boolean {
  const baseUrl = config.baseUrl.toLowerCase()
  const model = config.model.toLowerCase()
  return baseUrl.includes('dashscope.aliyuncs.com') || model.startsWith('qwen3')
}

function buildStructureWindowUserPrompt(input: UseChatStructureVisibleWindowInput): string {
  return JSON.stringify({
    task: 'structure-visible-chat-window',
    chatName: input.chatName,
    edgeOcrBlocks: input.edgeOcrBlocks ?? [],
    visibleConversationFingerprints: input.visibleConversationFingerprints ?? [],
    screenshotCount: input.screenshots.length,
  })
}

function buildClassifyWindowUserPrompt(input: UseChatClassifyWindowInput): string {
  return JSON.stringify({
    task: 'classify-wechat-window-layout',
    chatName: input.chatName,
  })
}

function extractChatCompletionContent(raw: Record<string, unknown>): string | null {
  const choices = raw.choices
  if (!Array.isArray(choices)) return null
  const first = choices[0]
  if (!first || typeof first !== 'object') return null
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object') return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') return (part as Record<string, unknown>).text
      return ''
    }).join('')
  }
  return null
}

function normalizeStructuredMessage(value: unknown, index: number): UseChatStructuredMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const senderRole = normalizeSenderRole(record.senderRole)
  const kind = normalizeMessageKind(record.kind)
  const normalizedText = nullableString(record.normalizedText ?? record.text)
  const anchorText = nullableString(record.anchorText) ?? normalizedText ?? nullableString(record.textExcerpt)
  const stableMessageKey = nullableString(record.stableMessageKey) ?? `visible:${index}:${senderRole}:${kind}:${(anchorText ?? '').slice(0, 80)}`
  return {
    stableMessageKey,
    senderRole,
    senderName: nullableString(record.senderName),
    kind,
    normalizedText,
    anchorText,
    textExcerpt: nullableString(record.textExcerpt) ?? normalizedText,
    bbox: record.bbox,
    mediaMetadata: record.mediaMetadata,
    observedAt: nullableString(record.observedAt) ?? new Date().toISOString(),
  }
}

function normalizeOcrBlocksAsMessages(blocks: unknown[]): UseChatStructuredMessage[] {
  const messages: UseChatStructuredMessage[] = []
  blocks.forEach((block, index) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return
      const record = block as Record<string, unknown>
      const text = nullableString(record.text)
      if (!text) return
      messages.push({
        stableMessageKey: `ocr:${index}:${text.slice(0, 80)}`,
        senderRole: 'unknown' as const,
        kind: 'text' as const,
        normalizedText: text,
        anchorText: text,
        textExcerpt: text,
        bbox: record.bbox,
        observedAt: new Date().toISOString(),
      })
    })
  return messages
}

function normalizeSenderRole(value: unknown): UseChatStructuredMessage['senderRole'] {
  return value === 'self' || value === 'contact' || value === 'system' || value === 'unknown' ? value : 'unknown'
}

function normalizeMessageKind(value: unknown): UseChatMessageKind {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-')
  const known: UseChatMessageKind[] = ['text', 'image', 'file', 'video-file', 'video-card', 'link-card', 'official-account-card', 'mini-program-card', 'system', 'recall', 'unknown']
  if (known.includes(normalized as UseChatMessageKind)) return normalized as UseChatMessageKind
  if (normalized === 'video') return 'video-file'
  if (normalized === 'link') return 'link-card'
  if (normalized === 'document') return 'file'
  if (normalized === 'photo' || normalized === 'picture' || normalized === 'img') return 'image'
  return 'unknown'
}

function normalizeWindowKind(value: unknown): UseChatClassifyWindowResult['windowKind'] {
  if (value === 'chat_main' || value === 'article' || value === 'settings' || value === 'login' || value === 'other') return value
  return 'other'
}

function normalizeLayout(value: unknown): UseChatClassifyWindowResult['layout'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return {
    messageInputRect: normalizeRect(record.messageInputRect),
    searchInputRect: normalizeRect(record.searchInputRect),
  }
}

function normalizeRect(value: unknown): UseChatRect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const x = Number(record.x)
  const y = Number(record.y)
  const width = Number(record.width)
  const height = Number(record.height)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height, coordinateSpace: typeof record.coordinateSpace === 'string' ? record.coordinateSpace : undefined }
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
