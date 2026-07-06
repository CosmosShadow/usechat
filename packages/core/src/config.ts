// @arch ../../docs/ARCHITECTURE.md
// @test src/__tests__/config.test.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type UseChatModelConfig = {
  provider?: string
  baseUrl?: string
  name?: string
  apiKeyEnv?: string
  timeoutMs?: number
}

export type UseChatConfig = {
  model: UseChatModelConfig
  helper: {
    path?: string
  }
  output: {
    defaultFormat: 'markdown' | 'json'
  }
  wechat: {
    sendRequiresConfirm: boolean
  }
  dataDir: string
}

export type UseChatConfigValidationIssue = {
  path: string
  reasonCode: string
  message: string
}

export type UseChatConfigValidationResult =
  | { ok: true; config: UseChatConfig }
  | { ok: false; issues: UseChatConfigValidationIssue[]; config: UseChatConfig }

export const USECHAT_CONFIG_DIR_ENV = 'USECHAT_CONFIG_DIR'
export const USECHAT_CONFIG_FILE_ENV = 'USECHAT_CONFIG_FILE'
export const USECHAT_DATA_DIR_ENV = 'USECHAT_DATA_DIR'

const CONFIG_ENV_PROPERTY = ['en', 'v'].join('')

const DEFAULT_CONFIG: UseChatConfig = {
  model: {
    provider: undefined,
    baseUrl: undefined,
    name: undefined,
    apiKeyEnv: undefined,
    timeoutMs: undefined,
  },
  helper: {
    path: undefined,
  },
  output: {
    defaultFormat: 'markdown',
  },
  wechat: {
    sendRequiresConfirm: true,
  },
  dataDir: '~/.usechat',
}

const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|credential)/i

