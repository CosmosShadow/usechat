// @arch ../../../docs/AGENT_INTEGRATION.md
// @test src/__tests__/stdio-server.test.ts

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import {
  loadUseChatConfig,
  redactSecrets,
  validateUseChatConfig,
  createWeChatRuntime,
  runWeChatDoctor,
  type UseChatConfig,
} from '@shennian/usechat-core'
import { createOcrOnlyVisionProvider, createOpenAICompatibleVisionProvider } from '@shennian/usechat-model-provider'

export type UseChatStdioServerOptions = {
  configPath?: string
  input?: Readable
  output?: Writable
  runtimeFactory?: typeof createWeChatRuntime
  doctorRunner?: typeof runWeChatDoctor
}

type StdioRequest = {
  id?: string | number | null
  tool?: string
  method?: string
  input?: unknown
  params?: unknown
}

type ToolInput = Record<string, unknown>

type ToolHandlerContext = Required<Pick<UseChatStdioServerOptions, 'runtimeFactory' | 'doctorRunner'>> & {
  configPath?: string
}

export async function runUseChatStdioServer(options: UseChatStdioServerOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const rl = createInterface({ input, crlfDelay: Infinity })
  const context: ToolHandlerContext = {
    configPath: options.configPath,
    runtimeFactory: options.runtimeFactory ?? createWeChatRuntime,
    doctorRunner: options.doctorRunner ?? runWeChatDoctor,
  }
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const response = await handleStdioLine(trimmed, context)
    output.write(`${JSON.stringify(redactSecrets(response))}\n`)
  }
}

export async function handleStdioLine(line: string, context: ToolHandlerContext): Promise<Record<string, unknown>> {
  let request: StdioRequest
  try {
    request = JSON.parse(line) as StdioRequest
  } catch (error) {
    return errorResponse(null, 'invalid_json', error instanceof Error ? error.message : String(error))
  }
  const id = request.id ?? null
  const tool = normalizeToolName(request.tool ?? request.method)
  const input = normalizeToolInput(request.input ?? request.params)
  if (!tool) return errorResponse(id, 'tool_missing', 'request.tool or request.method is required')
  try {
    const result = await dispatchTool(tool, input, context)
    return { id, ok: true, tool, result }
  } catch (error) {
    return errorResponse(id, reasonCodeFromError(error), error instanceof Error ? error.message : String(error), tool)
  }
}

async function dispatchTool(tool: string, input: ToolInput, context: ToolHandlerContext): Promise<unknown> {
  switch (tool) {
    case 'doctor': return runDoctorTool(input, context)
    case 'read': return runReadTool(input, context)
    case 'write': return runWriteTool(input, context)
    default: throw new Error(`tool_not_found: ${tool}`)
  }
}

async function runDoctorTool(input: ToolInput, context: ToolHandlerContext): Promise<unknown> {
  const loaded = loadUseChatConfig({ configPath: stringValue(input.configPath) ?? context.configPath })
  const validation = validateUseChatConfig(loaded.config)
  return context.doctorRunner({
    helperPath: loaded.config.helper.path,
    checkModel: booleanValue(input.checkModel) ?? true,
    modelConfigured: validation.ok,
  })
}

async function runReadTool(input: ToolInput, context: ToolHandlerContext): Promise<unknown> {
  const chat = requiredString(input.chat, 'chat')
  const app = stringValue(input.app) ?? 'wechat'
  if (app !== 'wechat') throw new Error(`unsupported_app: ${app}`)
  const format = (stringValue(input.format) ?? 'json') as 'json' | 'markdown'
  if (format !== 'json' && format !== 'markdown') throw new Error(`format_unsupported: ${format}`)
  const download = (stringValue(input.download) ?? 'never') as 'never' | 'auto'
  if (download !== 'never' && download !== 'auto') throw new Error(`download_mode_unsupported: ${download}`)
  const loaded = loadUseChatConfig({ configPath: stringValue(input.configPath) ?? context.configPath })
  const runtime = context.runtimeFactory({ helperPath: loaded.config.helper.path, provider: createProviderFromConfig(loaded.config) })
  try {
    return await runtime.read({
      chat,
      limit: positiveIntegerValue(input.limit),
      format,
      download,
      traceId: stringValue(input.traceId) ?? `serve-read-${randomUUID()}`,
    })
  } finally {
    await runtime.stop().catch(() => {})
  }
}

async function runWriteTool(input: ToolInput, context: ToolHandlerContext): Promise<unknown> {
  const chat = requiredString(input.chat, 'chat')
  const app = stringValue(input.app) ?? 'wechat'
  if (app !== 'wechat') throw new Error(`unsupported_app: ${app}`)
  const text = stringValue(input.text)
  const file = stringValue(input.file)
  const image = stringValue(input.image)
  const video = stringValue(input.video)
  if (text === undefined && !file && !image && !video) throw new Error('wechat_write_empty: text or attachment is required')
  const loaded = loadUseChatConfig({ configPath: stringValue(input.configPath) ?? context.configPath })
  const yes = booleanValue(input.yes) ?? loaded.config.wechat.sendRequiresConfirm === false
  if (!yes && !booleanValue(input.dryRun)) throw new Error('confirmation_required: write requires yes:true or dryRun:true in stdio mode')
  const runtime = context.runtimeFactory({ helperPath: loaded.config.helper.path, provider: maybeCreateProviderFromConfig(loaded.config) })
  try {
    return await runtime.write({
      chat,
      text,
      file,
      image,
      video,
      yes,
      dryRun: booleanValue(input.dryRun) ?? false,
      traceId: stringValue(input.traceId) ?? `serve-write-${randomUUID()}`,
    })
  } finally {
    await runtime.stop().catch(() => {})
  }
}

function createProviderFromConfig(config: UseChatConfig) {
  const validation = validateUseChatConfig(config)
  if (!validation.ok) throw new Error(`model_not_configured: ${validation.issues.map((issue) => issue.path).join(', ')}`)
  if (config.model.provider === 'ocr-only') return createOcrOnlyVisionProvider()
  return createOpenAICompatibleVisionProvider({
    baseUrl: config.model.baseUrl!,
    model: config.model.name!,
    apiKeyEnv: config.model.apiKeyEnv!,
    timeoutMs: config.model.timeoutMs,
  })
}

function maybeCreateProviderFromConfig(config: UseChatConfig) {
  const validation = validateUseChatConfig(config)
  if (!validation.ok) return undefined
  return createProviderFromConfig(config)
}

function normalizeToolName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return normalized.startsWith('usechat.') ? normalized.slice('usechat.'.length) : normalized
}

function normalizeToolInput(value: unknown): ToolInput {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ToolInput : {}
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value)
  if (!result) throw new Error(`missing_required_field: ${name}`)
  return result
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  return undefined
}

function positiveIntegerValue(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error('invalid_number: limit')
  return parsed
}

function errorResponse(id: string | number | null, reasonCode: string, message: string, tool?: string): Record<string, unknown> {
  return { id, ok: false, ...(tool ? { tool } : {}), reasonCode, message }
}

function reasonCodeFromError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(':', 1)[0]?.trim()
  return /^[a-z0-9_]+$/i.test(code || '') ? code! : 'usechat_stdio_error'
}
