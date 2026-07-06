#!/usr/bin/env node
// @arch ../docs/ARCHITECTURE.md
// @test ../packages/core/src/__tests__/wechat-runtime.test.ts

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const cliPath = path.resolve(repoRoot, options.cli ?? 'packages/cli/dist/index.js')
const tmpDir = options.config
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-smoke-work-'))
  : fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-smoke-'))
const configPath = options.config ? path.resolve(options.config) : path.join(tmpDir, 'config.json')
const summary = {
  ok: false,
  chat: options.chat,
  tmpDir,
  configPath,
  cliPath,
  marker: options.marker,
  steps: [],
}

if (!fs.existsSync(cliPath)) {
  finish({
    ...summary,
    blockerReasonCode: 'cli_not_built',
    message: `CLI 不存在：${cliPath}；请先运行 pnpm build。`,
  })
}

runStep('init', ['--json', 'init'], { parseJson: true })
runStep('config-provider', ['config', 'set', 'model.provider', options.provider], { parseJson: false })
const doctor = runStep('doctor', ['--json', 'doctor'], { parseJson: true, timeoutMs: options.timeoutMs })
const read = runStep('read-abc', [
  '--json',
  'read',
  '--app',
  'wechat',
  '--chat',
  options.chat,
  '--limit',
  String(options.limit),
  '--format',
  'json',
  '--download',
  'never',
], { parseJson: true, timeoutMs: options.timeoutMs })

let write = null
let verify = null
if (!options.skipWrite && read.compact?.ok === true) {
  write = runStep('write-abc', [
    '--json',
    'write',
    '--app',
    'wechat',
    '--chat',
    options.chat,
    '--text',
    options.marker,
    '--yes',
  ], { parseJson: true, timeoutMs: options.timeoutMs })
  verify = runStep('read-abc-after-write', [
    '--json',
    'read',
    '--app',
    'wechat',
    '--chat',
    options.chat,
    '--limit',
    String(options.verifyLimit),
    '--format',
    'json',
    '--download',
    'never',
  ], { parseJson: true, timeoutMs: options.timeoutMs })
} else if (!options.skipWrite) {
  const reasonCode = read.compact?.reasonCode || 'read_failed'
  write = {
    compact: {
      ok: false,
      sent: false,
      reasonCode,
    },
  }
  summary.steps.push({
    id: 'write-abc',
    status: null,
    signal: null,
    durationMs: 0,
    stdoutLen: 0,
    stderrLen: 0,
    skipped: true,
    skipReasonCode: reasonCode,
    compact: write.compact,
  })
}

const finalSummary = {
  ...summary,
  doctor: doctor.compact,
  read: read.compact,
  ...(write ? { write: write.compact } : {}),
  ...(verify ? { verify: verify.compact } : {}),
}
finalSummary.ok = finalSummary.doctor?.ok === true
  && finalSummary.read?.ok === true
  && (options.skipWrite || (finalSummary.write?.sent === true && finalSummary.verify?.markerFound === true))
finalSummary.blockerReasonCode = firstReasonCode(finalSummary)
finish(finalSummary)

function runStep(id, args, stepOptions = {}) {
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [cliPath, '--config', configPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: stepOptions.timeoutMs ?? 180_000,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
    },
  })
  const parsed = stepOptions.parseJson ? parseJson(result.stdout) : null
  const step = {
    id,
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    stdoutLen: result.stdout?.length ?? 0,
    stderrLen: result.stderr?.length ?? 0,
    compact: compactResult(id, parsed, result.stderr),
  }
  if (result.error) step.error = result.error.message
  if (result.stderr) step.stderrPreview = result.stderr.slice(0, 600)
  if (result.status !== 0 && result.stdout) step.stdoutPreview = result.stdout.slice(0, 800)
  summary.steps.push(step)
  return step
}

