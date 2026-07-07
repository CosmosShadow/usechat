#!/usr/bin/env node
// @arch ../../docs/HELPER_RUNTIME.md
// @arch ../../docs/COPY_OUT_SOURCES.md
// @test node helper-runtime/scripts/native-helper/build-macos-helper.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const helperRuntimeRoot = path.resolve(scriptDir, '../..')
const repoRoot = path.resolve(helperRuntimeRoot, '..')
const nativeRoot = path.join(repoRoot, 'native')
const sourcePath = process.env.WECHAT_CHANNEL_HELPER_SOURCE
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_SOURCE)
  : path.join(nativeRoot, 'macos', 'UseChatWeChatChannelHelper.swift')
const outputDir = process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR)
  : path.join(helperRuntimeRoot, 'wechat-channel', 'macos')
const executableName = process.env.WECHAT_CHANNEL_HELPER_EXECUTABLE || 'usechat-wechat-channel-helper'
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
const manifestPath = path.join(outputDir, 'manifest.json')
const packageManifestPath = path.join(outputDir, 'helper-runtime-package.json')
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
  fs.writeFileSync(manifestPath, `${JSON.stringify({
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
    run(process.execPath, [path.join(scriptDir, 'sign-macos-helper.mjs')], {
      env: {
        ...process.env,
        WECHAT_CHANNEL_HELPER_OUTPUT_DIR: outputDir,
      },
    })
    finalSha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')
  }
  updateRuntimePackageManifest({
    packageManifestPath,
    manifestPath,
    outputPath,
    platform: 'darwin',
    helperVersion,
    protocolVersion,
  })
  console.log(JSON.stringify({ ok: true, outputPath, sha256: finalSha256, architectures, signed: shouldSign }))
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

function updateRuntimePackageManifest(input) {
  if (!fs.existsSync(input.packageManifestPath)) return
  const packageManifest = JSON.parse(fs.readFileSync(input.packageManifestPath, 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(input.manifestPath, 'utf8'))
  const asset = manifest.platforms?.[input.platform] || {}
  const manifestSha256 = sha256File(input.manifestPath)
  const entrypointSha256 = sha256File(input.outputPath)
  const updated = {
    ...packageManifest,
    helperVersion: input.helperVersion,
    protocolVersion: input.protocolVersion,
    sha256: {
      ...packageManifest.sha256,
      runtimeManifest: manifestSha256,
      entrypoint: entrypointSha256,
    },
    payload: {
      ...packageManifest.payload,
      manifestSha256,
    },
    signature: {
      ...packageManifest.signature,
      signed: asset.signed === true,
      notarized: asset.notarized === true,
    },
  }
  fs.writeFileSync(input.packageManifestPath, `${JSON.stringify(updated, null, 2)}\n`)
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
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
