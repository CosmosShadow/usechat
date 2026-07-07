#!/usr/bin/env node
// @arch ../docs/HELPER_RUNTIME.md
// @arch ../docs/COPY_OUT_SOURCES.md

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
run('node', [path.join(root, 'scripts', 'native-helper', 'build-macos-helper.mjs')])
if (process.platform === 'win32' || process.env.WECHAT_CHANNEL_HELPER_ALLOW_CROSS_BUILD === '1') {
  run('node', [path.join(root, 'scripts', 'native-helper', 'build-windows-helper.mjs')])
} else {
  console.warn('Skipping Windows native helper build on non-Windows host. Run pnpm helper-runtime:build:native:win on Windows before a full Windows release.')
}
const hasWindowsHelper = fsExists(path.join(root, 'wechat-channel', 'windows', 'shennian-wechat-channel-helper.exe'))
run('node', [path.join(root, 'scripts', 'validate-runtime-assets.mjs')], {
  env: {
    ...process.env,
    USECHAT_HELPER_VALIDATE_PLATFORMS: hasWindowsHelper ? 'darwin,win32' : 'darwin',
  },
})
run('node', [path.join(root, 'scripts', 'build-macos-helper-app.mjs')])
if (hasWindowsHelper) {
  run('node', [path.join(root, 'scripts', 'build-windows-helper-runtime.mjs')])
} else {
  console.warn('Skipping Windows helper runtime packaging because the Windows helper executable is missing.')
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: options.env })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function fsExists(filePath) {
  return fs.existsSync(filePath)
}