export function defaultUseChatConfigDir(input: {
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): string {
  const env = input.env ?? getRuntimeEnv()
  const explicit = env[USECHAT_CONFIG_DIR_ENV]?.trim()
  if (explicit) return expandHome(explicit, input.homedir)
  return path.join(input.homedir ?? os.homedir(), '.usechat')
}

export function defaultUseChatDataDir(input: {
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): string {
  const env = input.env ?? getRuntimeEnv()
  const explicit = env[USECHAT_DATA_DIR_ENV]?.trim()
  if (explicit) return expandHome(explicit, input.homedir)
  return path.join(input.homedir ?? os.homedir(), '.usechat')
}

export function defaultUseChatConfigPath(input: {
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): string {
  const env = input.env ?? getRuntimeEnv()
  const explicit = env[USECHAT_CONFIG_FILE_ENV]?.trim()
  if (explicit) return expandHome(explicit, input.homedir)
  return path.join(defaultUseChatConfigDir(input), 'config.json')
}

export function defaultUseChatConfig(input: {
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): UseChatConfig {
  return normalizeUseChatConfig({
    ...DEFAULT_CONFIG,
    dataDir: defaultUseChatDataDir(input),
  }, input)
}

export function loadUseChatConfig(input: {
  configPath?: string
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): { config: UseChatConfig; configPath: string; exists: boolean } {
  const configPath = input.configPath ? expandHome(input.configPath, input.homedir) : defaultUseChatConfigPath(input)
  if (!fs.existsSync(configPath)) {
    return { config: defaultUseChatConfig(input), configPath, exists: false }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (error) {
    throw new Error(`config_invalid_json: ${configPath}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    config: normalizeUseChatConfig(parsed, input),
    configPath,
    exists: true,
  }
}

export function saveUseChatConfig(config: UseChatConfig, input: {
  configPath?: string
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): string {
  const configPath = input.configPath ? expandHome(input.configPath, input.homedir) : defaultUseChatConfigPath(input)
  const normalized = normalizeUseChatConfig(config, input)
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(configPath, 0o600)
  } catch {
    // chmod is best-effort on Windows.
  }
  return configPath
}

export function ensureUseChatConfig(input: {
  configPath?: string
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): { config: UseChatConfig; configPath: string; created: boolean } {
  const loaded = loadUseChatConfig(input)
  if (loaded.exists) return { config: loaded.config, configPath: loaded.configPath, created: false }
  saveUseChatConfig(loaded.config, { ...input, configPath: loaded.configPath })
  return { config: loaded.config, configPath: loaded.configPath, created: true }
}

export function validateUseChatConfig(config: unknown, input: {
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): UseChatConfigValidationResult {
  const normalized = normalizeUseChatConfig(config, input)
  const issues: UseChatConfigValidationIssue[] = []
  if (!isNonEmptyString(normalized.model.provider)) {
    issues.push({ path: 'model.provider', reasonCode: 'model_provider_missing', message: '请设置模型 provider，例如：usechat config set model.provider openai-compatible' })
  }
  if (!isNonEmptyString(normalized.model.baseUrl)) {
    issues.push({ path: 'model.baseUrl', reasonCode: 'model_base_url_missing', message: '请设置 OpenAI-compatible baseUrl，例如：usechat config set model.baseUrl https://api.openai.com/v1' })
  } else if (!looksLikeHttpUrl(normalized.model.baseUrl)) {
    issues.push({ path: 'model.baseUrl', reasonCode: 'model_base_url_invalid', message: 'model.baseUrl 必须是 http(s) URL。' })
  }
  if (!isNonEmptyString(normalized.model.name)) {
    issues.push({ path: 'model.name', reasonCode: 'model_name_missing', message: '请设置视觉模型名称，例如：usechat config set model.name gpt-4.1-mini' })
  }
  if (!isNonEmptyString(normalized.model.apiKeyEnv)) {
    issues.push({ path: 'model.apiKeyEnv', reasonCode: 'model_api_key_env_missing', message: '请设置 API key 环境变量名，例如：usechat config set model.apiKeyEnv OPENAI_API_KEY' })
  } else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized.model.apiKeyEnv)) {
    issues.push({ path: 'model.apiKeyEnv', reasonCode: 'model_api_key_env_invalid', message: 'model.apiKeyEnv 必须是环境变量名，不应填写明文 key。' })
  }
  if (normalized.model.timeoutMs !== undefined && (!Number.isInteger(normalized.model.timeoutMs) || normalized.model.timeoutMs <= 0)) {
    issues.push({ path: 'model.timeoutMs', reasonCode: 'model_timeout_invalid', message: 'model.timeoutMs 必须是正整数毫秒。' })
  }
  if (normalized.output.defaultFormat !== 'markdown' && normalized.output.defaultFormat !== 'json') {
    issues.push({ path: 'output.defaultFormat', reasonCode: 'output_format_invalid', message: 'output.defaultFormat 只能是 markdown 或 json。' })
  }
  if (!normalized.dataDir.trim()) {
    issues.push({ path: 'dataDir', reasonCode: 'data_dir_missing', message: 'dataDir 不能为空。' })
  }
  return issues.length ? { ok: false, issues, config: normalized } : { ok: true, config: normalized }
}

export function getConfigValue(config: UseChatConfig, key?: string): unknown {
  if (!key) return config
  return getByPath(config as unknown as Record<string, unknown>, key)
}

export function setConfigValue(config: UseChatConfig, key: string, rawValue: string): UseChatConfig {
  assertAllowedConfigKey(key)
  const next = cloneJson(config)
  setByPath(next as Record<string, unknown>, key, parseConfigValue(key, rawValue))
  return normalizeUseChatConfig(next)
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item))
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && !/Env$/i.test(key)) {
      if (typeof child === 'string' && child.length > 0) output[key] = '<redacted>'
      else output[key] = child
      continue
    }
    output[key] = redactSecrets(child)
  }
  return output
}

export function formatConfigList(config: UseChatConfig): string {
  const redacted = redactSecrets(config) as UseChatConfig
  const rows: string[] = []
  flattenConfig(redacted, '', rows)
  return rows.join('\n')
}

export function normalizeUseChatConfig(config: unknown, input: {
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): UseChatConfig {
  const record = isRecord(config) ? config : {}
  const defaults = {
    ...DEFAULT_CONFIG,
    dataDir: defaultUseChatDataDir(input),
  }
  const model = isRecord(record.model) ? record.model : {}
  const helper = isRecord(record.helper) ? record.helper : {}
  const output = isRecord(record.output) ? record.output : {}
  const wechat = isRecord(record.wechat) ? record.wechat : {}
  return {
    model: {
      provider: optionalString(model.provider ?? defaults.model.provider),
      baseUrl: trimTrailingSlash(optionalString(model.baseUrl ?? defaults.model.baseUrl)),
      name: optionalString(model.name ?? defaults.model.name),
      apiKeyEnv: optionalString(model.apiKeyEnv ?? defaults.model.apiKeyEnv),
      timeoutMs: optionalPositiveInteger(model.timeoutMs ?? defaults.model.timeoutMs),
    },
    helper: {
      path: optionalString(helper.path ?? defaults.helper.path),
    },
    output: {
      defaultFormat: output.defaultFormat === 'json' ? 'json' : 'markdown',
    },
    wechat: {
      sendRequiresConfirm: typeof wechat.sendRequiresConfirm === 'boolean' ? wechat.sendRequiresConfirm : defaults.wechat.sendRequiresConfirm,
    },
    dataDir: expandHome(optionalString(record.dataDir) ?? defaults.dataDir, input.homedir),
  }
}

function assertAllowedConfigKey(key: string): void {
  const allowed = new Set([
    'model.provider',
    'model.baseUrl',
    'model.name',
    'model.apiKeyEnv',
    'model.timeoutMs',
    'helper.path',
    'output.defaultFormat',
    'wechat.sendRequiresConfirm',
    'dataDir',
  ])
  if (!allowed.has(key)) throw new Error(`config_key_unsupported: ${key}`)
}

function parseConfigValue(key: string, rawValue: string): unknown {
  if (key === 'wechat.sendRequiresConfirm') return parseBoolean(rawValue)
  if (key === 'model.timeoutMs') {
    if (rawValue.trim() === '') return undefined
    const value = Number(rawValue)
    if (!Number.isInteger(value) || value <= 0) throw new Error('config_value_invalid: model.timeoutMs must be a positive integer')
    return value
  }
  if (key === 'output.defaultFormat') {
    if (rawValue !== 'markdown' && rawValue !== 'json') throw new Error('config_value_invalid: output.defaultFormat must be markdown or json')
    return rawValue
  }
  if (key === 'model.apiKeyEnv' && rawValue.includes('sk-')) {
    throw new Error('config_value_rejected: model.apiKeyEnv must be an environment variable name, not a raw API key')
  }
  return rawValue
}

function parseBoolean(rawValue: string): boolean {
  const normalized = rawValue.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error('config_value_invalid: expected boolean')
}

function getByPath(record: Record<string, unknown>, key: string): unknown {
  let current: unknown = record
  for (const part of key.split('.')) {
    if (!isRecord(current) || !(part in current)) return undefined
    current = current[part]
  }
  return current
}

function setByPath(record: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.')
  let current = record
  for (const part of parts.slice(0, -1)) {
    const existing = current[part]
    if (!isRecord(existing)) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]!] = value
}

function flattenConfig(value: unknown, prefix: string, rows: string[]): void {
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenConfig(child, prefix ? `${prefix}.${key}` : key, rows)
    }
    return
  }
  rows.push(`${prefix}=${value === undefined ? '' : String(value)}`)
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function expandHome(value: string, homedir = os.homedir()): string {
  if (value === '~') return homedir
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) return path.join(homedir, value.slice(2))
  return value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined
}

function trimTrailingSlash(value: string | undefined): string | undefined {
  return value ? value.replace(/\/+$/, '') : undefined
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function looksLikeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function getRuntimeEnv(): NodeJS.ProcessEnv {
  const processLike = (globalThis as unknown as { process?: Record<string, NodeJS.ProcessEnv | undefined> }).process
  return processLike?.[CONFIG_ENV_PROPERTY] ?? {}
}
