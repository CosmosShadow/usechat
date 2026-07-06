#!/usr/bin/env node
// @arch docs/architecture/local-runtime.md
// @test src/__tests__/helper-runtime-packaging.test.ts

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const assetsRoot = path.join(root, 'wechat-channel')
const required = [
  path.join(assetsRoot, 'macos', 'manifest.json'),
  path.join(assetsRoot, 'macos', 'helper-runtime-package.json'),
  path.join(assetsRoot, 'windows', 'manifest.json'),
  path.join(assetsRoot, 'windows', 'helper-runtime-package.json'),
]
for (const file of required) {
  if (!fs.existsSync(file)) fail(`missing helper runtime manifest: ${file}`)
}
validatePlatform('darwin', path.join(assetsRoot, 'macos'))
validatePlatform('win32', path.join(assetsRoot, 'windows'))
console.log(JSON.stringify({ ok: true, assetsRoot }))

function validatePlatform(platform, dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  const packageManifest = JSON.parse(fs.readFileSync(path.join(dir, 'helper-runtime-package.json'), 'utf8'))
  if (manifest.schemaVersion !== 1) fail(`invalid schemaVersion in ${dir}`)
  if (packageManifest.schemaVersion !== 1 || packageManifest.packageKind !== 'shennian-helper-runtime') fail(`invalid helper-runtime-package.json in ${dir}`)
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
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
