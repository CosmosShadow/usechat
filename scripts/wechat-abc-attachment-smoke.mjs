#!/usr/bin/env node
// @arch ../docs/ARCHITECTURE.md
// @arch ../docs/COPY_OUT_SOURCES.md
// @test node --check scripts/wechat-abc-attachment-smoke.mjs
//
// This is a thin smoke wrapper. It does not implement WeChat sending logic.
// It only calls `usechat write --file/--image/--video`, whose sender path is
// copied out from Shennian `wechat-channel/outbound-sender.ts`.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
// Tiny MP4 fallback generated once with ffmpeg:
// ffmpeg -f lavfi -i color=c=black:s=16x16:d=0.25 -pix_fmt yuv420p -movflags +faststart tiny.mp4
// It is used only as a smoke-test local file fixture when ffmpeg is unavailable.
const TINY_MP4_BASE64 = [
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOMbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAARgAAQAAAQAA',
  'AAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAA',
  'Ard0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAARgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAA',
  'AAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAEYAAAEAAABAAAAAAIvbWRpYQAAACBtZGhk',
  'AAAAAAAAAAAAAAAAAAAyAAAADgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAAB2m1p',
  'bmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAZpzdGJsAAAAvnN0c2QA',
  'AAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGli',
  'eDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBw',
  'YXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAFfVAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAHAAACAAAAABRzdHNzAAAAAAAAAAEAAAAB',
  'AAAASGN0dHMAAAAAAAAABwAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAGAAAAAAEAAAIAAAAA',
  'HHN0c2MAAAAAAAAAAQAAAAEAAAAHAAAAAQAAADBzdHN6AAAAAAAAAAAAAAAHAAACxQAAAAwAAAAMAAAADAAAAAwAAAASAAAADAAA',
  'ABRzdGNvAAAAAAAAAAEAAAO8AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAs',
  'aWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMAAAAAhmcmVlAAADG21kYXQAAAKuBgX//6rcRem95tlIt5Ys',
  '2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAw',
  'My0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2Nr',
  'PTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEg',
  'bWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9',
  'MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBk',
  'ZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJh',
  'bWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUw',
  'IGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEg',
  'Y3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAP',
  'ZYiEADf//vbw/gU2VgTBAAAACEGaJGxDP/7gAAAACEGeQniF/8GBAAAACAGeYXRCv8SAAAAACAGeY2pCv8SBAAAADkGaZkmoQWiZ',
  'TBTwr/7BAAAACAGehWpCv8SB',
].join('')

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}

const cliPath = path.resolve(repoRoot, options.cli ?? 'packages/cli/dist/index.js')
const tmpDir = options.config
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-attachment-smoke-work-'))
  : fs.mkdtempSync(path.join(os.tmpdir(), 'usechat-attachment-smoke-'))
const configPath = options.config ? path.resolve(options.config) : path.join(tmpDir, 'config.json')
const fixturesDir = path.join(tmpDir, 'fixtures')
fs.mkdirSync(fixturesDir, { recursive: true })

const summary = {
  ok: false,
  chat: options.chat,
  tmpDir,
  configPath,
  cliPath,
  marker: options.marker,
  fixtures: {},
  steps: [],
}

if (!fs.existsSync(cliPath)) {
  finish({
    ...summary,
    blockerReasonCode: 'cli_not_built',
    message: `CLI 不存在：${cliPath}；请先运行 pnpm build。`,
  })
}

const fixtures = createFixtures(fixturesDir, options)
summary.fixtures = Object.fromEntries(Object.entries(fixtures).map(([key, value]) => [key, summarizeFile(value)]))

runStep('init', ['--json', 'init'], { parseJson: true })
runStep('config-provider', ['config', 'set', 'model.provider', options.provider], { parseJson: false })
let doctor = runStep('doctor', ['--json', 'doctor'], { parseJson: true, timeoutMs: options.timeoutMs })
if (isRetryableDoctorWindowFailure(doctor)) {
  sleepSync(1200)
  doctor = runStep('doctor-retry', ['--json', 'doctor'], { parseJson: true, timeoutMs: options.timeoutMs })
}

const sendSteps = []
if (options.text) {
  sendSteps.push(runWriteStep('write-text', ['--text', options.marker]))
}
if (!options.skipFile) {
  sendSteps.push(runWriteStep('write-file', ['--file', fixtures.file], fixtures.file))
}
if (!options.skipImage) {
  sendSteps.push(runWriteStep('write-image', ['--image', fixtures.image], fixtures.image))
}
if (!options.skipVideo) {
  sendSteps.push(runWriteStep('write-video', ['--video', fixtures.video], fixtures.video))
}