function compactResult(id, parsed, stderr = '') {
  const cliReasonCode = parsed?.reasonCode || extractCliReasonCode(stderr)
  if (!parsed) {
    if (!cliReasonCode) return null
    return { ok: false, reasonCode: cliReasonCode }
  }
  if (id === 'doctor') {
    return {
      ok: parsed.ok === true,
      reasonCode: cliReasonCode,
      platform: parsed.platform,
      failed: Array.isArray(parsed.checks)
        ? parsed.checks.filter((check) => !check.ok).map((check) => ({
            id: check.id,
            reasonCode: check.reasonCode,
          }))
        : [],
      helperVersion: parsed.helper?.version,
      helperPathFound: Boolean(parsed.helper?.path),
    }
  }
  if (id.includes('read')) {
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const texts = messages.map((message) => String(message.normalizedText || message.textExcerpt || ''))
    const compactMarker = compactComparableText(options.marker)
    return {
      ok: parsed.ok === true,
      reasonCode: cliReasonCode,
      messageCount: messages.length,
      containsChatName: texts.some((text) => text.includes(options.chat)),
      markerFound: texts.some((text) => text.includes(options.marker) || compactComparableText(text).includes(compactMarker)),
      traceId: parsed.traceId,
      window: parsed.window?.bounds,
    }
  }
  if (id.includes('write')) {
    return {
      ok: parsed.ok === true,
      reasonCode: cliReasonCode,
      sent: parsed.sent === true,
      status: parsed.status,
      traceId: parsed.traceId,
      warningCount: Array.isArray(parsed.warnings) ? parsed.warnings.length : 0,
    }
  }
  return {
    ok: parsed.ok === true,
    reasonCode: cliReasonCode,
  }
}

function firstReasonCode(value) {
  if (value.read?.reasonCode) return value.read.reasonCode
  if (value.write?.reasonCode) return value.write.reasonCode
  if (value.verify?.reasonCode) return value.verify.reasonCode
  const failedDoctor = value.doctor?.failed?.[0]
  return failedDoctor?.reasonCode
}

function extractCliReasonCode(stderr) {
  const text = String(stderr || '').trim()
  if (!text) return undefined
  const knownReasonCode = [
    'wechat_login_required',
    'windows_visible_desktop_unavailable',
    'wechat_window_not_found',
    'wechat_window_unavailable',
    'wechat_not_running',
    'model_not_configured',
    'helper_runtime_required',
    'helper_missing',
  ].find((reasonCode) => text.includes(reasonCode) || text.includes(reasonCode.replace(/^w/, '')))
  if (knownReasonCode) return knownReasonCode
  const match = /UseChat\s+\S+[:：]\s*([a-z0-9_.-]+)/i.exec(text)
    ?? /([a-z0-9_.-]+)(?::|\s*$)/i.exec(text)
  return match?.[1]
}

function compactComparableText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, '')
}

function finish(value) {
  const json = `${JSON.stringify(value, null, 2)}\n`
  if (options.out) {
    const outPath = path.resolve(options.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, json)
  }
  process.stdout.write(json)
  process.exit(value.ok ? 0 : 1)
}

function parseJson(text) {
  if (!String(text || '').trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseArgs(argv) {
  const parsed = {
    chat: 'ABC',
    provider: 'ocr-only',
    limit: 80,
    verifyLimit: 120,
    timeoutMs: 180_000,
    skipWrite: false,
    marker: `UseChat smoke ${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') continue
    else if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--chat') parsed.chat = requiredValue(argv, ++i, arg)
    else if (arg === '--provider') parsed.provider = requiredValue(argv, ++i, arg)
    else if (arg === '--cli') parsed.cli = requiredValue(argv, ++i, arg)
    else if (arg === '--config') parsed.config = requiredValue(argv, ++i, arg)
    else if (arg === '--out') parsed.out = requiredValue(argv, ++i, arg)
    else if (arg === '--marker') parsed.marker = requiredValue(argv, ++i, arg)
    else if (arg === '--limit') parsed.limit = positiveInteger(requiredValue(argv, ++i, arg), arg)
    else if (arg === '--verify-limit') parsed.verifyLimit = positiveInteger(requiredValue(argv, ++i, arg), arg)
    else if (arg === '--timeout-ms') parsed.timeoutMs = positiveInteger(requiredValue(argv, ++i, arg), arg)
    else if (arg === '--skip-write') parsed.skipWrite = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return parsed
}

function requiredValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function positiveInteger(value, flag) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`)
  return parsed
}

function printHelp() {
  console.log(`UseChat 微信 ABC smoke

用法：
  node scripts/wechat-abc-smoke.mjs [--chat ABC] [--skip-write]

说明：
  - 自动创建临时配置并设置 model.provider=ocr-only。
  - 执行 doctor、read、write、read-after-write。
  - 只输出结构化摘要，不输出完整聊天内容。
`)
}
