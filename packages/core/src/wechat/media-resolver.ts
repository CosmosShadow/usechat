// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-media-resolver.test.ts

import crypto from 'node:crypto'
import path from 'node:path'
import { defaultUseChatDataDir } from '../config.js'
import type { ExternalMessageAttachment } from './types.js'
import type {
  WeChatChannelMediaAction,
  WeChatChannelMediaActionPlan,
} from './core/schema.js'
import type {
  WeChatChannelClipboardPayloadTrace,
  WeChatChannelMediaAttachmentValidationTrace,
  WeChatChannelMediaResolveAttemptTrace,
  WeChatChannelMediaResolveResult,
  WeChatChannelMediaResolveTrace,
  WeChatChannelMediaStabilityCheck,
  WeChatChannelMediaStabilityStage,
  WeChatChannelMenuSearchBounds,
  WeChatChannelOcrMenuCandidateTrace,
  WeChatChannelScreenCapture,
  WeChatChannelVisibleMediaCandidate,
} from './media-resolver-types.js'
import {
  assertHelperOk,
  createMediaResolveTrace,
  errorReasonCode,
  isDangerousMenuLabel,
  isSafeCopyMenuLabel,
  lastReasonCode,
  materializeClipboardAttachment,
  materializeLocalAttachment,
  menuLabelsForCandidate,
  metadataOnlyResult,
  normalizeAttachmentType,
  normalizeMenuText,
  numberValue,
  plannedAction,
  plannedCopyMenuLabel,
  recordMediaResolveAttempt,
  recordStabilityAttempt,
  resolveWindowsCacheFallback,
  rightClickPointsForCandidate,
  screenPointForBbox,
  sleep,
  stringValue,
  summarizeAttachmentValidation,
  summarizeClipboardPayload,
  uniqueReasonCodes,
  visibleMediaActionPlan,
  waitForClipboardAttachment,
} from './media-resolver-internals.js'
export { materializeLocalAttachment, metadataOnlyResult } from './media-resolver-internals.js'
export type {
  WeChatChannelClipboardPayloadTrace,
  WeChatChannelMediaAttachmentValidationTrace,
  WeChatChannelMediaResolveAttemptTrace,
  WeChatChannelMediaResolveResult,
  WeChatChannelMediaResolveTrace,
  WeChatChannelMediaStabilityCheck,
  WeChatChannelMediaStabilityStage,
  WeChatChannelOcrMenuCandidateTrace,
  WeChatChannelVisibleMediaCandidate,
} from './media-resolver-types.js'
import type { HelperTransport as WeChatChannelHelperTransport } from './runtime.js'
import { buildWeChatChannelMediaActionPlan } from './core/media-action-plan.js'

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

