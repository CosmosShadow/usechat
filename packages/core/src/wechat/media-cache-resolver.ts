// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-media-cache-resolver.test.ts

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type CacheCandidate = {
  kind: string
  fileName?: string | null
  mimeType?: string | null
  size?: number | null
}

type CacheFile = {
  path: string
  name: string
  size: number
  mtimeMs: number
}

export type WeChatChannelMediaCacheScanTrace = {
  strategy: 'token' | 'recent-unique' | 'none'
  roots: string[]
  extensionCandidates: string[]
  tokens: string[]
  hasTimeAnchor?: boolean
  scannedFileCount: number
  matchedFileCount: number
  minMtimeMs?: number
  maxAgeMs: number
  selected?: {
    path: string
    name: string
    size: number
    mtimeMs: number
    score?: number
  }
}

export type WeChatChannelMediaCacheLookupResult =
  | { ok: true; sourcePath: string; reasonCode: 'wechat_cache_token_match' | 'wechat_cache_recent_unique_match'; trace: WeChatChannelMediaCacheScanTrace }
  | { ok: false; reasonCode: 'wechat_cache_scan_unavailable' | 'wechat_cache_lookup_token_missing' | 'wechat_cache_file_not_found' | 'wechat_cache_recent_match_ambiguous'; trace: WeChatChannelMediaCacheScanTrace }

const DEFAULT_MAX_CACHE_FILES = 5_000
const DEFAULT_MAX_CACHE_AGE_MS = 14 * 24 * 60 * 60 * 1000
const RECENT_MATCH_SKEW_MS = 5_000

