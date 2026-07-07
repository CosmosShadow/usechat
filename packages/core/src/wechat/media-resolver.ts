// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-media-resolver.test.ts

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defaultUseChatDataDir } from '../config.js'
import type { ExternalMessageAttachment } from './types.js'
import type { HelperTransport as WeChatChannelHelperTransport } from './runtime.js'
import { buildWeChatChannelMediaActionPlan } from './core/media-action-plan.js'
import {
  normalizeWeChatChannelMessageKind,
  type WeChatChannelMediaAction,
  type WeChatChannelMediaActionPlan,
} from './core/schema.js'
import {
  findCachedWeChatInboundMedia,
  type WeChatChannelMediaCacheScanTrace,
} from './media-cache-resolver.js'

export type WeChatChannelVisibleMediaCandidate = {
  messageKey: string
  kind: 'image' | 'video' | 'file' | 'link' | 'card' | string
  bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  screenshotBbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  downloadActionBbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } | null
  fileName?: string | null
  mimeType?: string | null
  size?: number | null
  mediaStatus?: 'available' | 'not_downloaded' | 'loading' | 'metadata_only' | 'unsupported' | string | null
  observedAt?: string | null
  contextText?: string | null
}

export type WeChatChannelMediaResolveResult = {
  messageKey: string
  attachment: ExternalMessageAttachment
  reasonCode: string
  attemptReasonCodes?: string[]
  resolveTrace?: WeChatChannelMediaResolveTrace
}

export type WeChatChannelMediaResolveTrace = {
  candidateKind: string
  bbox?: WeChatChannelVisibleMediaCandidate['bbox']
  downloadActionBbox?: WeChatChannelVisibleMediaCandidate['downloadActionBbox']
  mediaStatus?: WeChatChannelVisibleMediaCandidate['mediaStatus']
  actionPlan: {
    reasonCode: string
    actions: Array<{
      type: string
      reasonCode?: string
      label?: string
      target?: unknown
    }>
  }
  attempts: WeChatChannelMediaResolveAttemptTrace[]
  finalReasonCode?: string
  attachmentValidation?: WeChatChannelMediaAttachmentValidationTrace
}

export type WeChatChannelMediaResolveAttemptTrace = {
  phase: 'stability' | 'copy-before-download' | 'download-action' | 'copy-after-download' | 'cache-scan'
  stage?: WeChatChannelMediaStabilityStage
  retry?: boolean
  pointAttempt?: number
  pointRole?: 'center' | 'file-title' | 'file-body' | 'media-top-left' | 'media-top-right' | 'media-bottom-left' | 'media-bottom-right'
  ok?: boolean
  reasonCode?: string
  rightClickPoint?: { x: number; y: number; coordinateSpace?: string }
  menuSearchBounds?: WeChatChannelMenuSearchBounds
  menuPickOrder?: Array<'ocr-menu'>
  pickedMethod?: 'ocr-menu'
  pickedLabel?: string
  pickedPoint?: { x: number; y: number }
  ocrMenuCandidates?: WeChatChannelOcrMenuCandidateTrace[]
  disallowedLabels?: string[]
  clipboardChangeCountBefore?: number | null
  clipboardChangeCountAfter?: number | null
  clipboardPayload?: WeChatChannelClipboardPayloadTrace
  downloadPoint?: { x: number; y: number; coordinateSpace?: string }
  cacheScan?: WeChatChannelMediaCacheScanTrace
}

export type WeChatChannelOcrMenuCandidateTrace = {
  text: string
  normalizedText: string
  point?: { x: number; y: number }
  bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }
  exact?: boolean
  exactCopy?: boolean
  fuzzy?: boolean
  dangerous?: boolean
  selected?: boolean
}

export type WeChatChannelClipboardPayloadTrace = {
  changeCount?: number | null
  fileUrlCount: number
  filePathCount: number
  hasImageData: boolean
  imageDataBytes?: number
  mimeType?: string
  suggestedFileName?: string
  fileNames?: string[]
  extensions?: string[]
}

export type WeChatChannelMediaAttachmentValidationTrace = {
  availability?: ExternalMessageAttachment['availability']
  type?: string
  name?: string
  localPath?: string
  mimeType?: string
  extension?: string
  materializationKind?: ExternalMessageAttachment['materializationKind']
  isOriginal?: boolean
  mimeKindMatches?: boolean
}

export type WeChatChannelMediaStabilityStage = 'before-media-action' | 'after-media-action'

export type WeChatChannelMediaStabilityCheck = (input: {
  stage: WeChatChannelMediaStabilityStage
  candidate: WeChatChannelVisibleMediaCandidate
}) => Promise<{ ok: true } | { ok: false; reasonCode: string }> | { ok: true } | { ok: false; reasonCode: string }

