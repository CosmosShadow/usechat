// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-media-resolver.test.ts

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ExternalMessageAttachment } from './types.js'
import type { HelperTransport as WeChatChannelHelperTransport } from './runtime.js'
import { normalizeWeChatChannelMessageKind, type WeChatChannelMediaAction, type WeChatChannelMediaActionPlan } from './core/schema.js'
import { buildWeChatChannelMediaActionPlan } from './core/media-action-plan.js'
import { findCachedWeChatInboundMedia } from './media-cache-resolver.js'
import type {
  ClipboardAttachmentPayload,
  WeChatChannelClipboardPayloadTrace,
  WeChatChannelMediaAttachmentValidationTrace,
  WeChatChannelMediaResolveAttemptTrace,
  WeChatChannelMediaResolveResult,
  WeChatChannelMediaResolveTrace,
  WeChatChannelMediaStabilityStage,
  WeChatChannelMenuSearchBounds,
  WeChatChannelOcrMenuCandidateTrace,
  WeChatChannelVisibleMediaCandidate,
} from './media-resolver-types.js'

const MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024

export async function waitForClipboardAttachment(input: {
  helper: WeChatChannelHelperTransport
  beforeChangeCount?: number | null
  candidate: WeChatChannelVisibleMediaCandidate
  traceId?: string
  timeoutMs?: number
}): Promise<{ result?: ClipboardAttachmentPayload; reasonCode?: string; lastChangeCount?: number | null }> {
  const started = Date.now()
  let changedWithoutAttachment = 0
  const type = normalizeAttachmentType(input.candidate.kind)
  do {
    const clipboard = await input.helper.request<ClipboardAttachmentPayload>('clipboard.readAttachment', {}, input.traceId)
    if (!clipboard.ok) return { reasonCode: clipboard.errorCode || 'clipboard_read_failed' }
    const changed = input.beforeChangeCount == null || Number(clipboard.result?.changeCount) !== Number(input.beforeChangeCount)
    if (changed && clipboardHasUsableAttachment(input.candidate, clipboard.result)) return { result: clipboard.result, lastChangeCount: numberValue(clipboard.result, 'changeCount') }
    if (changed) {
      changedWithoutAttachment += 1
      if (changedWithoutAttachment >= (type === 'image' ? 12 : 3)) break
    }
    await sleep(type === 'image' ? 160 : 120)
  } while (Date.now() - started < (input.timeoutMs ?? 2_500))
  return { reasonCode: type === 'image' ? 'clipboard_attachment_unavailable' : 'clipboard_file_url_unavailable', lastChangeCount: null }
}

export function materializeLocalAttachment(
  candidate: WeChatChannelVisibleMediaCandidate,
  sourcePath: string,
  attachmentsDir: string,
  sourceAction?: string,
): ExternalMessageAttachment {
  const stat = fs.statSync(sourcePath)
  if (!stat.isFile()) throw new Error('wechat_channel_attachment_not_file')
  if (stat.size > MAX_INBOUND_ATTACHMENT_BYTES) {
    return {
      type: normalizeAttachmentType(candidate.kind),
      name: safeFileName(candidate.fileName || path.basename(sourcePath)),
      size: stat.size,
      mimeType: candidate.mimeType || mimeFromPath(sourcePath),
      availability: 'unavailable-large',
      providerError: 'attachment_too_large',
    }
  }
  fs.mkdirSync(attachmentsDir, { recursive: true })
  const buffer = fs.readFileSync(sourcePath)
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  const mimeType = attachmentMimeForSource(candidate, sourcePath)
  const name = attachmentNameForSource(candidate, sourcePath, mimeType)
  const ext = path.extname(name)
    || path.extname(sourcePath)
    || extensionFromMimeType(mimeType)
    || ''
  const extension = normalizeExtension(ext)
  const stem = ext ? name.slice(0, -ext.length) : name
  const targetPath = path.join(attachmentsDir, `${stem}-${hash.slice(0, 12)}${ext}`)
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, buffer)
  return {
    type: normalizeAttachmentType(candidate.kind),
    name,
    mimeType,
    size: buffer.byteLength,
    ...(extension ? { extension } : {}),
    localPath: targetPath,
    hash,
    availability: 'edge-local',
    ...(sourceAction ? { sourceAction } : {}),
    materializationKind: 'original-file',
    isOriginal: true,
    mimeKindMatches: true,
  }
}

