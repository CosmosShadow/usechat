#!/usr/bin/env node
// @arch ../docs/HELPER_RUNTIME.md
// @arch ../docs/COPY_OUT_SOURCES.md
// @test node helper-runtime/scripts/validate-runtime-assets.mjs

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsRoot = path.join(root, 'wechat-channel')
const requestedPlatforms = (process.env.USECHAT_HELPER_VALIDATE_PLATFORMS || 'darwin,win32')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const platformSet = new Set(requestedPlatforms)
const required = [
  ...(platformSet.has('darwin') ? [
    path.join(assetsRoot, 'macos', 'manifest.json'),
    path.join(assetsRoot, 'macos', 'helper-runtime-package.json'),
  ] : []),
  ...(platformSet.has('win32') ? [
    path.join(assetsRoot, 'windows', 'manifest.json'),
    path.join(assetsRoot, 'windows', 'helper-runtime-package.json'),
  ] : []),
]
for (const file of required) {
  if (!fs.existsSync(file)) fail(`missing helper runtime manifest: ${file}`)
}
if (platformSet.has('darwin')) validatePlatform('darwin', path.join(assetsRoot, 'macos'))
if (platformSet.has('win32')) validatePlatform('win32', path.join(assetsRoot, 'windows'))
console.log(JSON.stringify({ ok: true, assetsRoot, platforms: requestedPlatforms }))

function validatePlatform(platform, dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const packageManifest = JSON.parse(fs.readFileSync(path.join(dir, 'helper-runtime-package.json'), 'utf8'))
  if (manifest.schemaVersion !== 1) fail(`invalid schemaVersion in ${dir}`)
  if (packageManifest.schemaVersion !== 1 || packageManifest.packageKind !== 'usechat-helper-runtime') fail(`invalid helper-runtime-package.json in ${dir}`)
  if (packageManifest.platform !== platform) fail(`package manifest platform mismatch in ${dir}`)
  if (packageManifest.helperVersion !== manifest.helperVersion) fail(`package helperVersion mismatch in ${dir}`)
  if (packageManifest.protocolVersion !== manifest.protocolVersion) fail(`package protocolVersion mismatch in ${dir}`)
  if (!packageManifest.minCliVersion) fail(`package minCliVersion missing in ${dir}`)
  if (!packageManifest.sha256?.runtimeManifest) fail(`package sha256.runtimeManifest missing in ${dir}`)
  if (!('entrypoint' in packageManifest.sha256)) fail(`package sha256.entrypoint missing in ${dir}`)
  if (!packageManifest.installTarget?.defaultPath) fail(`package installTarget.defaultPath missing in ${dir}`)
  if (!packageManifest.payload?.runtimeManifest) fail(`package payload.runtimeManifest missing in ${dir}`)
  const asset = manifest.platforms?.[platform]
  if (!asset?.executable) fail(`missing ${platform} executable in ${dir}`)
  const executable = path.resolve(dir, asset.executable)
  if (!executable.startsWith(path.resolve(dir))) fail(`manifest executable must stay inside asset dir before installer packaging: ${asset.executable}`)
  if (!fs.existsSync(executable)) fail(`missing helper executable: ${executable}`)
  const manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'manifest.json'))).digest('hex')
  if (packageManifest.sha256.runtimeManifest !== manifestSha256) fail(`package sha256.runtimeManifest mismatch in ${dir}`)
  if (packageManifest.sha256.entrypoint != null && packageManifest.sha256.entrypoint !== asset.sha256) {
    fail(`package sha256.entrypoint mismatch in ${dir}`)
  }
  if (asset.sha256) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex')
    if (actual !== asset.sha256) fail(`sha256 mismatch: ${executable}`)
  }
  if (platform === 'win32') validateWindowsRuntimeAssets(dir)
}

function validateWindowsRuntimeAssets(dir) {
  const requiredFiles = [
    'onnxruntime.dll',
    'onnxruntime_providers_shared.dll',
    'libSkiaSharp.dll',
    'D3DCompiler_47_cor3.dll',
    'PresentationNative_cor3.dll',
    'PenImc_cor3.dll',
    'vcruntime140_cor3.dll',
    'wpfgfx_cor3.dll',
    path.join('models', 'v5', 'manifest.json'),
    path.join('models', 'v5', 'ch_PP-OCRv5_mobile_det.onnx'),
    path.join('models', 'v5', 'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
    path.join('models', 'v5', 'ch_PP-OCRv5_rec_mobile.onnx'),
    path.join('models', 'v5', 'ppocrv5_dict.txt'),
  ]
  for (const rel of requiredFiles) {
    const file = path.join(dir, rel)
    if (!fs.existsSync(file)) fail(`missing Windows helper runtime asset: ${file}`)
  }
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