type WeChatChannelMenuSearchBounds = {
  x: number
  y: number
  width: number
  height: number
  coordinateSpace?: string
}

type WeChatChannelScreenCapture = {
  mimeType?: string
  dataBase64?: string
  width?: number
  height?: number
  bounds?: WeChatChannelMenuSearchBounds
}

const MAX_INBOUND_ATTACHMENT_BYTES = 20 * 1024 * 1024
const DISALLOWED_COPY_MENU_LABELS = [
  '引用',
  '删除',
  '多选',
  '转发',
  '收藏',
  '提醒',
  '编辑',
  '保存',
  '另存为',
  '打开方式',
  'Quote',
  'Delete',
  'Forward',
  'Favorite',
  'Save',
  'Save As',
  'Save to Downloads',
  'Open With',
]

export function defaultWeChatChannelAttachmentDir(_workDir: string, runtimeId: string, bindingId: string): string {
  const key = crypto.createHash('sha256').update(`${runtimeId}:${bindingId}`).digest('hex').slice(0, 16)
  return path.join(defaultUseChatDataDir(), 'attachments', 'inbound', key)
}

export async function resolveVisibleWeChatChannelMedia(input: {
  helper: WeChatChannelHelperTransport
  candidates: WeChatChannelVisibleMediaCandidate[]
  attachmentsDir: string
  screenshot?: { mimeType: string; dataBase64: string; width: number; height: number }
  windowId?: string
  window?: { windowId: string; bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }
  traceId?: string
  stabilityCheck?: WeChatChannelMediaStabilityCheck
  platform?: NodeJS.Platform | string
  wechatCacheRoots?: string[]
}): Promise<WeChatChannelMediaResolveResult[]> {
  const results: WeChatChannelMediaResolveResult[] = []
  for (const candidate of input.candidates) {
    try {
      const actionPlan = visibleMediaActionPlan(candidate)
      const resolveTrace = createMediaResolveTrace(candidate, actionPlan)
      if (!actionPlan.actions.length) {
        results.push(metadataOnlyResult(candidate, actionPlan.reasonCode, resolveTrace))
        continue
      }
      const stableBefore = await runMediaStabilityCheck(input, 'before-media-action', candidate)
      recordStabilityAttempt(resolveTrace, 'before-media-action', stableBefore)
      if (!stableBefore.ok) {
        results.push(metadataOnlyResult(candidate, stableBefore.reasonCode, resolveTrace))
        continue
      }
      // 视频缓存阶段是一个跨轮的状态机，不是一次性动作。界面上只有下载按钮时，微信内部还
      // 没把视频缓存下来，右键菜单里根本没有“复制视频”，这一轮强行右键复制必然
      // menu_ocr_copy_not_found。所以按状态分流，每轮 observe 只推进一步：
      //   loading（转圈下载中）→ 纯等待，这一轮什么都不做，等下一轮。
      //   not_downloaded + 有下载按钮 → 点一次微信内部下载触发缓存，立即返回 pending，等下一轮。
      // 是否需要下载完全由这一轮的视觉判定（VLM）决定，不做任何跨轮指纹 / 计数：已下载的视频
      // 显示播放按钮、没有下载箭头，会判成 available 落到下面的右键复制，不会被反复点。
      // 等微信真正下完（下一轮 mediaStatus 变 available / downloadActionBbox 消失），gate 关闭，
      // 落到下面的右键复制把原件拷出来。
      const videoDownloadState = videoDownloadStage(candidate)
      if (videoDownloadState === 'loading') {
        results.push(metadataOnlyResult(candidate, 'download_in_progress_waiting', resolveTrace))
        continue
      }
      if (videoDownloadState === 'pending') {
        // Windows 缓存兜底放在触发下载之前先扫一遍：文件可能已落在缓存里（darwin 直接跳过，
        // 不做任何界面动作），命中就立即拿原件，避免无谓再点一次下载。
        const cached = resolveWindowsCacheFallback({
          candidate,
          attachmentsDir: input.attachmentsDir,
          resolveTrace,
          platform: input.platform,
          cacheRoots: input.wechatCacheRoots,
        })
        if (cached.attachment) {
          results.push(await finalizeResolvedMediaResult(input, {
            messageKey: candidate.messageKey,
            attachment: cached.attachment,
            reasonCode: cached.reasonCode || 'edge_local_from_wechat_cache',
            resolveTrace,
          }, candidate, resolveTrace))
          continue
        }
        const stableBeforeDownload = await runMediaStabilityCheck(input, 'before-media-action', candidate)
        recordStabilityAttempt(resolveTrace, 'before-media-action', stableBeforeDownload)
        if (!stableBeforeDownload.ok) {
          results.push({
            ...metadataOnlyResult(candidate, stableBeforeDownload.reasonCode, resolveTrace),
            ...(cached.reasonCode ? { attemptReasonCodes: uniqueReasonCodes([cached.reasonCode, stableBeforeDownload.reasonCode]) } : {}),
          })
          continue
        }
        const clicked = await clickVideoDownloadAffordance({
          helper: input.helper,
          candidate,
          resolveTrace,
          windowId: input.windowId,
          traceId: input.traceId,
        })
        const reasonCode = clicked.ok
          ? 'download_triggered_pending_next_observe'
          : (clicked.reasonCode || 'download_action_click_failed')
        const attemptReasonCodes = uniqueReasonCodes([cached.reasonCode, clicked.reasonCode])
        results.push({
          ...metadataOnlyResult(candidate, reasonCode, resolveTrace),
          ...(attemptReasonCodes.length ? { attemptReasonCodes } : {}),
        })
        continue
      }
      const attemptReasonCodes: string[] = []
      const copied = await copyVisibleMediaFromContextMenu({
        helper: input.helper,
        candidate,
        actionPlan,
        resolveTrace,
        attachmentsDir: input.attachmentsDir,
        windowId: input.windowId,
        window: input.window,
        menuSearchBounds: menuSearchBoundsForCandidate(candidate, input.window),
        traceId: input.traceId,
      })
      if (copied.attachment) {
        results.push(await finalizeResolvedMediaResult(input, {
          messageKey: candidate.messageKey,
          attachment: copied.attachment,
          reasonCode: 'edge_local',
          resolveTrace,
        }, candidate, resolveTrace))
        continue
      }
      attemptReasonCodes.push(...[copied.reasonCode].filter((value): value is string => Boolean(value)))
      const cached = resolveWindowsCacheFallback({
        candidate,
        attachmentsDir: input.attachmentsDir,
        resolveTrace,
        platform: input.platform,
        cacheRoots: input.wechatCacheRoots,
      })
      if (cached.attachment) {
        results.push(await finalizeResolvedMediaResult(input, {
          messageKey: candidate.messageKey,
          attachment: cached.attachment,
          reasonCode: cached.reasonCode || 'edge_local_from_wechat_cache',
          resolveTrace,
        }, candidate, resolveTrace, attemptReasonCodes))
        continue
      }
      if (cached.reasonCode) attemptReasonCodes.push(cached.reasonCode)
      results.push({
        ...metadataOnlyResult(candidate, lastReasonCode([...attemptReasonCodes, copied.reasonCode]) || 'clipboard_attachment_unavailable', resolveTrace),
        ...(attemptReasonCodes.length ? { attemptReasonCodes: uniqueReasonCodes(attemptReasonCodes) } : {}),
      })
    } catch (error) {
      results.push(metadataOnlyResult(candidate, errorReasonCode(error), createMediaResolveTrace(candidate, visibleMediaActionPlan(candidate))))
    }
  }
  return results
}

