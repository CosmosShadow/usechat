#!/usr/bin/env node
// @arch docs/architecture/local-runtime.md

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
run('node', [path.join(root, 'scripts', 'validate-runtime-assets.mjs')])
run('node', [path.join(root, 'scripts', 'build-macos-helper-app.mjs')])
run('node', [path.join(root, 'scripts', 'build-windows-helper-runtime.mjs')])

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
