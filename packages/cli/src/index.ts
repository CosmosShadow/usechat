#!/usr/bin/env node
// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/cli.test.ts

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  createUseChatWeChatWatchRunner,
  runWeChatDoctor,
  readUseChatAttachment,
  defaultUseChatTraceJsonlPath,
  type UseChatConfig,
  type UseChatWeChatWatchRunner,
} from '@shennian/usechat-core'
import { createOcrOnlyVisionProvider, createOpenAICompatibleVisionProvider } from '@shennian/usechat-model-provider'
import { runUseChatStdioServer } from './stdio-server.js'

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

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv)
  try {
    if (parsed.flags.version === true || parsed.flags.v === true || parsed.command === '--version') {
      console.log(VERSION)
      return 0
    }
    if (!parsed.command || parsed.flags.help === true || parsed.flags.h === true) {
      printHelp()
      return 0
    }
    switch (parsed.command) {
      case 'init': return await commandInit(parsed)
      case 'config': return await commandConfig(parsed)
      case 'doctor': return await commandDoctor(parsed)
      case 'setup-helper': return await commandSetupHelper(parsed)
      case 'read': return await commandRead(parsed)
      case 'write': return await commandWrite(parsed)
      case 'watch': return await commandWatch(parsed)
      case 'serve': return await commandServe(parsed)
      default:
        throw new Error(`unknown_command: ${parsed.command}`)
    }
  } catch (error) {
    return handleCliError(error, parsed.global.json || parsed.flags.json === true)
  }
}