// 视频下载状态机的当前阶段：
//   'loading'  — 微信正在下载（转圈中），这一轮纯等待。
//   'pending'  — 还没下载、界面上有可点的下载按钮，这一轮点一次触发下载。
//   null       — 不是缓存阶段的视频（已下载 / 不是视频 / 没有下载按钮），走常规右键复制。
function videoDownloadStage(candidate: WeChatChannelVisibleMediaCandidate): 'loading' | 'pending' | null {
  if (normalizeAttachmentType(candidate.kind) !== 'video') return null
  const status = String(candidate.mediaStatus || '').trim().toLowerCase().replace(/-/g, '_')
  if (status === 'loading' || status === 'downloading' || status === 'in_progress') return 'loading'
  if (!candidate.downloadActionBbox) return null
  if (status === 'not_downloaded' || status === 'pending_download') return 'pending'
  return null
}

async function clickVideoDownloadAffordance(input: {
  helper: WeChatChannelHelperTransport
  candidate: WeChatChannelVisibleMediaCandidate
  resolveTrace?: WeChatChannelMediaResolveTrace
  windowId?: string
  traceId?: string
}): Promise<{ ok: boolean; reasonCode?: string }> {
  const bbox = input.candidate.downloadActionBbox
  if (!bbox) return { ok: false, reasonCode: 'download_action_bbox_missing' }
  const point = {
    x: bbox.x + bbox.width / 2,
    y: bbox.y + bbox.height / 2,
    coordinateSpace: bbox.coordinateSpace,
  }
  const click = await input.helper.request('mouse.click', {
    x: point.x,
    y: point.y,
    coordinateSpace: point.coordinateSpace,
    windowId: input.windowId,
  }, input.traceId)
  const ok = click.ok === true
  const reasonCode = ok ? 'clicked_video_download_affordance' : click.errorCode || 'download_action_click_failed'
  if (input.resolveTrace) {
    recordMediaResolveAttempt(input.resolveTrace, {
      phase: 'download-action',
      ok,
      reasonCode: ok ? undefined : reasonCode,
      downloadPoint: point,
    })
  }
  return { ok, reasonCode }
}

