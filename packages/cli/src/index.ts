#!/usr/bin/env node
// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/cli.test.ts

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import {
  ensureUseChatConfig,
  formatConfigList,
  getConfigValue,
  loadUseChatConfig,
  redactSecrets,
  saveUseChatConfig,
  setConfigValue,
  validateUseChatConfig,
  createWeChatRuntime,
  runWeChatDoctor,
  type UseChatConfig,
} from '@shennian/usechat-core'
import { createOpenAICompatibleVisionProvider } from '@shennian/usechat-model-provider'

const VERSION = '0.1.0'

type GlobalOptions = {
  json: boolean
  configPath?: string
}

type ParsedArgs = {
  command?: string
  subcommand?: string
  flags: Record<string, string | boolean>
  positionals: string[]
  global: GlobalOptions
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv)
  try {
    if (!parsed.command || parsed.flags.help === true || parsed.flags.h === true) {
      printHelp()
      return 0
    }
    if (parsed.flags.version === true || parsed.flags.v === true || parsed.command === '--version') {
      console.log(VERSION)
      return 0
    }
    switch (parsed.command) {
      case 'init': return commandInit(parsed)
      case 'config': return commandConfig(parsed)
      case 'doctor': return commandDoctor(parsed)
      case 'read': return commandRead(parsed)
      case 'write': return commandWrite(parsed)
      default:
        throw new Error(`unknown_command: ${parsed.command}`)
    }
  } catch (error) {
    return handleCliError(error, parsed.global.json || parsed.flags.json === true)
  }
}

async function commandInit(parsed: ParsedArgs): Promise<number> {
  const result = ensureUseChatConfig({ configPath: parsed.global.configPath })
  const validation = validateUseChatConfig(result.config)
  if (parsed.global.json || parsed.flags.json === true) {
    printJson({ ok: true, created: result.created, configPath: result.configPath, config: redactSecrets(result.config), validation })
  } else {
    console.log(result.created ? `已创建配置：${result.configPath}` : `配置已存在：${result.configPath}`)
    if (!validation.ok) {
      console.log('\n下一步建议：')
      for (const issue of validation.issues) console.log(`- ${issue.message}`)
    }
  }
  return 0
}

async function commandConfig(parsed: ParsedArgs): Promise<number> {
  const action = parsed.subcommand
  if (!action || parsed.flags.help === true) {
    printConfigHelp()
    return 0
  }
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  if (action === 'list') {
    if (parsed.global.json || parsed.flags.json === true) printJson({ ok: true, configPath: loaded.configPath, config: redactSecrets(loaded.config) })
    else console.log(formatConfigList(loaded.config))
    return 0
  }
  if (action === 'get') {
    const key = parsed.positionals[0]
    const value = getConfigValue(loaded.config, key)
    if (parsed.global.json || parsed.flags.json === true) printJson({ ok: true, key, value: redactSecrets(value) })
    else if (value === undefined) return 1
    else if (typeof value === 'object') console.log(JSON.stringify(redactSecrets(value), null, 2))
    else console.log(String(value))
    return 0
  }
  if (action === 'set') {
    const [key, ...rest] = parsed.positionals
    const value = rest.join(' ')
    if (!key || rest.length === 0) throw new Error('usage: usechat config set <key> <value>')
    const next = setConfigValue(loaded.config, key, value)
    saveUseChatConfig(next, { configPath: loaded.configPath })
    if (parsed.global.json || parsed.flags.json === true) printJson({ ok: true, key, configPath: loaded.configPath, config: redactSecrets(next) })
    else console.log(`已保存：${key}`)
    return 0
  }
  throw new Error(`unknown_config_command: ${action}`)
}

async function commandDoctor(parsed: ParsedArgs): Promise<number> {
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  const validation = validateUseChatConfig(loaded.config)
  const result = await runWeChatDoctor({
    helperPath: loaded.config.helper.path,
    checkModel: true,
    modelConfigured: validation.ok,
  })
  if (parsed.global.json || parsed.flags.json === true) printJson(result)
  else printDoctor(result)
  return result.ok ? 0 : 1
}

async function commandRead(parsed: ParsedArgs): Promise<number> {
  const app = readStringFlag(parsed, 'app') ?? 'wechat'
  if (app !== 'wechat') throw new Error(`unsupported_app: ${app}`)
  const chat = readStringFlag(parsed, 'chat')
  if (!chat) throw new Error('usage: usechat read --app wechat --chat <name>')
  const limit = readNumberFlag(parsed, 'limit')
  const format = (readStringFlag(parsed, 'format') ?? 'markdown') as 'markdown' | 'json'
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  const provider = createProviderFromConfig(loaded.config)
  const runtime = createWeChatRuntime({ helperPath: loaded.config.helper.path, provider })
  try {
    const result = await runtime.read({ chat, limit, format })
    if (format === 'json' || parsed.global.json || parsed.flags.json === true) printJson(result)
    else process.stdout.write(result.markdown)
    return 0
  } finally {
    await runtime.stop().catch(() => {})
  }
}

