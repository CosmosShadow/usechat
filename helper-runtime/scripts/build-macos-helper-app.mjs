#!/usr/bin/env node
// @arch ../docs/HELPER_RUNTIME.md
// @arch ../docs/COPY_OUT_SOURCES.md
// @test node helper-runtime/scripts/build-macos-helper-app.mjs

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(root, 'wechat-channel', 'macos')
const outputApp = path.resolve(process.env.USECHAT_HELPER_APP_OUTPUT || path.join(root, 'dist', 'macos', 'UseChat Helper.app'))
const outputRoot = path.dirname(outputApp)
const bundleId = process.env.USECHAT_HELPER_BUNDLE_ID || 'net.shennian.usechat.helper'
const executableName = 'UseChat Helper'
const helperVersionOverride = process.env.USECHAT_HELPER_RUNTIME_VERSION
const signingRequested = process.env.USECHAT_HELPER_APP_SIGN === '1'
const notarizationRequested = process.env.USECHAT_HELPER_APP_NOTARIZE === '1'
let cleanupBuildOutputOnFail = false
let notarizationZipPath = null

const sourceManifestPath = path.join(sourceDir, 'manifest.json')
if (!fs.existsSync(sourceManifestPath)) fail(`missing macOS helper manifest: ${sourceManifestPath}`)
const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
const sourcePackageManifestPath = path.join(sourceDir, 'helper-runtime-package.json')
if (!fs.existsSync(sourcePackageManifestPath)) fail(`missing macOS helper runtime package manifest: ${sourcePackageManifestPath}`)
const sourcePackageManifest = JSON.parse(fs.readFileSync(sourcePackageManifestPath, 'utf8'))
const sourceAsset = sourceManifest.platforms?.darwin
if (!sourceAsset?.executable) fail('macOS helper manifest missing platforms.darwin.executable')
const sourceExecutable = path.join(sourceDir, sourceAsset.executable)
if (!fs.existsSync(sourceExecutable)) fail(`missing macOS helper executable: ${sourceExecutable}`)

const contentsDir = path.join(outputApp, 'Contents')
const macosDir = path.join(contentsDir, 'MacOS')
const resourcesWechatDir = path.join(contentsDir, 'Resources', 'wechat-channel', 'macos')
fs.rmSync(outputApp, { recursive: true, force: true })
cleanupBuildOutputOnFail = true
fs.mkdirSync(macosDir, { recursive: true })
fs.mkdirSync(resourcesWechatDir, { recursive: true })

const appExecutable = path.join(macosDir, executableName)
fs.copyFileSync(sourceExecutable, appExecutable)
fs.chmodSync(appExecutable, 0o755)
const helperVersion = helperVersionOverride || sourceManifest.helperVersion
const appManifest = {
  ...sourceManifest,
  helperVersion,
  platforms: {
    ...sourceManifest.platforms,
    darwin: {
      ...sourceAsset,
      executable: '../../../MacOS/UseChat Helper',
      sha256: null,
      signed: signingRequested,
      notarized: notarizationRequested,
    },
  },
}
const manifestPath = path.join(resourcesWechatDir, 'manifest.json')
fs.writeFileSync(manifestPath, `${JSON.stringify(appManifest, null, 2)}\n`)
fs.writeFileSync(path.join(contentsDir, 'Info.plist'), renderInfoPlist({ bundleId, executableName, helperVersion }))
fs.writeFileSync(path.join(contentsDir, 'PkgInfo'), 'APPL????')
const unsignedManifestSha256 = sha256File(manifestPath)
const unsignedExecutableSha256 = sha256File(appExecutable)
const appPackageManifest = {
  ...sourcePackageManifest,
  helperVersion,
  protocolVersion: sourceManifest.protocolVersion,
  sha256: {
    runtimeManifest: unsignedManifestSha256,
    entrypoint: signingRequested || process.platform === 'darwin' ? null : unsignedExecutableSha256,
  },
  payload: {
    ...sourcePackageManifest.payload,
    bundleId,
    manifestSha256: unsignedManifestSha256,
  },
  signature: {
    ...sourcePackageManifest.signature,
    signed: signingRequested,
    notarized: notarizationRequested,
  },
}
writeJson(path.join(contentsDir, 'Resources', 'helper-runtime-package.json'), appPackageManifest)
fs.writeFileSync(path.join(contentsDir, 'Resources', 'usechat-helper-runtime.json'), `${JSON.stringify({
  schemaVersion: 1,
  runtimeKind: 'macos-helper-app',
  bundleId,
  helperVersion,
  protocolVersion: sourceManifest.protocolVersion,
  wechatChannelManifest: 'wechat-channel/macos/manifest.json',
}, null, 2)}\n`)

if (signingRequested) {
  const identity = process.env.USECHAT_HELPER_APP_SIGN_IDENTITY || process.env.CSC_NAME
  if (!identity) fail('USECHAT_HELPER_APP_SIGN=1 requires USECHAT_HELPER_APP_SIGN_IDENTITY or CSC_NAME')
  run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, outputApp])
} else if (process.platform === 'darwin') {
  run('codesign', ['--force', '--deep', '--sign', '-', outputApp])
}