async function runMediaStabilityCheck(
  input: { stabilityCheck?: WeChatChannelMediaStabilityCheck },
  stage: WeChatChannelMediaStabilityStage,
  candidate: WeChatChannelVisibleMediaCandidate,
): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
  if (!input.stabilityCheck) return { ok: true }
  const maxAttempts = stage === 'after-media-action' ? 2 : 1
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await input.stabilityCheck({ stage, candidate })
      if (result.ok) return result
      if (result.reasonCode === 'conversation_title_not_confirmed' && attempt + 1 < maxAttempts) {
        await sleep(350)
        continue
      }
      return { ok: false, reasonCode: result.reasonCode || 'media_window_unstable' }
    } catch (error) {
      const reasonCode = errorReasonCode(error)
      if (reasonCode === 'conversation_title_not_confirmed' && attempt + 1 < maxAttempts) {
        await sleep(350)
        continue
      }
      return { ok: false, reasonCode }
    }
  }
  return { ok: false, reasonCode: 'media_window_unstable' }
}

async function finalizeResolvedMediaResult(
  input: { stabilityCheck?: WeChatChannelMediaStabilityCheck },
  result: WeChatChannelMediaResolveResult,
  candidate: WeChatChannelVisibleMediaCandidate,
  resolveTrace?: WeChatChannelMediaResolveTrace,
  attemptReasonCodes: string[] = [],
): Promise<WeChatChannelMediaResolveResult> {
  const stableAfter = await runMediaStabilityCheck(input, 'after-media-action', candidate)
  if (resolveTrace) recordStabilityAttempt(resolveTrace, 'after-media-action', stableAfter)
  if (stableAfter.ok) {
    if (resolveTrace) {
      resolveTrace.finalReasonCode = result.reasonCode
      resolveTrace.attachmentValidation = summarizeAttachmentValidation(result.attachment)
    }
    return attemptReasonCodes.length
      ? { ...result, attemptReasonCodes: uniqueReasonCodes(attemptReasonCodes), ...(resolveTrace ? { resolveTrace } : {}) }
      : { ...result, ...(resolveTrace ? { resolveTrace } : {}) }
  }
  const metadata = metadataOnlyResult(candidate, stableAfter.reasonCode, resolveTrace)
  return {
    ...metadata,
    attemptReasonCodes: uniqueReasonCodes([...attemptReasonCodes, result.reasonCode, stableAfter.reasonCode]),
  }
}

