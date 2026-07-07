#!/usr/bin/env node
// @arch ../docs/HELPER_RUNTIME.md
// @arch ../docs/COPY_OUT_SOURCES.md
// @test node helper-runtime/scripts/build-windows-helper-runtime.mjs

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'wechat-channel', 'windows')
const outputRoot = path.resolve(process.env.USECHAT_HELPER_WINDOWS_OUTPUT || process.env.SHENNIAN_HELPER_WINDOWS_OUTPUT || path.join(root, 'dist', 'windows'))
const runtimeDir = path.join(outputRoot, 'Shennian Helper')
const resourcesDir = path.join(runtimeDir, 'resources', 'wechat-channel', 'windows')
const manifestPath = path.join(sourceDir, 'manifest.json')
if (!fs.existsSync(manifestPath)) fail(`missing Windows helper manifest: ${manifestPath}`)
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
if (!manifest.platforms?.win32?.executable) fail('Windows helper manifest missing platforms.win32.executable')
const packageManifestPath = path.join(sourceDir, 'helper-runtime-package.json')
if (!fs.existsSync(packageManifestPath)) fail(`missing Windows helper runtime package manifest: ${packageManifestPath}`)
const packageManifest = JSON.parse(fs.readFileSync(packageManifestPath, 'utf8'))
const sourceAsset = manifest.platforms.win32

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.mkdirSync(resourcesDir, { recursive: true })
fs.cpSync(sourceDir, resourcesDir, { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'resources', 'shennian-helper-runtime.json'), `${JSON.stringify({
  schemaVersion: 1,
  runtimeKind: 'windows-helper-runtime',
  installScope: 'user',
  helperVersion: manifest.helperVersion,
  protocolVersion: manifest.protocolVersion,
  wechatChannelManifest: 'wechat-channel/windows/manifest.json',
}, null, 2)}\n`)
fs.writeFileSync(path.join(outputRoot, 'install-helper-runtime.ps1'), renderInstallerPowerShell())

const signWithSigntool = process.env.USECHAT_HELPER_WINDOWS_SIGN === '1' || process.env.SHENNIAN_HELPER_WINDOWS_SIGN === '1'
// External signing (evsign cloud signer) runs out-of-band before packaging, so the
// exe already carries an Authenticode blob. We verify it portably here instead of
// invoking Windows-only signtool.
const externalSigned = process.env.USECHAT_HELPER_WINDOWS_EXTERNAL_SIGNED === '1' || process.env.SHENNIAN_HELPER_WINDOWS_EXTERNAL_SIGNED === '1'

if (signWithSigntool) {
  const signtool = process.env.SIGNTOOL || 'signtool.exe'
  const exe = path.join(resourcesDir, manifest.platforms.win32.executable)
  const signArgsText = process.env.USECHAT_HELPER_WINDOWS_SIGN_ARGS || process.env.SHENNIAN_HELPER_WINDOWS_SIGN_ARGS
  const args = signArgsText
    ? signArgsText.split(/\s+/).filter(Boolean)
    : ['sign', '/fd', 'SHA256', '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256']
  run(signtool, [...args, exe])
}

const executablePath = path.join(resourcesDir, sourceAsset.executable)
const externalAuthenticode = externalSigned ? verifyPeAuthenticode(executablePath) : null
if (externalSigned && !externalAuthenticode.ok) {
  fail(`external Authenticode verification failed for ${executablePath}: ${externalAuthenticode.reasonCode}`)
}
const signed = signWithSigntool || externalSigned
const executableSha256 = sha256File(executablePath)
const outputManifest = {
  ...manifest,
  platforms: {
    ...manifest.platforms,
    win32: {
      ...sourceAsset,
      sha256: executableSha256,
      signed,
    },
  },
}
const outputManifestPath = path.join(resourcesDir, 'manifest.json')
writeJson(outputManifestPath, outputManifest)
const manifestSha256 = sha256File(outputManifestPath)
const signtoolVerify = signWithSigntool
  ? verifyCommand(process.env.SIGNTOOL || 'signtool.exe', ['verify', '/pa', '/v', executablePath])
  : {
      ok: false,
      skipped: true,
      reasonCode: 'windows_authenticode_signing_not_requested',
      command: 'signtool.exe',
      args: ['verify', '/pa', '/v', executablePath],
    }
