#!/usr/bin/env node
// @arch ../../docs/HELPER_RUNTIME.md
// @arch ../../docs/COPY_OUT_SOURCES.md
// @test node helper-runtime/scripts/native-helper/build-windows-helper.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const helperRuntimeRoot = path.resolve(scriptDir, '../..')
const repoRoot = path.resolve(helperRuntimeRoot, '..')
const nativeRoot = path.join(repoRoot, 'native')
const projectPath = process.env.WECHAT_CHANNEL_HELPER_PROJECT
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_PROJECT)
  : path.join(nativeRoot, 'windows', 'Shennian.WeChatChannel.Helper.Win.csproj')
const outputDir = process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_OUTPUT_DIR)
  : path.join(helperRuntimeRoot, 'wechat-channel', 'windows')
const modelSourceDir = process.env.WECHAT_CHANNEL_HELPER_MODEL_SOURCE_DIR
  ? path.resolve(process.env.WECHAT_CHANNEL_HELPER_MODEL_SOURCE_DIR)
  : path.join(helperRuntimeRoot, 'wechat-channel', 'windows', 'models', 'v5')
const executableName = process.env.WECHAT_CHANNEL_HELPER_EXECUTABLE || 'shennian-wechat-channel-helper.exe'
const helperVersion = process.env.WECHAT_CHANNEL_HELPER_VERSION || '0.1.26'
const protocolVersion = Number(process.env.WECHAT_CHANNEL_HELPER_PROTOCOL_VERSION || '1')
const runtime = process.env.WECHAT_CHANNEL_HELPER_RUNTIME || 'win-x64'
const selfContained = process.env.WECHAT_CHANNEL_HELPER_SELF_CONTAINED !== '0'

if (process.platform !== 'win32' && process.env.WECHAT_CHANNEL_HELPER_ALLOW_CROSS_BUILD !== '1') {
  fail('Windows WeChat channel helper must be built on Windows. Set WECHAT_CHANNEL_HELPER_ALLOW_CROSS_BUILD=1 only for CI images with a Windows SDK toolchain.')
}
if (!fs.existsSync(projectPath)) fail(`missing helper project: ${projectPath}`)

removeAppleDoubleFiles(path.dirname(projectPath))
fs.mkdirSync(outputDir, { recursive: true })
const manifestPath = path.join(outputDir, 'manifest.json')
const packageManifestPath = path.join(outputDir, 'helper-runtime-package.json')

const publishArgs = [
  'publish',
  projectPath,
  '-c',
  'Release',
  '-r',
  runtime,
  '--self-contained',
  selfContained ? 'true' : 'false',
  '/p:PublishSingleFile=true',
  '/p:EnableCompressionInSingleFile=true',
  `/p:PublishDir=${outputDir}${path.sep}`,
]

run('dotnet', publishArgs)
copyPackagedModels(modelSourceDir, path.join(outputDir, 'models', 'v5'))
removePublishOnlyArtifacts(outputDir)

const outputPath = path.join(outputDir, executableName)
if (!fs.existsSync(outputPath)) fail(`expected helper was not published: ${outputPath}`)

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(outputPath)).digest('hex')
fs.writeFileSync(manifestPath, `${JSON.stringify({
  schemaVersion: 1,
  helperVersion,
  protocolVersion,
  platforms: {
    win32: {
      executable: executableName,
      sha256,
      signed: false,
      notarized: false,
      target: runtime,
      selfContained,
    },
  },
}, null, 2)}\n`)
updateRuntimePackageManifest({
  packageManifestPath,
  manifestPath,
  outputPath,
  platform: 'win32',
  helperVersion,
  protocolVersion,
})

console.log(JSON.stringify({ ok: true, outputPath, sha256, runtime, selfContained }))

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
      target: asset.target,
      selfContained: asset.selfContained,
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

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit' })
  if (result.error) fail(result.error.message)
  if (result.status !== 0) fail(`${command} exited ${result.status}`)
}

function removeAppleDoubleFiles(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      removeAppleDoubleFiles(fullPath)
      continue
    }
    if (entry.name.startsWith('._')) fs.rmSync(fullPath, { force: true })
  }
}

function removePublishOnlyArtifacts(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      removePublishOnlyArtifacts(fullPath)
      continue
    }
    if (entry.name.endsWith('.pdb') || entry.name.endsWith('.lib')) fs.rmSync(fullPath, { force: true })
  }
}

function copyPackagedModels(from, to) {
  if (!fs.existsSync(from)) return
  if (path.resolve(from) === path.resolve(to)) return
  copyDir(from, to)
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) {
      copyDir(src, dest)
      continue
    }
    fs.copyFileSync(src, dest)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