async function copyVisibleMediaFromContextMenu(input: {
  helper: WeChatChannelHelperTransport
  candidate: WeChatChannelVisibleMediaCandidate
  actionPlan: WeChatChannelMediaActionPlan
  resolveTrace?: WeChatChannelMediaResolveTrace
  retry?: boolean
  attachmentsDir: string
  windowId?: string
  window?: { windowId: string; bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }
  menuSearchBounds?: WeChatChannelMenuSearchBounds
  traceId?: string
}): Promise<{ attachment: ExternalMessageAttachment | null; reasonCode?: string }> {
  let snapshot: Awaited<ReturnType<WeChatChannelHelperTransport['request']>> | null = null
  try {
    snapshot = await input.helper.request('clipboard.snapshot', {}, input.traceId)
    assertHelperOk(snapshot, 'clipboard.snapshot')
    const clipboardChangeCountBefore = numberValue(snapshot.result, 'changeCount')
    const target = plannedAction(input.actionPlan, 'right-click-media', input.retry ? 1 : 0)?.target
      ?? input.candidate.bbox
    if (!target) return { attachment: null, reasonCode: 'media_bbox_missing' }
    const labels = menuLabelsForCandidate(input.candidate, plannedCopyMenuLabel(input.actionPlan, input.retry))
    const points = rightClickPointsForCandidate(input.candidate, target, Boolean(input.window?.bounds))
    let lastReasonCode: string | undefined
    for (const [index, point] of points.entries()) {
      if (index > 0) await dismissContextMenu(input.helper, input.traceId)
      if (input.resolveTrace) {
        recordMediaResolveAttempt(input.resolveTrace, {
          phase: input.retry ? 'copy-after-download' : 'copy-before-download',
          retry: Boolean(input.retry),
          pointAttempt: index + 1,
          pointRole: point.role,
          rightClickPoint: point,
          menuSearchBounds: input.menuSearchBounds,
          menuPickOrder: ['ocr-menu'],
          clipboardChangeCountBefore,
        })
      }
      const rightClick = await input.helper.request('mouse.rightClick', {
        x: point.x,
        y: point.y,
        coordinateSpace: point.coordinateSpace,
        windowId: input.windowId,
      }, input.traceId)
      if (!rightClick.ok) {
        lastReasonCode = rightClick.errorCode || 'media_right_click_failed'
        if (input.resolveTrace) {
          recordMediaResolveAttempt(input.resolveTrace, {
            phase: input.retry ? 'copy-after-download' : 'copy-before-download',
            retry: Boolean(input.retry),
            pointAttempt: index + 1,
            pointRole: point.role,
            rightClickPoint: point,
            menuSearchBounds: input.menuSearchBounds,
            menuPickOrder: ['ocr-menu'],
            clipboardChangeCountBefore,
            ok: false,
            reasonCode: lastReasonCode,
          })
        }
        continue
      }
      await sleep(180)
      const picked = await pickCopyMenuItemByOcr({
        helper: input.helper,
        labels,
        point,
        windowId: input.windowId,
        window: input.window,
        menuSearchBounds: input.menuSearchBounds,
        traceId: input.traceId,
      })
      if (input.resolveTrace) {
        recordMediaResolveAttempt(input.resolveTrace, {
          phase: input.retry ? 'copy-after-download' : 'copy-before-download',
          retry: Boolean(input.retry),
          pointAttempt: index + 1,
          pointRole: point.role,
          ok: picked.ok,
          reasonCode: picked.ok ? undefined : picked.reasonCode,
          rightClickPoint: point,
          menuSearchBounds: input.menuSearchBounds,
          menuPickOrder: ['ocr-menu'],
          pickedMethod: picked.ok ? 'ocr-menu' : undefined,
          pickedLabel: picked.ok ? picked.label : undefined,
          pickedPoint: picked.ok ? picked.point : undefined,
          ocrMenuCandidates: picked.ocrMenuCandidates,
          disallowedLabels: DISALLOWED_COPY_MENU_LABELS,
          clipboardChangeCountBefore,
        })
      }
      if (!picked.ok) {
        lastReasonCode = picked.reasonCode
        continue
      }
      const clipboard = await waitForClipboardAttachment({
        helper: input.helper,
        beforeChangeCount: clipboardChangeCountBefore,
        candidate: input.candidate,
        traceId: input.traceId,
      })
      if (input.resolveTrace) {
        recordMediaResolveAttempt(input.resolveTrace, {
          phase: input.retry ? 'copy-after-download' : 'copy-before-download',
          retry: Boolean(input.retry),
          pointAttempt: index + 1,
          pointRole: point.role,
          ok: Boolean(clipboard.result),
          reasonCode: clipboard.reasonCode,
          rightClickPoint: point,
          menuSearchBounds: input.menuSearchBounds,
          menuPickOrder: ['ocr-menu'],
          pickedMethod: 'ocr-menu',
          pickedLabel: picked.label,
          pickedPoint: picked.point,
          ocrMenuCandidates: picked.ocrMenuCandidates,
          disallowedLabels: DISALLOWED_COPY_MENU_LABELS,
          clipboardChangeCountBefore,
          clipboardChangeCountAfter: clipboard.lastChangeCount ?? numberValue(clipboard.result, 'changeCount'),
          clipboardPayload: summarizeClipboardPayload(clipboard.result),
        })
      }
      const attachment = materializeClipboardAttachment(input.candidate, clipboard.result, input.attachmentsDir)
      if (attachment && input.resolveTrace) {
        input.resolveTrace.attachmentValidation = summarizeAttachmentValidation(attachment)
      }
      if (attachment) {
        return {
          attachment,
          reasonCode: clipboard.reasonCode,
        }
      }
      if (
        normalizeAttachmentType(input.candidate.kind) === 'image'
        && clipboard.reasonCode === 'clipboard_attachment_unavailable'
        && index + 1 < points.length
      ) {
        lastReasonCode = clipboard.reasonCode
        continue
      }
      return {
        attachment: null,
        reasonCode: clipboard.reasonCode || 'clipboard_attachment_unavailable',
      }
    }
    return { attachment: null, reasonCode: lastReasonCode || 'menu_ocr_copy_not_found' }
  } catch (error) {
    if (input.resolveTrace) {
      recordMediaResolveAttempt(input.resolveTrace, {
        phase: input.retry ? 'copy-after-download' : 'copy-before-download',
        retry: Boolean(input.retry),
        ok: false,
        reasonCode: errorReasonCode(error),
      })
    }
    return { attachment: null, reasonCode: errorReasonCode(error) }
  } finally {
    try {
      if (snapshot) {
        await input.helper.request(
          'clipboard.restore',
          snapshot.result && typeof snapshot.result === 'object' ? snapshot.result as Record<string, unknown> : {},
          input.traceId,
        )
      }
    } catch {
      // Restoring the previous clipboard state must not turn a resolved media item into a failed observe round.
    }
  }
}