async function commandSetupHelper(parsed: ParsedArgs): Promise<number> {
  const source = readStringFlag(parsed, 'from') ?? parsed.positionals[0]
  if (!source || parsed.flags.help === true) {
    printSetupHelperHelp()
    return source ? 0 : 1
  }
  const platform = process.platform
  if (platform !== 'darwin' && platform !== 'win32') throw new Error(`unsupported_platform: ${platform}`)
  const target = readStringFlag(parsed, 'target') ?? defaultHelperInstallTarget(platform)
  const result = installHelperRuntime({
    source,
    target,
    platform,
    force: parsed.flags.force === true,
    dryRun: parsed.flags['dry-run'] === true,
  })
  if (parsed.global.json || parsed.flags.json === true) printJson(result)
  else {
    console.log(result.dryRun ? `dry-run：将安装 Helper 到 ${result.target}` : `Helper 已安装到：${result.target}`)
    console.log(`Helper manifest：${result.helperDir}`)
  }
  return 0
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
  const download = readStringFlag(parsed, 'download') ?? 'never'
  if (download !== 'never' && download !== 'auto') throw new Error(`download_mode_unsupported: ${download}`)
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  const provider = createProviderFromConfig(loaded.config)
  const runtime = createWeChatRuntime({ helperPath: loaded.config.helper.path, provider })
  try {
    const traceId = readStringFlag(parsed, 'trace-id') ?? (traceJsonlRequested(parsed) ? `read-${randomUUID()}` : undefined)
    const traceJsonlPath = traceJsonlPathFlag(parsed, traceId ?? `read-${randomUUID()}`)
    const result = await runtime.read({ chat, limit, format, download, ...(traceId ? { traceId } : {}), ...(traceJsonlPath !== undefined ? { traceJsonlPath } : {}) })
    if (format === 'json' || parsed.global.json || parsed.flags.json === true) printJson(result)
    else {
      process.stdout.write(result.markdown)
      if (parsed.flags['trace-summary'] === true) printTraceSummary(result.traceSummary)
    }
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
  const attachment = readWriteAttachmentFlags(parsed)
  if (!chat || (text === undefined && !attachment)) throw new Error('usage: usechat write --app wechat --chat <name> (--text <text> | --file <path> | --image <path> | --video <path>) [--yes]')
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  const attachmentPayload = attachment ? readUseChatAttachment(attachment.path, attachment.kind) : undefined
  const dryRun = parsed.flags['dry-run'] === true
  if (shouldPromptBeforeSend({
    dryRun,
    yesFlag: parsed.flags.yes === true,
    shortYesFlag: parsed.flags.y === true,
    sendRequiresConfirm: loaded.config.wechat.sendRequiresConfirm,
  })) {
    const confirmed = await confirmSend(chat, text ?? attachmentSummary(attachmentPayload))
    if (!confirmed) {
      if (parsed.global.json || parsed.flags.json === true) printJson({ ok: false, reasonCode: 'user_cancelled', sent: false })
      else console.error('已取消发送。')
      return 2
    }
  }
  const yes = parsed.flags.yes === true || parsed.flags.y === true || loaded.config.wechat.sendRequiresConfirm === false
  const provider = maybeCreateProviderFromConfig(loaded.config)
  const runtime = createWeChatRuntime({ helperPath: loaded.config.helper.path, provider })
  try {
    const traceId = readStringFlag(parsed, 'trace-id') ?? (traceJsonlRequested(parsed) ? `write-${randomUUID()}` : undefined)
    const traceJsonlPath = traceJsonlPathFlag(parsed, traceId ?? `write-${randomUUID()}`)
    const result = await runtime.write({ chat, text, ...attachmentPathFlags(parsed), yes, dryRun, ...(traceId ? { traceId } : {}), ...(traceJsonlPath !== undefined ? { traceJsonlPath } : {}) })
    if (parsed.global.json || parsed.flags.json === true) printJson(result)
    else {
      console.log(dryRun ? `dry-run：不会发送到 ${chat}` : `已提交发送到 ${chat}。状态：${result.status}`)
      if (parsed.flags['trace-summary'] === true) printTraceSummary(result.traceSummary)
    }
    return 0
  } finally {
    await runtime.stop().catch(() => {})
  }
}

async function commandWatch(parsed: ParsedArgs): Promise<number> {
  const app = readStringFlag(parsed, 'app') ?? 'wechat'
  if (app !== 'wechat') throw new Error(`unsupported_app: ${app}`)
  const chat = readStringFlag(parsed, 'chat')
  if (!chat) throw new Error('usage: usechat watch --app wechat --chat <name> --emit jsonl')
  const emit = readStringFlag(parsed, 'emit') ?? 'jsonl'
  if (emit !== 'jsonl') throw new Error(`emit_mode_unsupported: ${emit}`)
  const download = readStringFlag(parsed, 'download') ?? 'never'
  if (download !== 'never' && download !== 'auto') throw new Error(`download_mode_unsupported: ${download}`)
  const loaded = loadUseChatConfig({ configPath: parsed.global.configPath })
  const provider = createProviderFromConfig(loaded.config)
  const runtime = createWeChatRuntime({ helperPath: loaded.config.helper.path, provider })
  const pollIntervalMs = readNumberFlag(parsed, 'poll-interval-ms') ?? loaded.config.wechat.pollIntervalMs
  const limit = readNumberFlag(parsed, 'limit')
  const runner = createUseChatWeChatWatchRunner({
    runtime,
    chat,
    dataDir: loaded.config.dataDir,
    pollIntervalMs,
    limit,
    download,
    traceJsonlPath: traceJsonlPathForWatch(parsed),
    onEvent: async (event) => {
      process.stdout.write(`${JSON.stringify(redactSecrets(event))}\n`)
    },
  })
  if (parsed.flags.once === true) {
    try {
      await runner.tick()
      return 0
    } finally {
      await runner.stop().catch(() => {})
    }
  }
  await runner.start()
  await waitForWatchShutdown(runner)
  return 0
}

async function commandServe(parsed: ParsedArgs): Promise<number> {
  const transport = readStringFlag(parsed, 'stdio') === undefined && parsed.flags.stdio !== true ? undefined : 'stdio'
  if (transport !== 'stdio') throw new Error('usage: usechat serve --stdio')
  await runUseChatStdioServer({ configPath: parsed.global.configPath })
  return 0
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

export function shouldPromptBeforeSend(input: {
  dryRun?: boolean
  yesFlag?: boolean
  shortYesFlag?: boolean
  sendRequiresConfirm?: boolean
}): boolean {
  if (input.dryRun) return false
  if (input.yesFlag || input.shortYesFlag) return false
  if (input.sendRequiresConfirm === false) return false
  return true
}

async function confirmSend(chat: string, text: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`确认发送到「${chat}」？\n${text}\n输入 yes 继续：`)
    return isAffirmativeSendConfirmation(answer)
  } finally {
    rl.close()
  }
}

export function isAffirmativeSendConfirmation(answer: string): boolean {
  return answer.trim().toLowerCase() === 'yes'
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
  return ['config', 'app', 'chat', 'text', 'format', 'limit', 'download', 'file', 'image', 'video', 'trace-jsonl', 'trace-id', 'emit', 'poll-interval-ms', 'from', 'target'].includes(key)
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

function readWriteAttachmentFlags(parsed: ParsedArgs): { kind: 'file' | 'image' | 'video'; path: string } | undefined {
  const entries = (['file', 'image', 'video'] as const)
    .map((kind) => ({ kind, path: readStringFlag(parsed, kind) }))
    .filter((entry): entry is { kind: 'file' | 'image' | 'video'; path: string } => Boolean(entry.path))
  if (entries.length > 1) throw new Error('usage: usechat write accepts only one of --file, --image, or --video per command')
  return entries[0]
}

function attachmentPathFlags(parsed: ParsedArgs): { file?: string; image?: string; video?: string } {
  return {
    file: readStringFlag(parsed, 'file'),
    image: readStringFlag(parsed, 'image'),
    video: readStringFlag(parsed, 'video'),
  }
}

function attachmentSummary(attachment?: { kind: string; localPath: string }): string {
  if (!attachment) return ''
  return `[${attachment.kind}: ${attachment.localPath}]`
}

export type InstallHelperRuntimeResult = {
  ok: true
  dryRun: boolean
  platform: NodeJS.Platform | string
  source: string
  target: string
  helperDir: string
  manifestPath: string
}

export function defaultHelperInstallTarget(platform: NodeJS.Platform | string, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'UseChat', 'Helper', 'UseChat Helper.app')
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'Programs', 'UseChat Helper')
  }
  throw new Error(`unsupported_platform: ${platform}`)
}