const checks = [
  check('doctor.ok', doctor.compact?.ok === true, 'doctor must pass before attachment sends'),
  ...sendSteps.flatMap((step) => checksForWriteStep(step)),
]
const finalSummary = {
  ...summary,
  doctor: doctor.compact,
  sends: sendSteps.map((step) => step.compact),
  checks,
}
finalSummary.ok = checks.every((item) => item.ok)
finalSummary.blockerReasonCode = firstReasonCode(finalSummary)
finish(finalSummary)

function runWriteStep(id, attachmentArgs, expectedLocalPath) {
  return runStep(id, [
    '--json',
    'write',
    '--app',
    'wechat',
    '--chat',
    options.chat,
    ...attachmentArgs,
    '--yes',
  ], { parseJson: true, timeoutMs: options.timeoutMs, expectedLocalPath })
}

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
    compact: compactResult(id, parsed, result.stderr, stepOptions.expectedLocalPath),
  }
  if (result.error) step.error = result.error.message
  if (result.stderr) step.stderrPreview = result.stderr.slice(0, 600)
  if (result.status !== 0 && result.stdout) step.stdoutPreview = result.stdout.slice(0, 800)
  summary.steps.push(step)
  return step
}

function compactResult(id, parsed, stderr = '', expectedLocalPath = '') {
  const cliReasonCode = parsed?.reasonCode || extractCliReasonCode(stderr)
  if (!parsed) {
    if (!cliReasonCode) return null
    return { ok: false, reasonCode: cliReasonCode }
  }
  if (id === 'doctor' || id === 'doctor-retry') {
    return {
      ok: parsed.ok === true,
      reasonCode: cliReasonCode,
      platform: parsed.platform,
      failed: Array.isArray(parsed.checks)
        ? parsed.checks.filter((item) => !item.ok).map((item) => ({
            id: item.id,
            reasonCode: item.reasonCode,
          }))
        : [],
      helperVersion: parsed.helper?.version,
      helperPathFound: Boolean(parsed.helper?.path),
    }
  }
  if (id.startsWith('write-')) {
    const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : []
    const attachment = parsed.attachment ?? attachments[0] ?? null
    const expectedStat = expectedLocalPath && attachment ? fs.statSync(expectedLocalPath) : null
    return {
      ok: parsed.ok === true,
      reasonCode: cliReasonCode,
      sent: parsed.sent === true,
      status: parsed.status,
      traceId: parsed.traceId,
      text: parsed.text,
      attachment: attachment ? {
        kind: attachment.kind,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        localPath: attachment.localPath,
      } : null,
      attachmentCount: attachments.length,
      expectedLocalPath,
      expectedSize: expectedStat?.size ?? null,
      localPathMatches: expectedLocalPath ? path.resolve(attachment?.localPath || '') === path.resolve(expectedLocalPath) : true,
      sizeMatches: expectedStat ? Number(attachment?.size) === expectedStat.size : true,
    }
  }
  return { ok: parsed.ok === true, reasonCode: cliReasonCode }
}

function checksForWriteStep(step) {
  const compact = step.compact ?? {}
  const label = step.id
  const hasAttachment = label !== 'write-text'
  return [
    check(`${label}.exit-zero`, step.status === 0, `${label} command must exit 0`),
    check(`${label}.ok`, compact.ok === true, `${label} JSON result must be ok`),
    check(`${label}.sent`, compact.sent === true, `${label} must report sent=true`),
    check(`${label}.status`, compact.status === 'sent-unconfirmed', `${label} must be sent-unconfirmed`),
    ...(hasAttachment ? [
      check(`${label}.local-path-original`, compact.localPathMatches === true, `${label} result must reference the exact local original path`),
      check(`${label}.size-original`, compact.sizeMatches === true, `${label} result size must match the local original file`),
    ] : []),
  ]
}

