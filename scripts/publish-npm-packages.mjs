#!/usr/bin/env node
// @arch ../docs/RELEASE.md
// @test node --check scripts/publish-npm-packages.mjs

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.env.USECHAT_RELEASE_OUT_DIR || path.join(repoRoot, 'dist', 'release', 'packages'))
const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const publish = args.has('--publish')
if (dryRun === publish) fail('必须且只能指定 --dry-run 或 --publish')

const packageOrder = [
  '@shennian/usechat-core',
  '@shennian/usechat-model-provider',
  '@shennian/usechat-sdk',
  '@shennian/usechat',
]

const provenancePath = path.join(outDir, 'package-provenance.json')
if (!fs.existsSync(provenancePath)) {
  run('node', ['scripts/release-npm-packages.mjs'], { cwd: repoRoot })
}
const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'))
const packages = new Map((provenance.packages || []).map((pkg) => [pkg.name, pkg]))
const results = []
for (const name of packageOrder) {
  const pkg = packages.get(name)
  if (!pkg) fail(`package missing from provenance: ${name}`)
  const tarball = path.resolve(repoRoot, pkg.tarball)
  if (!fs.existsSync(tarball)) fail(`tarball missing: ${tarball}`)
  const publishArgs = ['publish', tarball, '--access', 'public']
  if (dryRun) publishArgs.push('--dry-run')
  run('npm', publishArgs, { cwd: repoRoot })
  results.push({ name, version: pkg.version, tarball: pkg.tarball, dryRun })
}
console.log(JSON.stringify({ ok: true, dryRun, published: publish, results }, null, 2))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: process.platform === 'win32',
  })
  if (result.error) fail(`${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`)
}

function fail(message) {
  console.error(`publish-npm-packages: ${message}`)
  process.exit(1)
}