if (signWithSigntool && !signtoolVerify.ok) {
  fail(`signtool verification failed for ${executablePath}: ${signtoolVerify.stderr || signtoolVerify.stdout || signtoolVerify.status}`)
}
const outputPackageManifest = {
  ...packageManifest,
  helperVersion: manifest.helperVersion,
  protocolVersion: manifest.protocolVersion,
  sha256: {
    runtimeManifest: manifestSha256,
    entrypoint: executableSha256,
  },
  payload: {
    ...packageManifest.payload,
    manifestSha256,
  },
  signature: {
    ...packageManifest.signature,
    signed,
    authenticode: {
      requested: signWithSigntool,
      signtoolVerify,
      ...(externalSigned ? { external: externalAuthenticode } : {}),
    },
  },
}
const outputPackageManifestPath = path.join(outputRoot, 'helper-runtime-package.json')
const embeddedPackageManifestPath = path.join(runtimeDir, 'resources', 'helper-runtime-package.json')
const helperDirPackageManifestPath = path.join(resourcesDir, 'helper-runtime-package.json')
const evidencePath = path.join(outputRoot, 'helper-runtime-evidence.json')
writeJson(outputPackageManifestPath, outputPackageManifest)
writeJson(embeddedPackageManifestPath, outputPackageManifest)
writeJson(helperDirPackageManifestPath, outputPackageManifest)
writeJson(evidencePath, {
  schemaVersion: 1,
  runtimeKind: 'windows-helper-runtime',
  runtimeDir,
  helperVersion: manifest.helperVersion,
  protocolVersion: manifest.protocolVersion,
  manifestPath: outputManifestPath,
  manifestSha256,
  executablePath,
  executableSha256,
  packageManifestPath: outputPackageManifestPath,
  signing: outputPackageManifest.signature,
})
const distributionZipPath = tryCreateZip(outputRoot, runtimeDir)
console.log(JSON.stringify({
  ok: true,
  outputRoot,
  runtimeDir,
  helperVersion: manifest.helperVersion,
  protocolVersion: manifest.protocolVersion,
  sha256: executableSha256,
  manifestSha256,
  packageManifestPath: outputPackageManifestPath,
  evidencePath,
  distributionZipPath,
}))

function renderInstallerPowerShell() {
  return `$ErrorActionPreference = "Stop"\n$Source = Join-Path $PSScriptRoot "Shennian Helper"\n$DefaultTarget = Join-Path $env:LOCALAPPDATA "Programs\\Shennian Helper"\n$Target = if ($env:USECHAT_HELPER_INSTALL_DIR) { $env:USECHAT_HELPER_INSTALL_DIR } elseif ($env:SHENNIAN_HELPER_INSTALL_DIR) { $env:SHENNIAN_HELPER_INSTALL_DIR } else { $DefaultTarget }\nif (!(Test-Path $Source)) { throw "Missing runtime payload: $Source" }\nStop-Process -Name "shennian-wechat-channel-helper" -Force -ErrorAction SilentlyContinue\n$Temp = "$Target.tmp.$PID"\nif (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force }\nNew-Item -ItemType Directory -Force -Path (Split-Path $Temp) | Out-Null\nCopy-Item $Source $Temp -Recurse -Force\nif (Test-Path $Target) { Remove-Item $Target -Recurse -Force }\nMove-Item $Temp $Target\n$Manifest = Join-Path $Target "resources\\wechat-channel\\windows\\manifest.json"\nif (!(Test-Path $Manifest)) { throw "Install failed: manifest missing at $Manifest" }\nWrite-Output "Installed Shennian Helper Runtime to $Target"\n`
}

function tryCreateZip(outputRoot, runtimeDir) {
  const zipPath = path.join(outputRoot, 'Shennian-Helper-Runtime-windows.zip')
  const result = spawnSync('zip', ['-qr', zipPath, path.basename(runtimeDir), 'install-helper-runtime.ps1', 'helper-runtime-package.json', 'helper-runtime-evidence.json'], {
    cwd: outputRoot,
    stdio: 'ignore',
  })
  if (result.status === 0) return zipPath
  if (process.platform === 'win32') {
    fs.rmSync(zipPath, { force: true })
    const ps = spawnSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        '$ErrorActionPreference = "Stop"',
        `$files = @(${[
          path.basename(runtimeDir),
          'install-helper-runtime.ps1',
          'helper-runtime-package.json',
          'helper-runtime-evidence.json',
        ].map((value) => JSON.stringify(value)).join(', ')})`,
        `Compress-Archive -Path $files -DestinationPath ${JSON.stringify(zipPath)} -Force`,
      ].join('; '),
    ], {
      cwd: outputRoot,
      stdio: 'ignore',
    })
    if (ps.status === 0) return zipPath
  }
  return null
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

// Portable Authenticode presence check: parse the PE header and confirm the
// IMAGE_DIRECTORY_ENTRY_SECURITY (index 4) entry points at a non-empty blob.
// Does not validate the certificate chain (that requires Windows), only that
// the exe was signed out-of-band before packaging.
function verifyPeAuthenticode(filePath) {
  try {
    const buf = fs.readFileSync(filePath)
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
      return { ok: false, reasonCode: 'not_a_pe_image' }
    }
    const peOffset = buf.readUInt32LE(0x3c)
    if (buf.readUInt32LE(peOffset) !== 0x00004550) {
      return { ok: false, reasonCode: 'invalid_pe_signature' }
    }
    const optionalHeaderOffset = peOffset + 24
    const magic = buf.readUInt16LE(optionalHeaderOffset)
    const dataDirOffset = optionalHeaderOffset + (magic === 0x20b ? 112 : 96)
    const securityEntryOffset = dataDirOffset + 4 * 8
    const certVirtualAddress = buf.readUInt32LE(securityEntryOffset)
    const certSize = buf.readUInt32LE(securityEntryOffset + 4)
    if (certSize > 0 && certVirtualAddress > 0) {
      return {
        ok: true,
        method: 'pe-security-directory',
        certOffset: certVirtualAddress,
        certSize,
      }
    }
    return { ok: false, reasonCode: 'authenticode_directory_absent' }
  } catch (error) {
    return { ok: false, reasonCode: 'pe_parse_error', message: String(error?.message || error) }
  }
}

function verifyCommand(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    command,
    args,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