function createFixtures(dir, parsed) {
  const file = parsed.file ? path.resolve(parsed.file) : path.join(dir, `usechat-file-${safeTimestamp()}.txt`)
  const image = parsed.image ? path.resolve(parsed.image) : path.join(dir, `usechat-image-${safeTimestamp()}.png`)
  const video = parsed.video ? path.resolve(parsed.video) : path.join(dir, `usechat-video-${safeTimestamp()}.mp4`)
  if (!parsed.file) fs.writeFileSync(file, `${parsed.marker}\nUseChat attachment smoke file fixture.\n`, 'utf8')
  if (!parsed.image) fs.writeFileSync(image, Buffer.from(PNG_1X1_BASE64, 'base64'))
  if (!parsed.video) createTinyMp4(video)
  for (const fixture of [file, image, video]) {
    if (!fs.existsSync(fixture)) throw new Error(`fixture_missing:${fixture}`)
    const stat = fs.statSync(fixture)
    if (!stat.isFile() || stat.size <= 0) throw new Error(`fixture_invalid:${fixture}`)
  }
  return { file, image, video }
}

function createTinyMp4(filePath) {
  const ffmpeg = commandPath('ffmpeg')
  if (!ffmpeg) {
    fs.writeFileSync(filePath, Buffer.from(TINY_MP4_BASE64, 'base64'))
    return
  }
  const result = spawnSync(ffmpeg, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=16x16:d=0.25',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    filePath,
  ], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`ffmpeg_failed:${String(result.stderr || result.stdout || '').slice(0, 400)}`)
  }
}

function commandPath(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [command] : ['-lc', `command -v ${shellQuote(command)}`], {
    encoding: 'utf8',
    shell: false,
  })
  if (result.status !== 0) return ''
  return String(result.stdout || '').trim().split(/\r?\n/)[0] || ''
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`
}

function summarizeFile(filePath) {
  const stat = fs.statSync(filePath)
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
  }
}

function check(id, ok, message) {
  return { id, ok: Boolean(ok), message }
}

function firstReasonCode(value) {
  const failedDoctor = value.doctor?.failed?.[0]
  if (failedDoctor?.reasonCode) return failedDoctor.reasonCode
  for (const send of value.sends ?? []) {
    if (send?.reasonCode) return send.reasonCode
  }
  const failedCheck = value.checks?.find((item) => !item.ok)
  return failedCheck?.id
}

function isRetryableDoctorWindowFailure(step) {
  if (step.compact?.ok === true) return false
  const failed = Array.isArray(step.compact?.failed) ? step.compact.failed : []
  return failed.some((item) => item?.reasonCode === 'wechat_window_not_found' || item?.reasonCode === 'wechat_window_unavailable')
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
    'permission_missing',
    'wechat_message_input_point_required',
    'wechat_submit_failed',
  ].find((reasonCode) => text.includes(reasonCode))
  if (knownReasonCode) return knownReasonCode
  const match = /UseChat\s+\S+[:：]\s*([a-z0-9_.-]+)/i.exec(text)
    ?? /([a-z0-9_.-]+)(?::|\s*$)/i.exec(text)
  return match?.[1]
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
    timeoutMs: 240_000,
    marker: `UseChat attachment smoke ${safeTimestamp()}`,
    text: true,
    skipFile: false,
    skipImage: false,
    skipVideo: false,
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
    else if (arg === '--file') parsed.file = requiredValue(argv, ++i, arg)
    else if (arg === '--image') parsed.image = requiredValue(argv, ++i, arg)
    else if (arg === '--video') parsed.video = requiredValue(argv, ++i, arg)
    else if (arg === '--timeout-ms') parsed.timeoutMs = positiveInteger(requiredValue(argv, ++i, arg), arg)
    else if (arg === '--skip-text') parsed.text = false
    else if (arg === '--skip-file') parsed.skipFile = true
    else if (arg === '--skip-image') parsed.skipImage = true
    else if (arg === '--skip-video') parsed.skipVideo = true
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

function safeTimestamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function printHelp() {
  console.log(`UseChat 微信 ABC 附件 smoke

用法：
  node scripts/wechat-abc-attachment-smoke.mjs [--chat ABC]

说明：
  - 自动创建临时配置并设置 model.provider=ocr-only。
  - 依次执行 doctor、文本发送、文件发送、图片发送、视频发送。
  - 只输出结构化摘要，不输出完整聊天内容。
  - 发送能力来自 UseChat 已从 Shennian copy-out 的 outbound-sender；本脚本只做 smoke 编排。

可选：
  --file <path>   使用指定本机文件原件。
  --image <path>  使用指定本机图片原件。
  --video <path>  使用指定本机视频原件；未传时需要本机有 ffmpeg 来生成极小 mp4。
  --skip-text / --skip-file / --skip-image / --skip-video
`)
}