const IMAGE_EXTENSIONS = new Set(['.apng', '.avif', '.bmp', '.gif', '.heic', '.heif', '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'])
const VIDEO_EXTENSIONS = new Set(['.3g2', '.3gp', '.avi', '.m4v', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm', '.wmv'])
const GENERIC_TOKEN_RE = /^(attachment|document|file|image|img|photo|pic|picture|video|vid|wechat|weixin|wx|copy|download|mp4|mov|m4v|png|jpg|jpeg|gif|webp|txt|pdf)$/i

export function findCachedWeChatInboundMedia(
  candidate: CacheCandidate,
  options: {
    roots?: string[]
    minMtimeMs?: number
    nowMs?: number
    maxAgeMs?: number
    maxFiles?: number
  } = {},
): WeChatChannelMediaCacheLookupResult {
  const roots = cacheRoots(options.roots)
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : DEFAULT_MAX_CACHE_AGE_MS
  const minMtimeMs = Number.isFinite(Number(options.minMtimeMs)) ? Number(options.minMtimeMs) - RECENT_MATCH_SKEW_MS : undefined
  const extensionCandidates = extensionsForCandidate(candidate)
  const tokens = cacheLookupTokens(candidate)
  const hasTimeAnchor = minMtimeMs !== undefined
  const traceBase = (): WeChatChannelMediaCacheScanTrace => ({
    strategy: 'none',
    roots,
    extensionCandidates,
    tokens,
    ...(hasTimeAnchor ? { hasTimeAnchor } : {}),
    scannedFileCount: 0,
    matchedFileCount: 0,
    ...(minMtimeMs !== undefined ? { minMtimeMs } : {}),
    maxAgeMs,
  })

  if (!roots.length || !extensionCandidates.length) {
    return { ok: false, reasonCode: 'wechat_cache_scan_unavailable', trace: traceBase() }
  }

  const files = candidateCacheFiles(roots, {
    maxFiles: options.maxFiles,
    maxAgeMs,
    nowMs: options.nowMs,
  }).filter((file) => extensionCandidates.includes(path.extname(file.name).toLowerCase()))

  if (tokens.length) {
    const matches = files
      .map((file) => ({ ...file, score: scoreCacheFile(file, tokens, candidate) }))
      .filter((file) => file.score > 0)
      .sort((a, b) => b.score - a.score || b.mtimeMs - a.mtimeMs)
    const selected = matches[0]
    if (selected) {
      return {
        ok: true,
        sourcePath: selected.path,
        reasonCode: 'wechat_cache_token_match',
        trace: {
          ...traceBase(),
          strategy: 'token',
          scannedFileCount: files.length,
          matchedFileCount: matches.length,
          selected: selectedForTrace(selected),
        },
      }
    }
  }

  const recentGroups = hasTimeAnchor ? recentUniqueGroups(candidate, files, minMtimeMs) : []
  if (recentGroups.length === 1) {
    const selected = recentGroups[0]
    return {
      ok: true,
      sourcePath: selected.path,
      reasonCode: 'wechat_cache_recent_unique_match',
      trace: {
        ...traceBase(),
        strategy: 'recent-unique',
        scannedFileCount: files.length,
        matchedFileCount: recentGroups.length,
        selected: selectedForTrace(selected),
      },
    }
  }
  if (recentGroups.length > 1) {
    return {
      ok: false,
      reasonCode: 'wechat_cache_recent_match_ambiguous',
      trace: {
        ...traceBase(),
        strategy: 'recent-unique',
        scannedFileCount: files.length,
        matchedFileCount: recentGroups.length,
      },
    }
  }

  return {
    ok: false,
    reasonCode: tokens.length || minMtimeMs !== undefined ? 'wechat_cache_file_not_found' : 'wechat_cache_lookup_token_missing',
    trace: {
      ...traceBase(),
      scannedFileCount: files.length,
      matchedFileCount: 0,
    },
  }
}

function cacheRoots(roots: string[] | undefined): string[] {
  if (Array.isArray(roots) && roots.length) {
    return roots.map((root) => String(root || '').trim()).filter(Boolean)
  }
  if (process.platform !== 'win32') return []
  const home = os.homedir()
  if (!home) return []
  return [
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(home, 'Documents', 'WeChat Files'),
  ]
}

function extensionsForCandidate(candidate: CacheCandidate): string[] {
  const ext = normalizeExtension(path.extname(String(candidate.fileName || '')))
  if (ext) return [ext]
  const mime = String(candidate.mimeType || '').toLowerCase()
  if (mime === 'image/png') return ['.png']
  if (mime === 'image/jpeg') return ['.jpg', '.jpeg']
  if (mime === 'image/gif') return ['.gif']
  if (mime === 'image/webp') return ['.webp']
  if (mime === 'video/mp4') return ['.mp4']
  if (mime === 'video/quicktime') return ['.mov']
  const type = attachmentTypeForCandidate(candidate)
  if (type === 'image') return [...IMAGE_EXTENSIONS]
  if (type === 'video') return [...VIDEO_EXTENSIONS]
  return []
}

function cacheLookupTokens(candidate: CacheCandidate): string[] {
  const values = [
    candidate.fileName,
  ].map((value) => normalizedFileNameToken(value)).filter(Boolean)
  const tokens = new Set<string>()
  for (const value of values) {
    for (const token of value.split(/[^a-z0-9]+/i)) {
      if (token.length >= 4 && !GENERIC_TOKEN_RE.test(token)) tokens.add(token.toLowerCase())
    }
    if (value.length >= 8 && !GENERIC_TOKEN_RE.test(value)) tokens.add(value.toLowerCase())
  }
  return [...tokens]
}

function candidateCacheFiles(
  roots: string[],
  options: { nowMs?: number; maxAgeMs: number; maxFiles?: number },
): CacheFile[] {
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Math.max(1, Number(options.maxFiles)) : DEFAULT_MAX_CACHE_FILES
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now()
  const minMtimeMs = nowMs - options.maxAgeMs
  const files: CacheFile[] = []
  const stack = roots.map((root) => path.resolve(root))
  const seen = new Set<string>()
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop()
    if (!current || seen.has(current)) continue
    seen.add(current)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (shouldDescendCacheDirectory(current, entry.name)) stack.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(fullPath)
      } catch {
        continue
      }
      if (stat.mtimeMs < minMtimeMs || stat.size <= 0) continue
      files.push({ path: fullPath, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs })
      if (files.length >= maxFiles) break
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function shouldDescendCacheDirectory(current: string, name: string): boolean {
  const normalized = name.toLowerCase()
  const currentLower = current.toLowerCase()
  return /^(cache|temp|tmp|rwtemp|filestorage|msgattach|msg|image|video|file|[0-9-]+)$/i.test(normalized)
    || currentLower.includes('xwechat_files')
    || currentLower.includes('wechat files')
}

function scoreCacheFile(file: CacheFile, tokens: string[], candidate: CacheCandidate): number {
  const normalizedName = normalizedFileNameToken(file.name)
  const tokenScore = tokens.reduce((sum, token) => sum + (normalizedName.includes(token) ? Math.min(20, token.length) : 0), 0)
  const size = Number(candidate.size)
  const sizeScore = Number.isFinite(size) && size > 0 && Math.abs(file.size - size) <= Math.max(8, size * 0.02) ? 12 : 0
  return tokenScore + sizeScore
}

function recentUniqueGroups(candidate: CacheCandidate, files: CacheFile[], minMtimeMs: number | undefined): CacheFile[] {
  if (attachmentTypeForCandidate(candidate) !== 'video' || minMtimeMs === undefined) return []
  const recent = files.filter((file) => file.mtimeMs >= minMtimeMs)
  const groups = new Map<string, CacheFile[]>()
  for (const file of recent) {
    const key = path.basename(file.name, path.extname(file.name)).replace(/_raw$/i, '')
    const existing = groups.get(key) ?? []
    existing.push(file)
    groups.set(key, existing)
  }
  return [...groups.values()]
    .map((group) => group.sort((a, b) => Number(/_raw\./i.test(b.name)) - Number(/_raw\./i.test(a.name)) || b.mtimeMs - a.mtimeMs)[0])
}

function selectedForTrace(file: CacheFile & { score?: number }): NonNullable<WeChatChannelMediaCacheScanTrace['selected']> {
  return {
    path: file.path,
    name: file.name,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...(Number.isFinite(file.score) ? { score: file.score } : {}),
  }
}

function attachmentTypeForCandidate(candidate: CacheCandidate): 'image' | 'video' | 'file' {
  const normalized = String(candidate.kind || '').toLowerCase().replace(/_/g, '-')
  if (normalized.includes('image') || normalized.includes('photo')) return 'image'
  if (normalized.includes('video')) return 'video'
  return 'file'
}

function normalizedFileNameToken(value: unknown): string {
  return basenameForAnyPlatform(String(value || '').trim())
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
}

function basenameForAnyPlatform(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || ''
}

function normalizeExtension(value: string): string {
  const ext = String(value || '').trim().toLowerCase()
  return ext.startsWith('.') ? ext : ext ? `.${ext}` : ''
}
