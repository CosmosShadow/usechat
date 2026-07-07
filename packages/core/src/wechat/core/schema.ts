// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-core-schema.test.ts

export const WECHAT_CHANNEL_MESSAGE_KINDS = [
  'text',
  'image',
  'file',
  'video-file',
  'video-card',
  'link-card',
  'official-account-card',
  'mini-program-card',
  'system',
  'recall',
  'unknown',
] as const

export type WeChatChannelMessageKind = typeof WECHAT_CHANNEL_MESSAGE_KINDS[number]

export const WECHAT_CHANNEL_ATTACHMENT_AVAILABILITIES = [
  'edge-local',
  'edge-preview',
  'pending-download',
  'metadata-only',
  'unsupported',
  'failed',
] as const

export type WeChatChannelAttachmentAvailability = typeof WECHAT_CHANNEL_ATTACHMENT_AVAILABILITIES[number]

export const WECHAT_CHANNEL_MEDIA_ACTION_TYPES = [
  'click-download',
  'right-click-media',
  'ocr-click-menu-item',
  'materialize-clipboard',
  'materialize-preview',
  'postprocess-file',
] as const

export type WeChatChannelMediaActionType = typeof WECHAT_CHANNEL_MEDIA_ACTION_TYPES[number]

export const WECHAT_CHANNEL_TRACE_PHASES = [
  'preflight',
  'open_conversation',
  'confirm_title',
  'capture_window',
  'structure_window_request',
  'structure_window_response',
  'normalize_messages',
  'validate_messages',
  'ledger_diff',
  'media_plan',
  'media_resolve_attempt',
  'media_materialize',
  'media_postprocess',
  'session_ingest',
  'run_summary',
] as const

export type WeChatChannelTracePhase = typeof WECHAT_CHANNEL_TRACE_PHASES[number]

export type WeChatChannelRect = {
  x: number
  y: number
  width: number
  height: number
  coordinateSpace?: string
}

export type WeChatChannelMediaCandidate = {
  messageKey: string
  kind: WeChatChannelMessageKind
  bbox?: WeChatChannelRect
  screenshotBbox?: WeChatChannelRect
  downloadActionBbox?: WeChatChannelRect | null
  fileName?: string | null
  mimeType?: string | null
  size?: number | null
  mediaStatus?: string | null
}

export type WeChatChannelAttachmentDescriptor = {
  type: 'image' | 'video' | 'file' | string
  name?: string
  mimeType?: string
  sizeBytes?: number
  extension?: string
  localPath?: string
  sha256?: string
  availability: WeChatChannelAttachmentAvailability
  providerError?: string
  sourceAction?: WeChatChannelMediaActionType
  materializationKind?: 'original-file' | 'clipboard-image' | 'preview-crop' | 'metadata'
  isOriginal?: boolean
  mimeKindMatches?: boolean
}

export type WeChatChannelMediaAction = {
  type: WeChatChannelMediaActionType
  target?: WeChatChannelRect
  label?: string
  reasonCode?: string
}

export type WeChatChannelMediaActionPlan = {
  messageKey: string
  kind: WeChatChannelMessageKind
  actions: WeChatChannelMediaAction[]
  reasonCode: string
}

export type WeChatChannelTraceEvent = {
  traceId: string
  phase: WeChatChannelTracePhase
  status: 'ok' | 'pending' | 'failed' | 'skipped'
  reasonCode?: string
  latencyMs?: number
  inputHash?: string
  outputHash?: string
}

const KIND_ALIASES: Record<string, WeChatChannelMessageKind> = {
  photo: 'image',
  picture: 'image',
  img: 'image',
  emoji: 'text',
  video: 'video-file',
  video_file: 'video-file',
  video_card: 'video-card',
  document: 'file',
  'document-card': 'file',
  filecard: 'file',
  'file-card': 'file',
  link: 'link-card',
  link_card: 'link-card',
  card: 'link-card',
  official: 'official-account-card',
  'official-account': 'official-account-card',
  official_account_card: 'official-account-card',
  miniprogram: 'mini-program-card',
  'mini-program': 'mini-program-card',
  mini_program_card: 'mini-program-card',
}

const AVAILABILITY_ALIASES: Record<string, WeChatChannelAttachmentAvailability> = {
  available: 'edge-local',
  downloaded: 'edge-local',
  local: 'edge-local',
  preview: 'edge-preview',
  edge_preview: 'edge-preview',
  pending: 'pending-download',
  pending_download: 'pending-download',
  not_downloaded: 'pending-download',
  metadata: 'metadata-only',
  metadata_only: 'metadata-only',
  unavailable: 'failed',
  'unavailable-large': 'failed',
  unavailable_large: 'failed',
  error: 'failed',
}

export function normalizeWeChatChannelMessageKind(value: unknown): WeChatChannelMessageKind {
  const normalized = normalizeToken(value)
  if (!normalized) return 'unknown'
  const direct = WECHAT_CHANNEL_MESSAGE_KINDS.find((kind) => kind === normalized)
  if (direct) return direct
  return KIND_ALIASES[normalized] ?? 'unknown'
}

export function isWeChatChannelMessageKind(value: unknown): value is WeChatChannelMessageKind {
  return WECHAT_CHANNEL_MESSAGE_KINDS.includes(value as WeChatChannelMessageKind)
}

export function normalizeWeChatChannelAttachmentAvailability(value: unknown): WeChatChannelAttachmentAvailability {
  const normalized = normalizeToken(value)
  if (!normalized) return 'metadata-only'
  const direct = WECHAT_CHANNEL_ATTACHMENT_AVAILABILITIES.find((availability) => availability === normalized)
  if (direct) return direct
  return AVAILABILITY_ALIASES[normalized] ?? 'metadata-only'
}

export function isWeChatChannelAttachmentAvailability(value: unknown): value is WeChatChannelAttachmentAvailability {
  return WECHAT_CHANNEL_ATTACHMENT_AVAILABILITIES.includes(value as WeChatChannelAttachmentAvailability)
}

export function isWeChatChannelTracePhase(value: unknown): value is WeChatChannelTracePhase {
  return WECHAT_CHANNEL_TRACE_PHASES.includes(value as WeChatChannelTracePhase)
}

function normalizeToken(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
}
