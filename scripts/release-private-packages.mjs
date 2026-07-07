#!/usr/bin/env node
// Backward-compatible alias. Use `pnpm release:npm:pack` for the public npm package release flow.
import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['scripts/release-npm-packages.mjs'], { stdio: 'inherit' })
process.exit(result.status ?? 1)
