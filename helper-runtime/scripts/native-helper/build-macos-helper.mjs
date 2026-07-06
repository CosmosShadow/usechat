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
const repoRoot = path.resolve(cliRoot, '../..')
const sourcePath = path.join(nativeRoot, 'macos', 'ShennianWeChatChannelHelper.swift')
const outputDir = process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR)
  : path.join(repoRoot, 'packages', 'helper-runtime', 'wechat-channel', 'macos')
const executableName = process.env.WECHAT_CHANNEL_HELPER_EXECUTABLE || 'shennian-wechat-channel-helper'
const outputPath = path.join(outputDir, executableName)
const macosTarget = process.env.WECHAT_CHANNEL_HELPER_MACOS_TARGET || '13.0'
const helperVersion = process.env.WECHAT_CHANNEL_HELPER_VERSION || '0.1.12'
const protocolVersion = Number(process.env.WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION || '1')
const shouldSign = process.env.WECHAT_CHANNEL_HELPER_SIGN === '1'
const architectures = (process.env.WECHAT_CHANNEL_HELPER_ARCHS || 'arm64,x86_64')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

if (!fs.existsSync(sourcePath)) fail(`missing helper source: ${sourcePath}`)
if (architectures.length === 0) fail('WECHAT_CHANNEL_HELPER_ARCHS cannot be empty')

fs.mkdirSync(outputDir, { recursive: true })
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shennian-wechat-helper-'))
try {
  const binaries = architectures.map((arch) => buildArch(arch, tmpDir))
  if (binaries.length === 1) {
    fs.copyFileSync(binaries[0], outputPath)
  } else {
    run('lipo', ['-create', ...binaries, '-output', outputPath])
  }
  fs.chmodSync(outputPath, 0o755)
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')
  fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    helperVersion,
    protocolVersion,
    platforms: {
      darwin: {
        executable: executableName,
        sha256,
        signed: false,
        notarized: false,
      },
    },
  }, null, 2)}\n`)
  let finalSha256 = sha256
  if (shouldSign) {
    run(process.execPath, [path.join(nativeRoot, 'scripts', 'sign-macos-helper.mjs')], {
      env: {
        ...process.env,
        WECHAT_CHANNEL_HELPER_OUTPUT_DIR: outputDir,
      },
    })
    finalSha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')
  }
  console.log(JSON.stringify({ ok: true, outputPath, sha256: finalSha256, architectures, signed: shouldSign }))
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function buildArch(arch, tmpDir) {
  if (!['arm64', 'x86_64'].includes(arch)) fail(`unsupported architecture: ${arch}`)
  const target = `${arch}-apple-macosx${macosTarget}`
  const output = path.join(tmpDir, `${executableName}-${arch}`)
  run('swiftc', [
    '-target', target,
    '-O',
    '-whole-module-optimization',
    sourcePath,
    '-o', output,
  ])
  return output
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: options.env })
  if (result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    fail(`${command} exited ${result.status}`)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