export function materializeClipboardAttachment(
  candidate: WeChatChannelVisibleMediaCandidate,
  payload: ClipboardAttachmentPayload | undefined,
  attachmentsDir: string,
): ExternalMessageAttachment | null {
  const sourcePath = firstClipboardPath(payload)
  if (sourcePath) {
    if (!clipboardPathMatchesCandidate(candidate, sourcePath, payload)) return null
    return materializeLocalAttachment(candidate, sourcePath, attachmentsDir, 'materialize-clipboard')
  }
  if (normalizeAttachmentType(candidate.kind) !== 'image') return null
  return materializeClipboardImageAttachment(candidate, payload, attachmentsDir)
}

function materializeClipboardImageAttachment(
  candidate: WeChatChannelVisibleMediaCandidate,
  payload: ClipboardAttachmentPayload | undefined,
  attachmentsDir: string,
): ExternalMessageAttachment | null {
  const dataBase64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64.trim() : ''
  if (!dataBase64) return null
  const buffer = Buffer.from(dataBase64, 'base64')
  if (!buffer.length) return null
  if (buffer.byteLength > MAX_INBOUND_ATTACHMENT_BYTES) {
    return {
      type: 'image',
      name: safeFileName(candidate.fileName || payload?.suggestedFileName || 'wechat-image.png'),
      size: buffer.byteLength,
      mimeType: candidate.mimeType || payload?.mimeType || 'image/png',
      availability: 'unavailable-large',
      providerError: 'attachment_too_large',
    }
  }
  fs.mkdirSync(attachmentsDir, { recursive: true })
  const mimeType = candidate.mimeType || payload?.mimeType || 'image/png'
  const ext = extensionFromMimeType(mimeType) || '.png'
  const baseName = safeFileName(candidate.fileName || payload?.suggestedFileName || `wechat-image${ext}`)
  const name = path.extname(baseName) ? baseName : `${baseName}${ext}`
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  const fileExt = path.extname(name) || ext
  const extension = normalizeExtension(fileExt)
  const stem = fileExt ? name.slice(0, -fileExt.length) : name
  const targetPath = path.join(attachmentsDir, `${stem}-${hash.slice(0, 12)}${fileExt}`)
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, buffer)
  return {
    type: 'image',
    name,
    mimeType,
    size: buffer.byteLength,
    extension,
    localPath: targetPath,
    hash,
    availability: 'edge-local',
    sourceAction: 'materialize-clipboard',
    materializationKind: 'clipboard-image',
    isOriginal: true,
    mimeKindMatches: true,
  }
}

export function metadataOnlyResult(
  candidate: WeChatChannelVisibleMediaCandidate,
  reasonCode: string,
  resolveTrace?: WeChatChannelMediaResolveTrace,
): WeChatChannelMediaResolveResult {
  if (resolveTrace) resolveTrace.finalReasonCode = reasonCode
  return {
    messageKey: candidate.messageKey,
    reasonCode,
    ...(resolveTrace ? { resolveTrace } : {}),
    attachment: {
      type: normalizeAttachmentType(candidate.kind),
      name: safeFileName(candidate.fileName || `${candidate.kind || 'attachment'}`),
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
      ...(Number.isFinite(candidate.size) ? { size: Number(candidate.size) } : {}),
      // not_downloaded（待点下载）和 loading（转圈下载中）都还在下载流程里，标 pending-download
      // 让账本知道下一轮还要继续推进；其余真没法读的才降级 metadata-only。
      availability: candidate.mediaStatus === 'not_downloaded' || candidate.mediaStatus === 'loading' ? 'pending-download' : 'metadata-only',
      providerError: reasonCode,
      materializationKind: 'metadata',
      isOriginal: false,
      mimeKindMatches: false,
    },
  }
}

export function createMediaResolveTrace(
  candidate: WeChatChannelVisibleMediaCandidate,
  actionPlan: WeChatChannelMediaActionPlan,
): WeChatChannelMediaResolveTrace {
  return {
    candidateKind: String(candidate.kind || 'unknown'),
    ...(candidate.bbox ? { bbox: candidate.bbox } : {}),
    ...(candidate.downloadActionBbox !== undefined ? { downloadActionBbox: candidate.downloadActionBbox } : {}),
    ...(candidate.mediaStatus !== undefined ? { mediaStatus: candidate.mediaStatus } : {}),
    actionPlan: {
      reasonCode: actionPlan.reasonCode,
      actions: actionPlan.actions.map((action) => ({
        type: action.type,
        ...(action.reasonCode ? { reasonCode: action.reasonCode } : {}),
        ...(action.label ? { label: action.label } : {}),
        ...(action.target ? { target: action.target } : {}),
      })),
    },
    attempts: [],
  }
}