async function dismissContextMenu(helper: WeChatChannelHelperTransport, traceId?: string): Promise<void> {
  try {
    await helper.request('keyboard.shortcut', { key: 'escape', modifiers: [] }, traceId)
  } catch {
    // Best-effort only: the menu may already be closed after a failed or successful menu action.
  }
}

async function pickCopyMenuItemByOcr(input: {
  helper: WeChatChannelHelperTransport
  labels: string[]
  point: { x: number; y: number; coordinateSpace?: string }
  windowId?: string
  window?: { windowId: string; bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }
  menuSearchBounds?: WeChatChannelMenuSearchBounds
  traceId?: string
}): Promise<{ ok: true; method: 'ocr-menu'; label?: string; point: { x: number; y: number }; ocrMenuCandidates: WeChatChannelOcrMenuCandidateTrace[] } | { ok: false; reasonCode: string; reason: string; ocrMenuCandidates?: WeChatChannelOcrMenuCandidateTrace[] }> {
  const capture = await captureMenuForOcr(input)
  if (!capture.ok) return capture
  const result = capture.capture
  if (!result.dataBase64 || !result.width || !result.height) {
    return { ok: false, reasonCode: 'menu_ocr_capture_failed', reason: 'cannot capture menu' }
  }
  const ocr = await input.helper.request<{ blocks?: Array<{ text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }; confidence?: number }> }>('ocr.recognize', {
    mimeType: result.mimeType || 'image/png',
    dataBase64: result.dataBase64,
    width: result.width,
    height: result.height,
  }, input.traceId)
  if (!ocr.ok) return { ok: false, reasonCode: ocr.errorCode || 'menu_ocr_failed', reason: ocr.errorSummary || 'menu OCR failed' }
  const match = selectOcrMenuCandidate({
    blocks: ocr.result?.blocks ?? [],
    labels: input.labels,
    point: input.point,
    screenshot: {
      width: Number(result.width),
      height: Number(result.height),
    },
    screenBounds: result.bounds,
    window: capture.coordinateSpace === 'window' ? input.window : undefined,
  })
  if (!match) {
    return {
      ok: false,
      reasonCode: 'menu_ocr_copy_not_found',
      reason: 'copy menu text not found near attachment',
      ocrMenuCandidates: selectionCandidatesForTrace({
        blocks: ocr.result?.blocks ?? [],
        labels: input.labels,
        point: input.point,
        screenshot: {
          width: Number(result.width),
          height: Number(result.height),
        },
        screenBounds: result.bounds,
        window: capture.coordinateSpace === 'window' ? input.window : undefined,
      }),
    }
  }
  const click = await input.helper.request('mouse.click', {
    x: Math.round(match.point.x),
    y: Math.round(match.point.y),
    coordinateSpace: 'screen',
    windowId: input.windowId,
  }, input.traceId)
  if (!click.ok) return { ok: false, reasonCode: click.errorCode || 'menu_ocr_click_failed', reason: click.errorSummary || 'cannot click OCR menu item', ocrMenuCandidates: match.candidates }
  return { ok: true, method: 'ocr-menu', label: match.text, point: match.point, ocrMenuCandidates: match.candidates }
}

async function captureMenuForOcr(input: {
  helper: WeChatChannelHelperTransport
  windowId?: string
  menuSearchBounds?: WeChatChannelMenuSearchBounds
  traceId?: string
}): Promise<
  | { ok: true; capture: WeChatChannelScreenCapture; coordinateSpace: 'screen' | 'window' }
  | { ok: false; reasonCode: string; reason: string }
> {
  if (input.menuSearchBounds) {
    const capture = await input.helper.request<WeChatChannelScreenCapture>('screen.capture', {
      bounds: input.menuSearchBounds,
    }, input.traceId)
    if (capture.ok && capture.result?.dataBase64 && capture.result.width && capture.result.height) {
      return {
        ok: true,
        capture: {
          ...capture.result,
          bounds: capture.result.bounds ?? input.menuSearchBounds,
        },
        coordinateSpace: 'screen',
      }
    }
    if (capture.errorCode && capture.errorCode !== 'helper_unknown_command') {
      return { ok: false, reasonCode: capture.errorCode || 'menu_ocr_capture_failed', reason: capture.errorSummary || 'cannot capture menu' }
    }
  }

  if (!input.windowId) return { ok: false, reasonCode: 'window_id_missing', reason: 'window id is required for OCR menu fallback' }
  const capture = await input.helper.request<WeChatChannelScreenCapture>('windows.capture', {
    windowId: input.windowId,
    scope: 'full-window',
  }, input.traceId)
  if (!capture.ok || !capture.result?.dataBase64 || !capture.result.width || !capture.result.height) {
    return { ok: false, reasonCode: capture.errorCode || 'menu_ocr_capture_failed', reason: capture.errorSummary || 'cannot capture menu' }
  }
  return { ok: true, capture: capture.result, coordinateSpace: 'window' }
}

