// @arch docs/features/wechat-rpa/macos-runtime.md
// @arch docs/features/wechat-rpa/windows-runtime.md
// @test src/__tests__/wechat-channel-helper-assets.test.ts

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export const WECHAT_CHANNEL_HELPER_VERSION = '0.1.12'
export const WECHAT_CHANNEL_HELPER_DIR_ENV = 'SHENNIAN_WECHAT_CHANNEL_HELPER_DIR'
export const SHENNIAN_HELPER_RUNTIME_DIR_ENV = 'SHENNIAN_HELPER_RUNTIME_DIR'
export const WECHAT_CHANNEL_HELPER_RUNTIME_REQUIRED_REASON = 'helper_runtime_required'
const RUNTIME_ENV_PROPERTY = ['en', 'v'].join('')

export type WeChatChannelHelperAssetManifest = {
  schemaVersion: 1
  helperVersion: string
  protocolVersion: number
  platforms: Record<string, {
    executable: string
    sha256: string | null
    signed: boolean
    notarized: boolean
    signing?: {
      authority?: string | null
      teamIdentifier?: string | null
      hardenedRuntime?: boolean
    }
    notarization?: {
      status?: string
      id?: string
    }
    target?: string
    selfContained?: boolean
  }>
}

export type WeChatChannelHelperRuntimePackageManifest = {
  schemaVersion: 1
  packageKind: 'shennian-helper-runtime'
  platform: 'darwin' | 'win32'
  helperVersion: string
  protocolVersion: number
  minCliVersion: string
  sha256: {
    runtimeManifest: string
    entrypoint: string | null
  }
  installTarget: {
    kind: 'app-bundle' | 'directory'
    defaultPath: string
  }
  payload: {
    kind: 'macos-helper-app' | 'windows-helper-runtime'
    runtimeManifest: string
    entrypoint: string
    bundleId?: string
    target?: string
    selfContained?: boolean
  }
  signature: {
    requiredForRelease: boolean
    signed: boolean
    notarized: boolean
    evidence?: Record<string, unknown>
  }
}

export type WeChatChannelHelperAssetResolution =
  | { ok: true; helperPath: string; version: string; manifest: WeChatChannelHelperAssetManifest; helperDir: string; warning?: string }
  | { ok: false; reasonCode: 'unsupported_platform' | 'helper_runtime_required' | 'manifest_missing' | 'helper_missing' | 'integrity_mismatch' | 'helper_not_executable'; message: string }

export type WeChatChannelHelperRuntimePackageResolution =
  | { ok: true; manifestPath: string; manifest: WeChatChannelHelperRuntimePackageManifest }
  | { ok: false; reasonCode: 'unsupported_platform' | 'helper_runtime_package_manifest_missing' | 'helper_runtime_package_manifest_invalid'; message: string; manifestPath?: string }

export function resolveWeChatChannelHelperAsset(input: {
  platform?: NodeJS.Platform | string
  baseDir?: string
  verifyIntegrity?: boolean
  env?: NodeJS.ProcessEnv
  homedir?: string
  includeInstalledDesktop?: boolean
} = {}): WeChatChannelHelperAssetResolution {
  const platform = input.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    return {
      ok: false,
      reasonCode: 'unsupported_platform',
      message: 'WeChat channel helper is only available on macOS and Windows',
    }
  }
  const baseDirs = input.baseDir
    ? [path.resolve(input.baseDir)]
    : defaultHelperAssetBaseDirs({
        platform,
        env: input.env ?? getRuntimeEnv(),
        homedir: input.homedir,
        includeInstalledDesktop: input.includeInstalledDesktop,
      })
  let firstExistingFailure: WeChatChannelHelperAssetResolution | null = null
  for (const baseDir of baseDirs) {
    const resolved = resolveHelperAssetFromDir({
      platform,
      baseDir,
      verifyIntegrity: input.verifyIntegrity,
    })
    if (resolved.ok) return resolved
    if (input.baseDir || fs.existsSync(baseDir)) {
      firstExistingFailure ??= resolved
      if (input.baseDir) return resolved
    }
  }
  return firstExistingFailure ?? {
    ok: false,
    reasonCode: WECHAT_CHANNEL_HELPER_RUNTIME_REQUIRED_REASON,
    message: helperRuntimeRequiredMessage(platform, baseDirs),
  }
}