if (notarizationRequested) {
  const zipPath = `${outputApp}.zip`
  notarizationZipPath = zipPath
  fs.rmSync(zipPath, { force: true })
  run('ditto', ['-c', '-k', '--keepParent', outputApp, zipPath])
  const profile = process.env.USECHAT_NOTARYTOOL_PROFILE || process.env.APPLE_NOTARYTOOL_PROFILE
  if (profile) {
    run('xcrun', ['notarytool', 'submit', zipPath, '--keychain-profile', profile, '--wait'])
  } else {
    const appleId = process.env.APPLE_ID
    const password = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_PASSWORD
    const teamId = process.env.APPLE_TEAM_ID
    if (!appleId || !password || !teamId) {
      fail('USECHAT_HELPER_APP_NOTARIZE=1 requires USECHAT_NOTARYTOOL_PROFILE or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID')
    }
    run('xcrun', ['notarytool', 'submit', zipPath, '--apple-id', appleId, '--password', password, '--team-id', teamId, '--wait'], {
      redactArgsAfter: new Set(['--apple-id', '--password', '--team-id']),
    })
  }
  run('xcrun', ['stapler', 'staple', outputApp])
}

const executableSha256 = sha256File(appExecutable)
const manifestSha256 = sha256File(manifestPath)
const codesignVerify = verifyCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', outputApp], {
  skip: process.platform !== 'darwin',
})
if (signingRequested && !codesignVerify.ok) {
  fail(`codesign verification failed for ${outputApp}: ${codesignVerify.stderr || codesignVerify.stdout || codesignVerify.status}`)
}
const gatekeeperAssess = verifyCommand('spctl', ['--assess', '--type', 'execute', '--verbose=4', outputApp], {
  skip: process.platform !== 'darwin',
})
if (notarizationRequested && !gatekeeperAssess.ok) {
  fail(`Gatekeeper assessment failed for ${outputApp}: ${gatekeeperAssess.stderr || gatekeeperAssess.stdout || gatekeeperAssess.status}`)
}
const outputPackageManifest = {
  ...appPackageManifest,
  sha256: {
    runtimeManifest: manifestSha256,
    entrypoint: executableSha256,
  },
  payload: {
    ...appPackageManifest.payload,
    manifestSha256,
  },
  signature: {
    ...appPackageManifest.signature,
    codesignVerify,
    notarization: {
      requested: notarizationRequested,
      stapled: notarizationRequested,
      zipPath: notarizationZipPath,
    },
    gatekeeperAssess,
  },
}
const packageManifestPath = path.join(outputRoot, 'helper-runtime-package.json')
const evidencePath = path.join(outputRoot, 'helper-runtime-evidence.json')
writeJson(packageManifestPath, outputPackageManifest)
writeJson(evidencePath, {
  schemaVersion: 1,
  runtimeKind: 'macos-helper-app',
  outputApp,
  bundleId,
  helperVersion,
  protocolVersion: sourceManifest.protocolVersion,
  manifestPath,
  manifestSha256,
  executablePath: appExecutable,
  executableSha256,
  packageManifestPath,
  signing: outputPackageManifest.signature,
})
const distributionZipPath = tryCreateZip(outputRoot, outputApp, packageManifestPath, evidencePath)
console.log(JSON.stringify({
  ok: true,
  outputApp,
  bundleId,
  helperVersion,
  protocolVersion: sourceManifest.protocolVersion,
  sha256: executableSha256,
  manifestSha256,
  packageManifestPath,
  evidencePath,
  distributionZipPath,
}))

function renderInfoPlist(input) {
  const escapedBundleId = escapeXml(input.bundleId)
  const escapedExecutableName = escapeXml(input.executableName)
  const escapedVersion = escapeXml(input.helperVersion)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>UseChat Helper</string>
  <key>CFBundleExecutable</key>
  <string>${escapedExecutableName}</string>
  <key>CFBundleIdentifier</key>
  <string>${escapedBundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>UseChat Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapedVersion}</string>
  <key>CFBundleVersion</key>
  <string>${escapedVersion}</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>UseChat Helper uses Apple Events only when you enable WeChat automation.</string>
  <key>NSInputMonitoringUsageDescription</key>
  <string>UseChat Helper checks whether you are using the keyboard or mouse so it can stop WeChat automation when you take over.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>UseChat Helper captures WeChat windows only when you enable WeChat automation.</string>
</dict>
</plist>
`
}

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' }[char]))
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function verifyCommand(command, args, options = {}) {
  if (options.skip) {
    return {
      ok: false,
      skipped: true,
      reasonCode: 'command_not_available_on_host',
      command,
      args,
    }
  }
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

function tryCreateZip(outputRoot, outputApp, packageManifestPath, evidencePath) {
  const zipPath = path.join(outputRoot, 'UseChat-Helper-Runtime-macos.zip')
  const entries = [
    path.basename(outputApp),
    path.basename(packageManifestPath),
    path.basename(evidencePath),
  ]
  const result = spawnSync('zip', ['-qr', zipPath, ...entries], {
    cwd: outputRoot,
    stdio: 'ignore',
  })
  return result.status === 0 ? zipPath : null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) fail(`${command} ${formatArgsForLog(args, options).join(' ')} exited ${result.status}`)
}

function fail(message) {
  if (cleanupBuildOutputOnFail && notarizationRequested) {
    fs.rmSync(outputApp, { recursive: true, force: true })
    if (notarizationZipPath) fs.rmSync(notarizationZipPath, { force: true })
  }
  console.error(message)
  process.exit(1)
}

function formatArgsForLog(args, options = {}) {
  const redactArgsAfter = options.redactArgsAfter || new Set()
  const formatted = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      formatted.push('<redacted>')
      redactNext = false
      continue
    }
    formatted.push(arg)
    if (redactArgsAfter.has(arg)) redactNext = true
  }
  return formatted
}