function selectOcrMenuCandidate(input: {
  blocks: Array<{ text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }; confidence?: number }>
  labels: string[]
  point: { x: number; y: number }
  screenshot: { width: number; height: number }
  screenBounds?: WeChatChannelMenuSearchBounds
  window?: { bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }
}): { text: string; point: { x: number; y: number }; candidates: WeChatChannelOcrMenuCandidateTrace[] } | null {
  const labels = input.labels.map(normalizeMenuText).filter(Boolean)
  const exactCopyLabels = new Set(labels.filter(isSafeCopyMenuLabel))
  type OcrMenuSelectionCandidate = Required<Pick<WeChatChannelOcrMenuCandidateTrace, 'text' | 'normalizedText' | 'point'>> & WeChatChannelOcrMenuCandidateTrace & { distance: number }
  const candidates: OcrMenuSelectionCandidate[] = []
  for (const block of input.blocks) {
    const text = stringValue(block.text)
    const normalizedText = normalizeMenuText(text)
    const point = screenPointForBbox(block.bbox, input.screenshot, input.window, input.screenBounds)
    if (!text || !normalizedText || !point) continue
    if (isDangerousMenuLabel(normalizedText)) continue
    const exact = labels.includes(normalizedText)
    const exactCopy = exactCopyLabels.has(normalizedText)
    const fuzzy = !exactCopyLabels.size && labels.some((label) => normalizedText.includes(label) || label.includes(normalizedText))
    if (!exact && !fuzzy) continue
    if (point.x < input.point.x - 260 || point.x > input.point.x + 360) continue
    if (point.y < input.point.y - 420 || point.y > input.point.y + 520) continue
    candidates.push({
      text,
      normalizedText,
      point,
      ...(block.bbox ? { bbox: block.bbox } : {}),
      exact,
      exactCopy,
      fuzzy,
      dangerous: false,
      distance: Math.hypot(point.x - input.point.x, point.y - input.point.y),
    })
  }
  candidates.sort((a, b) => Number(b.exactCopy) - Number(a.exactCopy) || Number(b.exact) - Number(a.exact) || a.point.y - b.point.y || a.distance - b.distance)
  const selected = candidates[0]
  return selected
    ? {
        text: selected.text,
        point: selected.point,
        candidates: candidates.map((candidate) => ({
          text: candidate.text,
          normalizedText: candidate.normalizedText,
          point: candidate.point,
          ...(candidate.bbox ? { bbox: candidate.bbox } : {}),
          exact: candidate.exact,
          exactCopy: candidate.exactCopy,
          fuzzy: candidate.fuzzy,
          dangerous: candidate.dangerous,
          selected: candidate === selected,
        })),
      }
    : null
}

function selectionCandidatesForTrace(input: {
  blocks: Array<{ text?: string; bbox?: { x: number; y: number; width: number; height: number; coordinateSpace?: string }; confidence?: number }>
  labels: string[]
  point: { x: number; y: number }
  screenshot: { width: number; height: number }
  screenBounds?: WeChatChannelMenuSearchBounds
  window?: { bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } }
}): WeChatChannelOcrMenuCandidateTrace[] {
  const labels = input.labels.map(normalizeMenuText).filter(Boolean)
  const exactCopyLabels = new Set(labels.filter(isSafeCopyMenuLabel))
  const candidates: WeChatChannelOcrMenuCandidateTrace[] = []
  for (const block of input.blocks) {
    const text = stringValue(block.text)
    const normalizedText = normalizeMenuText(text)
    const point = screenPointForBbox(block.bbox, input.screenshot, input.window, input.screenBounds)
    if (!text || !normalizedText) continue
    const exact = labels.includes(normalizedText)
    const exactCopy = exactCopyLabels.has(normalizedText)
    const fuzzy = !exactCopyLabels.size && labels.some((label) => normalizedText.includes(label) || label.includes(normalizedText))
    const dangerous = isDangerousMenuLabel(normalizedText)
    const nearby = point
      ? point.x >= input.point.x - 260
        && point.x <= input.point.x + 360
        && point.y >= input.point.y - 420
        && point.y <= input.point.y + 520
      : false
    if (!nearby && !exact && !fuzzy && !dangerous) continue
    candidates.push({
      text,
      normalizedText,
      ...(point ? { point } : {}),
      ...(block.bbox ? { bbox: block.bbox } : {}),
      exact,
      exactCopy,
      fuzzy,
      dangerous,
    })
    if (candidates.length >= 24) break
  }
  return candidates
}