async function commandWrite(parsed: ParsedArgs): Promise<number> {
  const app = readStringFlag(parsed, 'app') ?? 'wechat'
  if (app !== 'wechat') throw new Error(`unsupported_app: ${app}`)
  const chat = readStringFlag(parsed, 'chat')
  const text = readStringFlag(parsed, 'text')
  if (!chat || text === undefined) throw new Error('usage: usechat write --app wechat --chat <name> --text <text> [--yes]')
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  const dryRun = parsed.flags['dry-run'] === true
  const yes = parsed.flags.yes === true || parsed.flags.y === true || loaded.config.wechat.sendRequiresConfirm === false
  if (!yes && !dryRun) {
    const confirmed = await confirmSend(chat, text)
    if (!confirmed) {
      if (parsed.global.json || parsed.flags.json === true) printJson({ ok: false, reasonCode: 'user_cancelled', sent: false })
      else console.error('已取消发送。')
      return 2
    }
  }
  const provider = maybeCreateProviderFromConfig(loaded.config)
  const runtime = createWeChatRuntime({ helperPath: loaded.config.helper.path, provider })
  try {
    const result = await runtime.write({ chat, text, yes, dryRun })
    if (parsed.global.json || parsed.flags.json === true) printJson(result)
    else console.log(dryRun ? `dry-run：不会发送到 ${chat}` : `已提交发送到 ${chat}。状态：${result.status}`)
    return 0
  } finally {
    await runtime.stop().catch(() => {})
  }
}

function createProviderFromConfig(config: UseChatConfig) {
  const validation = validateUseChatConfig(config)
  if (!validation.ok) throw new Error(`model_not_configured: ${validation.issues.map((issue) => issue.path).join(', ')}`)
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

async function confirmSend(chat: string, text: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`确认发送到「${chat}」？\n${text}\n输入 yes 继续：`)
    return answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const global: GlobalOptions = { json: false }
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let command: string | undefined
  let subcommand: string | undefined
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [keyRaw, inlineValue] = arg.slice(2).split(/=(.*)/s).filter((item) => item !== undefined)
      const key = keyRaw!
      const value = inlineValue !== undefined ? inlineValue : flagRequiresValue(key) ? argv[++i] : true
      if (key === 'json') global.json = true
      else if (key === 'config') global.configPath = String(value ?? '')
      flags[key] = value ?? true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1)
      flags[key] = true
      if (key === 'v') flags.version = true
      if (key === 'h') flags.help = true
      continue
    }
    if (!command) command = arg
    else if (command === 'config' && !subcommand) subcommand = arg
    else positionals.push(arg)
  }
  return { command, subcommand, flags, positionals, global }
}

function flagRequiresValue(key: string): boolean {
  return ['config', 'app', 'chat', 'text', 'format', 'limit'].includes(key)
}

function readStringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key]
  if (typeof value === 'string') return value
  return undefined
}

function readNumberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = readStringFlag(parsed, key)
  if (value === undefined) return undefined
  const parsedValue = Number(value)
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) throw new Error(`invalid_number: --${key}`)
  return parsedValue
}

function printHelp(): void {
  console.log(`UseChat ${VERSION}

用法：
  usechat init [--json]
  usechat config get [key] [--json]
  usechat config set <key> <value>
  usechat config list [--json]
  usechat doctor [--json]
  usechat read --app wechat --chat <name> [--limit <n>] [--format markdown|json]
  usechat write --app wechat --chat <name> --text <text> [--yes] [--dry-run] [--json]

全局选项：
  --config <path>  指定配置文件路径
  --json           输出 JSON
  --version        输出版本
  --help           显示帮助
`)
}

function printConfigHelp(): void {
  console.log(`用法：
  usechat config list
  usechat config get [key]
  usechat config set model.provider openai-compatible
  usechat config set model.baseUrl https://api.openai.com/v1
  usechat config set model.name gpt-4.1-mini
  usechat config set model.apiKeyEnv OPENAI_API_KEY
  usechat config set helper.path /path/to/wechat-channel/macos
`)
}

function printDoctor(result: Awaited<ReturnType<typeof runWeChatDoctor>>): void {
  console.log(`UseChat doctor (${result.platform})`)
  for (const check of result.checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.id}: ${check.message}${check.reasonCode ? ` [${check.reasonCode}]` : ''}`)
  }
  if (result.helper?.path) console.log(`\nHelper: ${result.helper.path}`)
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(redactSecrets(value), null, 2))
}

function handleCliError(error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error)
  const reasonCode = message.split(':')[0] || 'usechat_error'
  if (json) printJson({ ok: false, reasonCode, message })
  else console.error(`UseChat 错误：${message}`)
  return 1
}

main().then((code) => {
  process.exitCode = code
}).catch((error) => {
  process.exitCode = handleCliError(error, false)
})
