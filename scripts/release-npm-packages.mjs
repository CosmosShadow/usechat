#!/usr/bin/env node
// @arch ../docs/RELEASE.md
// @arch ../docs/COPY_OUT_SOURCES.md
// @test node --check scripts/release-npm-packages.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.resolve(process.env.USECHAT_RELEASE_OUT_DIR || path.join(repoRoot, 'dist', 'release', 'packages'))
export const packageDirs = [
  'packages/core',
  'packages/model-provider',
  'packages/sdk',
  'packages/cli',
]
const startedAt = new Date().toISOString()
const git = gitInfo()

fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

run('pnpm', ['build'], { cwd: repoRoot })

const packages = []
for (const relDir of packageDirs) {
  const packageDir = path.join(repoRoot, relDir)
  const packageJsonPath = path.join(packageDir, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  const before = new Set(fs.readdirSync(outDir))
  run('pnpm', ['pack', '--pack-destination', outDir], { cwd: packageDir })
  const after = fs.readdirSync(outDir).filter((name) => name.endsWith('.tgz'))
  const created = after.filter((name) => !before.has(name))
  if (created.length !== 1) fail(`expected exactly one tarball from ${relDir}, got ${created.join(', ') || '(none)'}`)
  const tarballPath = path.join(outDir, created[0])
  packages.push({
    name: packageJson.name,
    version: packageJson.version,
    access: packageJson.publishConfig?.access || 'public',
    directory: relDir,
    tarball: path.relative(repoRoot, tarballPath),
    sha256: sha256File(tarballPath),
    sizeBytes: fs.statSync(tarballPath).size,
    files: listTarballFiles(tarballPath),
  })
}

const provenance = {
  schemaVersion: 1,
  project: 'usechat',
  releaseKind: 'public-npm-packages',
  startedAt,
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cwd: repoRoot,
  git,
  packageManager: readRootPackageManager(),
  packages,
  notes: [
    'Packages are public npm artifacts published under the @shennian scope. The CLI binary remains usechat.',
    'WeChat RPA behavior is not reimplemented by this release script; package contents are built from UseChat code copied out from Shennian.',
    'Native helper runtime artifacts are built and evidenced separately under helper-runtime/dist and are installed only by explicit user action.',
  ],
}
const provenancePath = path.join(outDir, 'package-provenance.json')
writeJson(provenancePath, provenance)
console.log(JSON.stringify({ ok: true, outDir, packageCount: packages.length, provenancePath, packages }, null, 2))

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

function listTarballFiles(tarballPath) {
  const result = spawnSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
  if (result.status !== 0) return []
  return result.stdout.split(/\r?\n/).filter(Boolean)
}

function gitInfo() {
  const commit = gitOutput(['rev-parse', 'HEAD'])
  const branch = gitOutput(['branch', '--show-current'])
  const status = gitOutput(['status', '--short']) ?? ''
  return {
    commit,
    branch,
    dirty: status.length > 0,
    statusLines: status ? status.split(/\r?\n/).filter(Boolean) : [],
  }
}

function gitOutput(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function readRootPackageManager() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).packageManager || null
  } catch {
    return null
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}${os.EOL}`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