function menuSearchBoundsForCandidate(
  candidate: WeChatChannelVisibleMediaCandidate,
  window?: { bounds?: { x: number; y: number; width: number; height: number; coordinateSpace?: string } },
): WeChatChannelMenuSearchBounds | undefined {
  const bbox = candidate.bbox
  const windowBounds = window?.bounds
  if (!bbox || !windowBounds) return undefined
  const x = bbox.coordinateSpace === 'screen' ? bbox.x : windowBounds.x + bbox.x
  const y = bbox.coordinateSpace === 'screen' ? bbox.y : windowBounds.y + bbox.y
  if (![x, y, bbox.width, bbox.height].every(Number.isFinite)) return undefined
  const width = Math.min(640, Math.max(360, Math.ceil(bbox.width + 260)))
  const height = Math.min(Math.max(760, Math.ceil(bbox.height + 620)), Math.ceil(windowBounds.height + 260))
  return {
    x: Math.max(0, Math.floor(x - 140)),
    y: Math.max(0, Math.floor(y - Math.max(360, Math.ceil(height / 2)))),
    width,
    height,
    coordinateSpace: 'screen',
  }
}

type ClipboardAttachmentPayload = {
  fileUrls?: string[]
  filePaths?: string[]
  dataBase64?: string
  mimeType?: string
  suggestedFileName?: string
  changeCount?: number
}

async function waitForClipboardAttachment(input: {
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

function materializeClipboardAttachment(
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

function createMediaResolveTrace(
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

function recordStabilityAttempt(
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

function recordMediaResolveAttempt(trace: WeChatChannelMediaResolveTrace, attempt: WeChatChannelMediaResolveAttemptTrace): void {
  trace.attempts.push({
    ...attempt,
    ...(attempt.menuPickOrder ? { menuPickOrder: [...attempt.menuPickOrder] } : {}),
    ...(attempt.disallowedLabels ? { disallowedLabels: [...attempt.disallowedLabels] } : {}),
  })
}

function summarizeClipboardPayload(payload: ClipboardAttachmentPayload | undefined): WeChatChannelClipboardPayloadTrace {
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

function resolveWindowsCacheFallback(input: {
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

function summarizeAttachmentValidation(attachment: ExternalMessageAttachment | null | undefined): WeChatChannelMediaAttachmentValidationTrace | undefined {
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

function lastReasonCode(values: Array<string | undefined>): string | undefined {
  const filtered = values.filter((value): value is string => Boolean(value))
  return filtered[filtered.length - 1]
}

function visibleMediaActionPlan(candidate: WeChatChannelVisibleMediaCandidate): WeChatChannelMediaActionPlan {
  return buildWeChatChannelMediaActionPlan({
    ...candidate,
    kind: normalizeWeChatChannelMessageKind(candidate.kind),
  })
}

function uniqueReasonCodes(values: Array<string | undefined>): string[] {
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

function plannedAction(
  plan: WeChatChannelMediaActionPlan,
  type: WeChatChannelMediaAction['type'],
  occurrence = 0,
): WeChatChannelMediaAction | undefined {
  return plan.actions.filter((action) => action.type === type)[occurrence]
}

function plannedCopyMenuLabel(plan: WeChatChannelMediaActionPlan, retry?: boolean): string | undefined {
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

function normalizeAttachmentType(kind: string): ExternalMessageAttachment['type'] {
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

function menuLabelsForCandidate(candidate: WeChatChannelVisibleMediaCandidate, plannedLabel?: string): string[] {
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

function errorReasonCode(error: unknown): string {
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

function rightClickPointsForCandidate(
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

function screenPointForBbox(
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

function normalizeMenuText(value: unknown): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[.。…⋯·]/g, '')
    .trim()
}

function isSafeCopyMenuLabel(value: string): boolean {
  return ['复制', '拷贝', '复制图片', '拷贝图片', '复制图像', '拷贝图像', '复制视频', '拷贝视频', '复制文件', '拷贝文件', 'copy', 'copyimage', 'copyvideo', 'copyfile'].includes(value.toLowerCase())
}

function isDangerousMenuLabel(value: string): boolean {
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

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown, key?: string): number | null {
  const source = key && value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : value
  const numeric = Number(source)
  return Number.isFinite(numeric) ? numeric : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertHelperOk(response: { ok: boolean; errorCode?: string; errorSummary?: string }, command: string): void {
  if (!response.ok) throw new Error(`${response.errorCode || 'helper_command_failed'}: ${response.errorSummary || command}`)
}