export function recordStabilityAttempt(
  trace: WeChatChannelMediaResolveTrace,
  stage: WeChatChannelMediaStabilityStage,
  result: { ok: true } | { ok: false; reasonCode: string },
  retry = false,
): void {
  trace.attempts.push({
    phase: 'stability',
    stage,
    retry,
    ok: result.ok,
    ...(result.ok ? {} : { reasonCode: result.reasonCode }),
  })
}

export function recordMediaResolveAttempt(trace: WeChatChannelMediaResolveTrace, attempt: WeChatChannelMediaResolveAttemptTrace): void {
  trace.attempts.push({
    ...attempt,
    ...(attempt.menuPickOrder ? { menuPickOrder: [...attempt.menuPickOrder] } : {}),
    ...(attempt.disallowedLabels ? { disallowedLabels: [...attempt.disallowedLabels] } : {}),
  })
}

export function summarizeClipboardPayload(payload: ClipboardAttachmentPayload | undefined): WeChatChannelClipboardPayloadTrace {
  const fileUrls = payload?.fileUrls ?? []
  const filePaths = payload?.filePaths ?? []
  const dataBase64 = typeof payload?.dataBase64 === 'string' ? payload.dataBase64.trim() : ''
  const names = [...filePaths, ...fileUrls]
    .map((value) => firstClipboardPath({ filePaths: [value] }) || value)
    .map((value) => path.basename(value))
    .filter(Boolean)
  const extensions = [...new Set(names.map((name) => normalizeExtension(path.extname(name || ''))).filter(Boolean))]
  return {
    changeCount: numberValue(payload, 'changeCount'),
    fileUrlCount: fileUrls.length,
    filePathCount: filePaths.length,
    hasImageData: Boolean(dataBase64),
    ...(dataBase64 ? { imageDataBytes: Buffer.from(dataBase64, 'base64').byteLength } : {}),
    ...(payload?.mimeType ? { mimeType: payload.mimeType } : {}),
    ...(payload?.suggestedFileName ? { suggestedFileName: payload.suggestedFileName } : {}),
    ...(names.length ? { fileNames: names } : {}),
    ...(extensions.length ? { extensions } : {}),
  }
}

export function resolveWindowsCacheFallback(input: {
  candidate: WeChatChannelVisibleMediaCandidate
  attachmentsDir: string
  resolveTrace?: WeChatChannelMediaResolveTrace
  platform?: NodeJS.Platform | string
  cacheRoots?: string[]
}): { attachment: ExternalMessageAttachment | null; reasonCode?: string } {
  if (!isWindowsPlatform(input.platform)) return { attachment: null }
  if (normalizeAttachmentType(input.candidate.kind) !== 'video') return { attachment: null }
  const minMtimeMs = cacheLookupMinMtimeMs(input.candidate)
  const lookup = findCachedWeChatInboundMedia(input.candidate, {
    roots: input.cacheRoots,
    ...(minMtimeMs !== null ? { minMtimeMs } : {}),
  })
  if (input.resolveTrace) {
    recordMediaResolveAttempt(input.resolveTrace, {
      phase: 'cache-scan',
      ok: lookup.ok,
      reasonCode: lookup.reasonCode,
      cacheScan: lookup.trace,
    })
  }
  if (!lookup.ok) return { attachment: null, reasonCode: lookup.reasonCode }
  try {
    const attachment = materializeLocalAttachment(input.candidate, lookup.sourcePath, input.attachmentsDir, 'wechat-cache-scan')
    if (input.resolveTrace) input.resolveTrace.attachmentValidation = summarizeAttachmentValidation(attachment)
    return { attachment, reasonCode: 'edge_local_from_wechat_cache' }
  } catch (error) {
    return { attachment: null, reasonCode: errorReasonCode(error) }
  }
}

