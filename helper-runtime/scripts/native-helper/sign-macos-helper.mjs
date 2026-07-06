#!/usr/bin/env node
// @arch docs/features/wechat-rpa/macos-runtime.md
// @test src/__tests__/wechat-channel-native-helper.test.ts

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const nativeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliRoot = path.resolve(nativeRoot, '../..')
const helperDir = process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR)
  : path.join(cliRoot, 'assets', 'wechat-channel', 'macos')
const manifestPath = path.join(helperDir, 'manifest.json')
const identity = process.env.WECHAT_CHANNEL_HELPER_CODESIGN_IDENTITY
  || process.env.CSC_NAME
  || findDeveloperIdIdentity()
const shouldNotarize = process.env.WECHAT_CHANNEL_HELPER_NOTARIZE === '1'

if (process.platform !== 'darwin') fail('macOS helper signing must run on macOS')
if (!identity) fail('Developer ID Application signing identity was not found')
if (!fs.existsSync(manifestPath)) fail(`missing helper manifest: ${manifestPath}`)

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const darwin = manifest?.platforms?.darwin
const executable = typeof darwin?.executable === 'string' ? darwin.executable : ''
if (!executable) fail('manifest missing platforms.darwin.executable')
const helperPath = path.join(helperDir, executable)
if (!fs.existsSync(helperPath)) fail(`missing helper executable: ${helperPath}`)

run('codesign', [
  '--force',
  '--options',
  'runtime',
  '--timestamp',
  '--sign',
  identity,
  helperPath,
])
run('codesign', ['--verify', '--strict', '--verbose=2', helperPath])

const signedInfo = readCodesignInfo(helperPath)
const notarization = shouldNotarize ? notarizeExecutable(helperPath, executable) : { notarized: false }
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex')
darwin.sha256 = sha256
darwin.signed = true
darwin.notarized = notarization.notarized
darwin.signing = {
  authority: signedInfo.authority,
  teamIdentifier: signedInfo.teamIdentifier,
  hardenedRuntime: signedInfo.hardenedRuntime,
}
darwin.notarization = {
  status: notarization.notarized ? 'accepted' : 'not_submitted',
  ...(notarization.id ? { id: notarization.id } : {}),
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(JSON.stringify({
  ok: true,
  helperPath,
  sha256,
  signed: true,
  notarized: notarization.notarized,
  authority: signedInfo.authority,
  teamIdentifier: signedInfo.teamIdentifier,
}, null, 2))

function findDeveloperIdIdentity() {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.match(/"([^"]*Developer ID Application[^"]+)"/)?.[1])
    .find(Boolean) || null
}

function readCodesignInfo(filePath) {
  const result = spawnSync('codesign', ['-dv', '--verbose=4', filePath], { encoding: 'utf8' })
  const text = `${result.stdout || ''}\n${result.stderr || ''}`
  if (result.status !== 0) fail(text.trim() || 'codesign info failed')
  const authorities = [...text.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1].trim())
  return {
    authority: authorities[0] || null,
    teamIdentifier: text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null,
    hardenedRuntime: /flags=.*runtime|Runtime Version=/m.test(text),
  }
}

function notarizeExecutable(helperPath, executable) {
  const appleId = process.env.APPLE_ID
  const teamId = process.env.APPLE_TEAM_ID
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_PASSWORD
  if (!appleId || !teamId || !password) {
    fail('APPLE_ID, APPLE_TEAM_ID and APPLE_APP_SPECIFIC_PASSWORD are required when WECHAT_CHANNEL_HELPER_NOTARIZE=1')
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shennian-wechat-helper-notary-'))
  try {
    const zipPath = path.join(tmpDir, `${executable}.zip`)
    run('ditto', ['-c', '-k', '--keepParent', helperPath, zipPath])
    const submit = run('xcrun', [
      'notarytool',
      'submit',
      zipPath,
      '--apple-id',
      appleId,
      '--team-id',
      teamId,
      '--password',
      password,
      '--wait',
      '--timeout',
      process.env.WECHAT_CHANNEL_HELPER_NOTARY_TIMEOUT || '20m',
      '--output-format',
      'json',
    ], { redact: [password] })
    const parsed = JSON.parse(submit.stdout || '{}')
    if (parsed.status !== 'Accepted') fail(`notarization failed: ${parsed.status || 'unknown'} ${parsed.message || ''}`)
    return { notarized: true, id: parsed.id }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) {
    const text = `${result.stdout || ''}${result.stderr || ''}`
    const redacted = (options.redact || []).reduce((value, secret) => secret ? value.split(secret).join('[REDACTED]') : value, text)
    if (redacted) process.stderr.write(redacted)
    fail(`${command} exited ${result.status}`)
  }
  return result
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