function resolveHelperAssetFromDir(input: {
  platform: NodeJS.Platform | string
  baseDir: string
  verifyIntegrity?: boolean
}): WeChatChannelHelperAssetResolution {
  const { platform, baseDir } = input
  const manifestPath = path.join(baseDir, 'manifest.json')
  const manifest = readManifest(manifestPath)
  if (!manifest) {
    return {
      ok: false,
      reasonCode: 'manifest_missing',
      message: `WeChat channel helper manifest is missing: ${manifestPath}`,
    }
  }
  const asset = manifest.platforms[platform]
  const helperPath = asset ? path.join(baseDir, asset.executable) : ''
  if (!asset || !helperPath || !fs.existsSync(helperPath)) {
    return {
      ok: false,
      reasonCode: 'helper_missing',
      message: `WeChat channel helper executable is missing: ${helperPath || baseDir}`,
    }
  }
  if (shouldVerifyHelperIntegrity({
    platform,
    baseDir,
    verifyIntegrity: input.verifyIntegrity,
  }) && asset.sha256) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(helperPath)).digest('hex')
    if (actual !== asset.sha256) {
      return {
        ok: false,
        reasonCode: 'integrity_mismatch',
        message: `WeChat channel helper integrity mismatch: ${helperPath}`,
      }
    }
  }
  const executable = ensureDarwinHelperExecutable(platform, helperPath)
  if (!executable.ok) {
    return {
      ok: false,
      reasonCode: 'helper_not_executable',
      message: executable.message,
    }
  }
  return {
    ok: true,
    helperPath,
    helperDir: baseDir,
    version: manifest.helperVersion,
    manifest,
    warning: asset.signed && asset.notarized ? undefined : 'helper_not_signed_or_notarized',
  }
}