export function summarizeAttachmentValidation(attachment: ExternalMessageAttachment | null | undefined): WeChatChannelMediaAttachmentValidationTrace | undefined {
  if (!attachment) return undefined
  return {
    ...(attachment.availability ? { availability: attachment.availability } : {}),
    ...(attachment.type ? { type: attachment.type } : {}),
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.extension ? { extension: attachment.extension } : {}),
    ...(attachment.materializationKind ? { materializationKind: attachment.materializationKind } : {}),
    ...(typeof attachment.isOriginal === 'boolean' ? { isOriginal: attachment.isOriginal } : {}),
    ...(typeof attachment.mimeKindMatches === 'boolean' ? { mimeKindMatches: attachment.mimeKindMatches } : {}),
  }
}

export function lastReasonCode(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value))
  return filtered[filtered.length - 1]
}

export function visibleMediaActionPlan(candidate: WeChatChannelVisibleMediaCandidate): WeChatChannelMediaActionPlan {
  return buildWeChatChannelMediaActionPlan({
    ...candidate,
    kind: normalizeWeChatChannelMessageKind(candidate.kind),
  })
}

export function uniqueReasonCodes(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function isWindowsPlatform(platform: NodeJS.Platform | string | undefined): boolean {
  return String(platform || process.platform).toLowerCase() === 'win32'
}

function cacheLookupMinMtimeMs(candidate: WeChatChannelVisibleMediaCandidate): number | null {
  return timestampFromContextText(candidate.contextText)
}

function timestampFromContextText(value: unknown): number | null {
  const text = String(value || '')
  const match = text.match(/\b(20\d{12})\b/)
  if (!match) return null
  const stamp = match[1]
  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(4, 6))
  const day = Number(stamp.slice(6, 8))
  const hour = Number(stamp.slice(8, 10))
  const minute = Number(stamp.slice(10, 12))
  const second = Number(stamp.slice(12, 14))
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function plannedAction(
  plan: WeChatChannelMediaActionPlan,
  type: WeChatChannelMediaAction['type'],
  occurrence = 0,
): WeChatChannelMediaAction | undefined {
  return plan.actions.filter((action) => action.type === type)[occurrence]
}

export function plannedCopyMenuLabel(plan: WeChatChannelMediaActionPlan, retry?: boolean): string | undefined {
  return plannedAction(plan, 'ocr-click-menu-item', retry ? 1 : 0)?.label
}

function candidateMediaType(kind: string): 'image' | 'video' | 'file' | null {
  const normalizedKind = normalizeWeChatChannelMessageKind(kind)
  if (normalizedKind === 'image') return 'image'
  if (normalizedKind === 'video-file') return 'video'
  if (normalizedKind === 'file') return 'file'
  if (normalizedKind !== 'unknown') return null
  const normalized = String(kind || '').toLowerCase()
  if (normalized.includes('video')) return 'video'
  if (normalized.includes('image') || normalized.includes('photo')) return 'image'
  if (normalized.includes('file') || normalized.includes('document')) return 'file'
  return null
}

export function normalizeAttachmentType(kind: string): ExternalMessageAttachment['type'] {
  const mediaType = candidateMediaType(kind)
  if (mediaType) return mediaType
  return 'file'
}

function attachmentMimeForSource(candidate: WeChatChannelVisibleMediaCandidate, sourcePath: string): string {
  const type = normalizeAttachmentType(candidate.kind)
  const candidateMimeType = String(candidate.mimeType || '').trim().toLowerCase()
  if (candidateMimeType && mimeMatchesAttachmentType(candidateMimeType, type)) return candidateMimeType
  return mimeFromPath(sourcePath)
}

function attachmentNameForSource(candidate: WeChatChannelVisibleMediaCandidate, sourcePath: string, mimeType: string): string {
  const type = normalizeAttachmentType(candidate.kind)
  const candidateName = candidate.fileName ? safeFileName(candidate.fileName) : ''
  if (candidateName && nameMatchesAttachmentType(candidateName, mimeType, type)) return candidateName
  return safeFileName(path.basename(sourcePath) || candidateName || 'attachment')
}

function nameMatchesAttachmentType(name: string, mimeType: string, type: ExternalMessageAttachment['type']): boolean {
  if (type === 'file') return true
  const ext = path.extname(name).toLowerCase()
  if (ext) return extensionMatchesAttachmentType(ext, type)
  return mimeMatchesAttachmentType(mimeType, type)
}

function mimeMatchesAttachmentType(mimeType: string, type: ExternalMessageAttachment['type']): boolean {
  if (type === 'image') return mimeType.startsWith('image/')
  if (type === 'video') return mimeType.startsWith('video/')
  return true
}

function extensionMatchesAttachmentType(ext: string, type: ExternalMessageAttachment['type']): boolean {
  if (type === 'image') return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp'].includes(ext)
  if (type === 'video') return ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'].includes(ext)
  return true
}

export function menuLabelsForCandidate(candidate: WeChatChannelVisibleMediaCandidate, plannedLabel?: string): string[] {
  const type = normalizeAttachmentType(candidate.kind)
  const labels = type === 'image'
    ? ['复制图片', '拷贝图片', '复制图像', '拷贝图像', '复制', '拷贝', 'Copy Image', 'Copy']
    : type === 'video'
      ? ['复制视频', '拷贝视频', '复制文件', '拷贝文件', '复制', '拷贝', 'Copy Video', 'Copy File', 'Copy']
      : ['复制文件', '拷贝文件', '复制', '拷贝', 'Copy File', 'Copy']
  return plannedLabel ? [plannedLabel, ...labels.filter((label) => label !== plannedLabel)] : labels
}

function firstClipboardPath(result: { fileUrls?: string[]; filePaths?: string[] } | undefined): string | null {
  const raw = result?.filePaths?.[0] || result?.fileUrls?.[0]
  if (!raw) return null
  if (raw.startsWith('file://')) return decodeURIComponent(new URL(raw).pathname)
  return raw
}

function clipboardHasUsableAttachment(candidate: WeChatChannelVisibleMediaCandidate, payload: ClipboardAttachmentPayload | undefined): boolean {
  const sourcePath = firstClipboardPath(payload)
  if (sourcePath) return clipboardPathMatchesCandidate(candidate, sourcePath, payload)
  return normalizeAttachmentType(candidate.kind) === 'image' && Boolean(payload?.dataBase64)
}

function clipboardPathMatchesCandidate(
  candidate: WeChatChannelVisibleMediaCandidate,
  sourcePath: string,
  payload: ClipboardAttachmentPayload | undefined,
): boolean {
  const type = normalizeAttachmentType(candidate.kind)
  const mimeType = String(payload?.mimeType || candidate.mimeType || mimeFromPath(sourcePath)).toLowerCase()
  const ext = path.extname(sourcePath).toLowerCase()
  if (type === 'image' || type === 'video') {
    return mimeMatchesAttachmentType(mimeType, type) || extensionMatchesAttachmentType(ext, type)
  }
  return type === 'file'
}

export function errorReasonCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.split(':', 1)[0]?.trim()
  return /^[a-z0-9_]+$/i.test(code || '') ? code : 'media_resolve_failed'
}

