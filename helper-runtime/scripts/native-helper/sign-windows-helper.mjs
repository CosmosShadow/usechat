#!/usr/bin/env node
// @arch ../../docs/HELPER_RUNTIME.md
// @arch ../../docs/COPY_OUT_SOURCES.md
//
// Sign a locally-built Windows helper .exe with the Shennian Windows code-signing
// license via the `evsign-client` cloud signer, then update the helper manifest
// (sha256 + signed=true) in place. Windows Smart App Control / Device Guard
// rejects unsigned self-built binaries; without this step a locally rebuilt
// helper cannot run on end-user machines.
//
// Requirements:
//   - `evsign-client` in PATH (macOS installer: cn.evsign.clientcli pkg,
//     installs to /usr/local/bin/evsign-client)
//   - EVSIGN_LICENSE loaded into env (typically from .env.local via
//     `node --env-file=.env.local scripts/sign-windows-helper.mjs ...`)
//
// Usage:
//   node --env-file=.env.local helper-runtime/scripts/native-helper/sign-windows-helper.mjs \
//     --exe <path/to/helper.exe> [--manifest <path/to/manifest.json>]
//
// If --manifest is omitted, the script looks for manifest.json alongside the exe.
// The signed exe overwrites the input path (evsign-client signs in place).
// Never logs the license key. Signing takes ~3s per file (cloud RSA + RFC3161 timestamp).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    exe: { type: 'string' },
    manifest: { type: 'string' },
  },
})

const exePath = values.exe && path.resolve(values.exe)
if (!exePath) fail('missing required --exe <path/to/helper.exe>')
if (!fs.existsSync(exePath)) fail(`exe not found: ${exePath}`)

const manifestPath = values.manifest
  ? path.resolve(values.manifest)
  : path.join(path.dirname(exePath), 'manifest.json')

const licenseKey = process.env.EVSIGN_LICENSE
if (!licenseKey) fail('EVSIGN_LICENSE not set; load .env.local via `node --env-file=.env.local ...`')

const evsign = spawnSync('evsign-client', [exePath, '-key', licenseKey], { encoding: 'utf8' })
const redact = (s) => (s || '').split(licenseKey).join('[EVSIGN_LICENSE_REDACTED]')
if (evsign.stdout) process.stdout.write(redact(evsign.stdout))
if (evsign.stderr) process.stderr.write(redact(evsign.stderr))
if (evsign.status !== 0) fail(`evsign-client exited ${evsign.status}`)

const signedSha256 = crypto.createHash('sha256').update(fs.readFileSync(exePath)).digest('hex')

let manifestUpdate = null
if (fs.existsSync(manifestPath)) {
  const original = fs.readFileSync(manifestPath, 'utf8')
  const parsed = JSON.parse(original)
  if (parsed.platforms?.win32) {
    parsed.platforms.win32.sha256 = signedSha256
    parsed.platforms.win32.signed = true
  }
  const updated = `${JSON.stringify(parsed, null, 2)}\n`
  fs.writeFileSync(manifestPath, updated)
  manifestUpdate = { path: manifestPath, sha256: signedSha256 }
}

console.log(JSON.stringify({ ok: true, exePath, signedSha256, manifestUpdate }, null, 2))

function fail(message) {
  console.error(`sign-windows-helper: ${message}`)
  process.exit(1)
}