function ensureDarwinHelperExecutable(platform: NodeJS.Platform | string, helperPath: string): { ok: true } | { ok: false; message: string } {
  if (platform !== 'darwin') return { ok: true }
  try {
    const stat = fs.statSync(helperPath)
    if ((stat.mode & 0o111) !== 0) return { ok: true }
    fs.chmodSync(helperPath, stat.mode | 0o111)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: `WeChat channel helper is not executable and could not be repaired: ${helperPath}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function defaultHelperAssetBaseDirs(input: {
  platform: NodeJS.Platform | string
  env: NodeJS.ProcessEnv
  homedir?: string
  includeInstalledDesktop?: boolean
}): string[] {
  const { platform, env } = input
  const platformDir = platform === 'win32' ? 'windows' : 'macos'
  const candidates: string[] = []
  const push = (candidate: string | undefined | null) => {
    if (!candidate) return
    const normalized = path.resolve(candidate)
    if (!candidates.includes(normalized)) candidates.push(normalized)
  }

  const explicit = env[WECHAT_CHANNEL_HELPER_DIR_ENV]?.trim()
  if (explicit) {
    push(resolveLegacyHelperDirCandidate(explicit, platformDir))
  }

  const helperRuntimeRoot = env[SHENNIAN_HELPER_RUNTIME_DIR_ENV]?.trim()
  if (helperRuntimeRoot) {
    for (const candidate of resolveHelperRuntimeDirCandidates(helperRuntimeRoot, platformDir)) push(candidate)
  }

  pushInstalledHelperRuntimeDirs({
    platform,
    platformDir,
    env,
    homedir: input.homedir,
    push,
  })

  if (input.includeInstalledDesktop === false) return candidates

  if (platform === 'darwin') {
    const home = input.homedir || env.HOME
    if (home) push(path.join(home, 'Applications', 'Shennian.app', 'Contents', 'Resources', 'wechat-channel', platformDir))
    push(path.join('/Applications', 'Shennian.app', 'Contents', 'Resources', 'wechat-channel', platformDir))
  } else if (platform === 'win32') {
    const home = input.homedir || env.USERPROFILE
    const localAppData = env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '')
    const programFiles = env.ProgramFiles || env.PROGRAMFILES
    const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)']
    for (const root of [
      localAppData ? path.join(localAppData, 'Programs', 'Shennian') : '',
      localAppData ? path.join(localAppData, 'Programs', 'shennian') : '',
      programFiles ? path.join(programFiles, 'Shennian') : '',
      programFilesX86 ? path.join(programFilesX86, 'Shennian') : '',
    ]) {
      if (root) push(path.join(root, 'resources', 'wechat-channel', platformDir))
    }
  }

  return candidates
}

function pushInstalledHelperRuntimeDirs(input: {
  platform: NodeJS.Platform | string
  platformDir: string
  env: NodeJS.ProcessEnv
  homedir?: string
  push: (candidate: string | undefined | null) => void
}): void {
  const { platform, platformDir, env, push } = input
  if (platform === 'darwin') {
    const home = input.homedir || env.HOME
    const runtimeRoot = defaultHelperRuntimeRoot({ platform, env, homedir: input.homedir })
    if (runtimeRoot) {
      push(path.join(runtimeRoot, 'Shennian Helper.app', 'Contents', 'Resources', 'wechat-channel', platformDir))
      push(path.join(runtimeRoot, 'wechat-channel', platformDir))
    }
    if (home) {
      push(path.join(home, 'Applications', 'Shennian Helper.app', 'Contents', 'Resources', 'wechat-channel', platformDir))
    }
    push(path.join('/Applications', 'Shennian Helper.app', 'Contents', 'Resources', 'wechat-channel', platformDir))
    push(path.join('/Library', 'Application Support', 'Shennian', 'Helper', 'wechat-channel', platformDir))
  } else if (platform === 'win32') {
    const home = input.homedir || env.USERPROFILE
    const localAppData = env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '')
    const programFiles = env.ProgramFiles || env.PROGRAMFILES
    const programFilesX86 = env['ProgramFiles(x86)'] || env['PROGRAMFILES(X86)']
    if (localAppData) {
      push(path.join(localAppData, 'Programs', 'Shennian Helper', 'resources', 'wechat-channel', platformDir))
      push(path.join(localAppData, 'Shennian', 'Helper', 'wechat-channel', platformDir))
    }
    if (programFiles) push(path.join(programFiles, 'Shennian Helper', 'resources', 'wechat-channel', platformDir))
    if (programFilesX86) push(path.join(programFilesX86, 'Shennian Helper', 'resources', 'wechat-channel', platformDir))
  }
}

function resolveLegacyHelperDirCandidate(value: string, platformDir: string): string {
  if (fs.existsSync(path.join(value, 'manifest.json'))) return value
  return path.join(value, platformDir)
}

function resolveHelperRuntimeDirCandidates(value: string, platformDir: string): string[] {
  if (fs.existsSync(path.join(value, 'manifest.json'))) return [value]
  const appCandidate = path.join(value, 'Shennian Helper.app', 'Contents', 'Resources', 'wechat-channel', platformDir)
  const runtimeCandidate = path.join(value, 'wechat-channel', platformDir)
  const platformCandidate = path.join(value, platformDir)
  return [appCandidate, runtimeCandidate, platformCandidate]
}

function defaultHelperRuntimeRoot(input: {
  platform: NodeJS.Platform | string
  env: NodeJS.ProcessEnv
  homedir?: string
}): string | null {
  const env = input.env
  const explicit = env[SHENNIAN_HELPER_RUNTIME_DIR_ENV]?.trim()
  if (explicit) return path.resolve(explicit)
  const home = input.homedir || (input.platform === 'win32' ? env.USERPROFILE : env.HOME)
  if (input.platform === 'darwin') {
    return home ? path.join(home, 'Library', 'Application Support', 'Shennian', 'Helper') : null
  }
  if (input.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '')
    return localAppData ? path.join(localAppData, 'Shennian', 'Helper') : null
  }
  return null
}

export function getDefaultWeChatHelperRuntimeRoot(input: {
  platform?: NodeJS.Platform | string
  env?: NodeJS.ProcessEnv
  homedir?: string
} = {}): string | null {
  return defaultHelperRuntimeRoot({
    platform: input.platform ?? process.platform,
    env: input.env ?? getRuntimeEnv(),
    homedir: input.homedir,
  })
}

export function helperRuntimePackageManifestCandidates(helperDir: string): string[] {
  const resolved = path.resolve(helperDir)
  return dedupePaths([
    path.join(resolved, 'helper-runtime-package.json'),
    path.join(path.dirname(resolved), '..', 'helper-runtime-package.json'),
  ])
}

export function readWeChatChannelHelperRuntimePackageManifest(input: {
  platform?: NodeJS.Platform | string
  helperDir?: string
  manifestPath?: string
}): WeChatChannelHelperRuntimePackageResolution {
  const platform = input.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    return {
      ok: false,
      reasonCode: 'unsupported_platform',
      message: 'WeChat channel helper runtime package is only available on macOS and Windows',
    }
  }
  const candidates = input.manifestPath
    ? [path.resolve(input.manifestPath)]
    : input.helperDir
      ? helperRuntimePackageManifestCandidates(input.helperDir)
      : []
  const manifestPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!manifestPath) {
    return {
      ok: false,
      reasonCode: 'helper_runtime_package_manifest_missing',
      message: `Helper runtime package manifest is missing. Checked: ${candidates.join(', ') || '(none)'}`,
      manifestPath: candidates[0],
    }
  }
  try {
    const parsed = JSON.parse(readUtf8JsonText(manifestPath)) as WeChatChannelHelperRuntimePackageManifest
    const validation = validateWeChatChannelHelperRuntimePackageManifest(parsed, platform)
    if (!validation.ok) {
      return {
        ok: false,
        reasonCode: 'helper_runtime_package_manifest_invalid',
        message: `${validation.message}: ${manifestPath}`,
        manifestPath,
      }
    }
    return { ok: true, manifestPath, manifest: parsed }
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'helper_runtime_package_manifest_invalid',
      message: `Helper runtime package manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      manifestPath,
    }
  }
}