function bboxCenter(bbox: NonNullable<WeChatChannelVisibleMediaCandidate['bbox']>): { x: number; y: number; coordinateSpace?: string } {
  return {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2,
    coordinateSpace: bbox.coordinateSpace,
  }
}

export function rightClickPointsForCandidate(
  candidate: WeChatChannelVisibleMediaCandidate,
  bbox: NonNullable<WeChatChannelVisibleMediaCandidate['bbox']>,
  hasLiveWindowContext = false,
): Array<{
  x: number
  y: number
  coordinateSpace?: string
  role: NonNullable<WeChatChannelMediaResolveAttemptTrace['pointRole']>
}> {
  const center = { ...bboxCenter(bbox), role: 'center' as const }
  if (normalizeAttachmentType(candidate.kind) !== 'file') {
    if (!hasLiveWindowContext) return [center]
    const insetX = Math.max(18, Math.min(48, bbox.width * 0.18))
    const insetY = Math.max(18, Math.min(48, bbox.height * 0.18))
    return dedupeRightClickPoints([
      {
        x: bbox.x + insetX,
        y: bbox.y + insetY,
        coordinateSpace: bbox.coordinateSpace,
        role: 'media-top-left' as const,
      },
      {
        x: bbox.x + Math.max(insetX, bbox.width - insetX),
        y: bbox.y + insetY,
        coordinateSpace: bbox.coordinateSpace,
        role: 'media-top-right' as const,
      },
      {
        x: bbox.x + insetX,
        y: bbox.y + Math.max(insetY, bbox.height - insetY),
        coordinateSpace: bbox.coordinateSpace,
        role: 'media-bottom-left' as const,
      },
      {
        x: bbox.x + Math.max(insetX, bbox.width - insetX),
        y: bbox.y + Math.max(insetY, bbox.height - insetY),
        coordinateSpace: bbox.coordinateSpace,
        role: 'media-bottom-right' as const,
      },
      center,
    ])
  }
  const points = [
    {
      x: bbox.x + Math.min(Math.max(96, bbox.width * 0.34), Math.max(24, bbox.width - 36)),
      y: bbox.y + Math.min(Math.max(36, bbox.height * 0.32), Math.max(12, bbox.height - 24)),
      coordinateSpace: bbox.coordinateSpace,
      role: 'file-title' as const,
    },
    {
      x: bbox.x + Math.min(Math.max(128, bbox.width * 0.46), Math.max(24, bbox.width - 36)),
      y: bbox.y + Math.min(Math.max(64, bbox.height * 0.58), Math.max(12, bbox.height - 24)),
      coordinateSpace: bbox.coordinateSpace,
      role: 'file-body' as const,
    },
    center,
  ]
  return dedupeRightClickPoints(points)
}