export function installHelperRuntime(input: {
  source: string
  target: string
  platform: NodeJS.Platform | string
  force?: boolean
  dryRun?: boolean
}): InstallHelperRuntimeResult {
  const source = path.resolve(expandHome(input.source))
  const target = path.resolve(expandHome(input.target))
  const extracted = prepareHelperSource(source, input.platform)
  const sourceRoot = extracted.sourceRoot
  const helperDir = helperDirForInstalledTarget(target, input.platform)
  const manifestPath = path.join(helperDir, 'manifest.json')
  try {
    if (!fs.existsSync(path.join(helperDirForInstalledTarget(sourceRoot, input.platform), 'manifest.json'))) {
      throw new Error(`helper_manifest_missing: ${source}`)
    }
    if (!input.dryRun) {
      if (fs.existsSync(target)) {
        if (!input.force) throw new Error(`target_exists: ${target}; pass --force to replace it`)
        stopRunningHelperBeforeReplace(input.platform)
        fs.rmSync(target, { recursive: true, force: true })
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(sourceRoot, target, { recursive: true })
      if (input.platform === 'darwin') {
        ensureExecutableBit(path.join(target, 'Contents', 'MacOS', 'UseChat Helper'))
        ensureExecutableBit(path.join(target, 'Contents', 'MacOS', 'Shennian Helper'))
      }
      if (!fs.existsSync(manifestPath)) throw new Error(`helper_manifest_missing_after_install: ${manifestPath}`)
    }
    return {
      ok: true,
      dryRun: input.dryRun === true,
      platform: input.platform,
      source,
      target,
      helperDir,
      manifestPath,
    }
  } finally {
    if (extracted.cleanupDir) fs.rmSync(extracted.cleanupDir, { recursive: true, force: true })
  }
}

function stopRunningHelperBeforeReplace(platform: NodeJS.Platform | string): void {
  if (platform !== 'win32') return
  // Mirrors the Shennian Windows helper-runtime installer behavior:
  // Stop-Process -Name "shennian-wechat-channel-helper" -Force -ErrorAction SilentlyContinue
  spawnSync('taskkill.exe', ['/IM', 'shennian-wechat-channel-helper.exe', '/F', '/T'], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

function prepareHelperSource(source: string, platform: NodeJS.Platform | string): { sourceRoot: string; cleanupDir?: string } {
  if (!fs.existsSync(source)) throw new Error(`helper_source_missing: ${source}`)
  if (fs.statSync(source).isDirectory()) {
    const direct = normalizeHelperRuntimeRoot(source, platform)
    return { sourceRoot: direct }
  }
  if (!source.toLowerCase().endsWith('.zip')) throw new Error(`helper_source_unsupported: ${source}`)
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-helper-runtime-'))
  unzipArchive(source, tempDir)
  return { sourceRoot: normalizeHelperRuntimeRoot(tempDir, platform), cleanupDir: tempDir }
}

function normalizeHelperRuntimeRoot(root: string, platform: NodeJS.Platform | string): string {
  const candidates = platform === 'darwin'
    ? [
        root,
        path.join(root, 'UseChat Helper.app'),
        path.join(root, 'Shennian Helper.app'),
        ...safeReaddir(root).filter((entry) => entry.endsWith('.app')).map((entry) => path.join(root, entry)),
      ]
    : [
        root,
        path.join(root, 'UseChat Helper'),
        path.join(root, 'Shennian Helper'),
      ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(helperDirForInstalledTarget(candidate, platform), 'manifest.json'))) return candidate
  }
  throw new Error(`helper_manifest_missing: ${root}`)
}

function helperDirForInstalledTarget(target: string, platform: NodeJS.Platform | string): string {
  if (platform === 'darwin') return path.join(target, 'Contents', 'Resources', 'wechat-channel', 'macos')
  if (platform === 'win32') return path.join(target, 'resources', 'wechat-channel', 'windows')
  throw new Error(`unsupported_platform: ${platform}`)
}

function unzipArchive(zipPath: string, outputDir: string): void {
  const command = process.platform === 'win32' ? 'powershell.exe' : 'ditto'
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(outputDir)} -Force`]
    : ['-x', '-k', zipPath, outputDir]
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`helper_zip_extract_failed: ${result.stderr || result.stdout || result.status}`)
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

function ensureExecutableBit(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const stat = fs.statSync(filePath)
  fs.chmodSync(filePath, stat.mode | 0o755)
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function traceJsonlRequested(parsed: ParsedArgs): boolean {
  return parsed.flags['trace-jsonl'] === true || typeof parsed.flags['trace-jsonl'] === 'string'
}

function traceJsonlPathFlag(parsed: ParsedArgs, fallbackTraceId: string): string | null | undefined {
  if (parsed.flags['trace-jsonl'] === true) return defaultUseChatTraceJsonlPath(fallbackTraceId)
  if (typeof parsed.flags['trace-jsonl'] === 'string') return parsed.flags['trace-jsonl']
  if (parsed.flags['no-trace-jsonl'] === true) return null
  return undefined
}

function traceJsonlPathForWatch(parsed: ParsedArgs): ((input: { traceId: string; tickIndex: number }) => string | null | undefined) | string | null | undefined {
  if (parsed.flags['trace-jsonl'] === true) return ({ traceId }) => defaultUseChatTraceJsonlPath(traceId)
  if (typeof parsed.flags['trace-jsonl'] === 'string') return parsed.flags['trace-jsonl']
  if (parsed.flags['no-trace-jsonl'] === true) return null
  return undefined
}

async function waitForWatchShutdown(runner: UseChatWeChatWatchRunner): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false
    const stop = () => {
      if (settled) return
      settled = true
      cleanup()
      void runner.stop().finally(resolve)
    }
    const cleanup = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

function printTraceSummary(summary: { status: string; traceId: string; jsonlPath?: string; failedPhase?: string; reasonCode?: string; eventCount?: number } | undefined): void {
  if (!summary) return
  const parts = [
    `trace=${summary.traceId}`,
    `status=${summary.status}`,
    typeof summary.eventCount === 'number' ? `events=${summary.eventCount}` : null,
    summary.failedPhase ? `failedPhase=${summary.failedPhase}` : null,
    summary.reasonCode ? `reason=${summary.reasonCode}` : null,
    summary.jsonlPath ? `jsonl=${summary.jsonlPath}` : null,
  ].filter(Boolean)
  console.error(`Trace summary: ${parts.join(' ')}`)
}

function printHelp(): void {
  console.log(`UseChat ${VERSION}

用法：
  usechat init [--json]
  usechat config get [key] [--json]
  usechat config set <key> <value>
  usechat config list [--json]
  usechat setup-helper --from <helper-runtime.zip|app|dir> [--target <path>] [--force]
  usechat doctor [--json]
  usechat read --app wechat --chat <name> [--limit <n>] [--format markdown|json] [--download never|auto] [--trace-id <id>] [--trace-jsonl [path]]
  usechat write --app wechat --chat <name> --text <text> [--yes] [--dry-run] [--json] [--trace-id <id>] [--trace-jsonl [path]]
  usechat watch --app wechat --chat <name> --emit jsonl [--poll-interval-ms <ms>] [--download never|auto]
  usechat serve --stdio

全局选项：
  --config <path>  指定配置文件路径
  --json           输出 JSON
  --version        输出版本
  --help           显示帮助
`)
}

function printSetupHelperHelp(): void {
  console.log(`用法：
  usechat setup-helper --from <helper-runtime.zip|UseChat Helper.app|dir> [--target <path>] [--force] [--json]

说明：
  setup-helper 是显式安装动作，不会在 npm install/postinstall 阶段自动运行。
  macOS 默认安装到 ~/Library/Application Support/UseChat/Helper/UseChat Helper.app
  Windows 默认安装到 %LOCALAPPDATA%\\Programs\\UseChat Helper
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
  usechat config set wechat.pollIntervalMs 60000
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

if (isCliEntrypoint()) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error) => {
    process.exitCode = handleCliError(error, false)
  })
}

export function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1]
  if (!entrypoint) return false
  return isSameEntrypointPath(entrypoint, fileURLToPath(import.meta.url))
}

export function isSameEntrypointPath(entrypoint: string, modulePath: string): boolean {
  return realpathOrResolve(entrypoint) === realpathOrResolve(modulePath)
}

function realpathOrResolve(filePath: string): string {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return path.resolve(filePath)
  }
}