export function validateWeChatChannelHelperRuntimePackageManifest(
  manifest: unknown,
  platform: NodeJS.Platform | string,
): { ok: true } | { ok: false; message: string } {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { ok: false, message: 'manifest must be an object' }
  const record = manifest as Partial<WeChatChannelHelperRuntimePackageManifest>
  if (record.schemaVersion !== 1) return { ok: false, message: 'schemaVersion must be 1' }
  if (record.packageKind !== 'shennian-helper-runtime') return { ok: false, message: 'packageKind must be shennian-helper-runtime' }
  if (record.platform !== platform) return { ok: false, message: `platform must be ${platform}` }
  if (!record.helperVersion) return { ok: false, message: 'helperVersion is required' }
  if (!Number.isInteger(record.protocolVersion) || Number(record.protocolVersion) <= 0) return { ok: false, message: 'protocolVersion must be a positive integer' }
  if (!isSemverLike(record.minCliVersion)) return { ok: false, message: 'minCliVersion must be a semver string' }
  if (!record.sha256 || typeof record.sha256.runtimeManifest !== 'string') return { ok: false, message: 'sha256.runtimeManifest is required' }
  if (!isSha256OrPlaceholder(record.sha256.runtimeManifest)) return { ok: false, message: 'sha256.runtimeManifest must be a sha256 digest' }
  if (record.sha256.entrypoint !== null && typeof record.sha256.entrypoint !== 'string') return { ok: false, message: 'sha256.entrypoint must be a string or null' }
  if (typeof record.sha256.entrypoint === 'string' && !isSha256OrPlaceholder(record.sha256.entrypoint)) return { ok: false, message: 'sha256.entrypoint must be a sha256 digest or null' }
  if (!record.installTarget?.kind || !record.installTarget.defaultPath) return { ok: false, message: 'installTarget.kind and installTarget.defaultPath are required' }
  if (!record.payload?.kind || !record.payload.runtimeManifest || !record.payload.entrypoint) return { ok: false, message: 'payload.kind, payload.runtimeManifest, and payload.entrypoint are required' }
  if (platform === 'darwin' && record.installTarget.kind !== 'app-bundle') return { ok: false, message: 'darwin installTarget.kind must be app-bundle' }
  if (platform === 'darwin' && record.payload.kind !== 'macos-helper-app') return { ok: false, message: 'darwin payload.kind must be macos-helper-app' }
  if (platform === 'win32' && record.installTarget.kind !== 'directory') return { ok: false, message: 'win32 installTarget.kind must be directory' }
  if (platform === 'win32' && record.payload.kind !== 'windows-helper-runtime') return { ok: false, message: 'win32 payload.kind must be windows-helper-runtime' }
  if (!record.signature || typeof record.signature.requiredForRelease !== 'boolean' || typeof record.signature.signed !== 'boolean' || typeof record.signature.notarized !== 'boolean') {
    return { ok: false, message: 'signature.requiredForRelease, signature.signed, and signature.notarized are required' }
  }
  return { ok: true }
}