function dedupeRightClickPoints<T extends { x: number; y: number }>(points: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const point of points) {
    const key = `${Math.round(point.x)}:${Math.round(point.y)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(point)
  }
  return result
}

export function screenPointForBbox(
  bbox: { x: number; y: number; width: number; height: number; coordinateSpace?: string } | undefined,
  screenshot: { width: number; height: number },
  window?: { bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } },
  screenBounds?: WeChatChannelMenuSearchBounds,
): { x: number; y: number } | null {
  if (!bbox) return null
  const x = Number(bbox.x)
  const y = Number(bbox.y)
  const width = Number(bbox.width)
  const height = Number(bbox.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  const point = { x: x + width / 2, y: y + height / 2 }
  if (screenBounds) {
    const scaleX = screenshot.width && screenBounds.width ? screenshot.width / screenBounds.width : 1
    const scaleY = screenshot.height && screenBounds.height ? screenshot.height / screenBounds.height : scaleX
    return {
      x: screenBounds.x + point.x / scaleX,
      y: screenBounds.y + point.y / scaleY,
    }
  }
  if (bbox.coordinateSpace === 'screen' || !window?.bounds) return point
  const scaleX = screenshot.width && window.bounds.width ? screenshot.width / window.bounds.width : 1
  const scaleY = screenshot.height && window.bounds.height ? screenshot.height / window.bounds.height : scaleX
  return {
    x: window.bounds.x + point.x / scaleX,
    y: window.bounds.y + point.y / scaleY,
  }
}

export function normalizeMenuText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[.。…⋯·]/g, '')
    .trim()
}

export function isSafeCopyMenuLabel(value: string): boolean {
  return ['复制', '拷贝', '复制图片', '拷贝图片', '复制图像', '拷贝图像', '复制视频', '拷贝视频', '复制文件', '拷贝文件', 'copy', 'copyimage', 'copyvideo', 'copyfile'].includes(value.toLowerCase())
}

export function isDangerousMenuLabel(value: string): boolean {
  return /^(引用|删除|多选|转发|收藏|提醒|编辑|另存为|保存|打开方式|delete|quote|forward|favorite|save|saveas)$/i.test(value)
}

function safeFileName(name: string): string {
  return path.basename(name || 'attachment')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ ._]+|[ ._]+$/g, '')
    || 'attachment'
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.mov') return 'video/quicktime'
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.txt') return 'text/plain'
  return 'application/octet-stream'
}

function extensionFromMimeType(mimeType: string): string | null {
  const normalized = mimeType.toLowerCase()
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/gif') return '.gif'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'video/mp4') return '.mp4'
  if (normalized === 'video/quicktime') return '.mov'
  if (normalized === 'application/pdf') return '.pdf'
  if (normalized === 'text/plain') return '.txt'
  return null
}

function normalizeExtension(value: string): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return ''
  return normalized.startsWith('.') ? normalized : `.${normalized}`
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function numberValue(value: unknown, key?: string): number | null {
  const source = key && value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : value
  const numeric = Number(source)
  return Number.isFinite(numeric) ? numeric : null
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function assertHelperOk(response: { ok: boolean; errorCode?: string; errorSummary?: string }, command: string): void {
  if (!response.ok) throw new Error(`${response.errorCode || 'helper_command_failed'}: ${response.errorSummary || command}`)
}