function isSemverLike(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
}

function isSha256OrPlaceholder(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function shouldVerifyHelperIntegrity(input: {
  platform: NodeJS.Platform | string
  baseDir: string
  verifyIntegrity?: boolean
}): boolean {
  if (input.verifyIntegrity === true) return true
  if (input.verifyIntegrity === false) return false
  return !isDesktopPackagedHelperDir(input.platform, input.baseDir)
}

function isDesktopPackagedHelperDir(platform: NodeJS.Platform | string, baseDir: string): boolean {
  const normalized = baseDir.replace(/[\\/]+/g, '/')
  if (platform === 'darwin') {
    return /\/Shennian\.app\/Contents\/Resources\/wechat-channel\/macos$/i.test(normalized)
  }
  if (platform === 'win32') {
    return /\/resources\/wechat-channel\/windows$/i.test(normalized)
  }
  return false
}

function helperRuntimeRequiredMessage(platform: NodeJS.Platform | string, checkedDirs: string[]): string {
  const platformName = platform === 'win32' ? 'Windows' : 'macOS'
  const checked = checkedDirs.length > 0 ? ` Checked helper directories: ${checkedDirs.join(', ')}` : ''
  return `WeChat RPA requires Shennian Helper runtime on ${platformName}; open Shennian Desktop or use the 使用微信 page to install Helper, then retry.${checked}`
}

function getRuntimeEnv(): NodeJS.ProcessEnv {
  const processLike = (globalThis as unknown as { process?: Record<string, NodeJS.ProcessEnv | undefined> }).process
  return processLike?.[RUNTIME_ENV_PROPERTY] ?? {}
}

function readManifest(filePath: string): WeChatChannelHelperAssetManifest | null {
  try {
    const parsed = JSON.parse(readUtf8JsonText(filePath)) as WeChatChannelHelperAssetManifest
    if (parsed.schemaVersion !== 1 || typeof parsed.helperVersion !== 'string' || !parsed.platforms) return null
    return parsed
  } catch {
    return null
  }
}

function readUtf8JsonText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of paths) {
    const normalized = path.resolve(candidate)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}
