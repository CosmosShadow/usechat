// @arch ../../../docs/ARCHITECTURE.md
// @arch ../../../docs/COPY_OUT_SOURCES.md
// @test src/__tests__/wechat-attachment.test.ts

import fs from 'node:fs'
import path from 'node:path'

export type UseChatAttachmentKind = 'image' | 'video' | 'file'

export type UseChatAttachmentPayload = {
  kind: UseChatAttachmentKind
  name: string
  mimeType: string
  size: number
  localPath: string
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
}

export const DEFAULT_USECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024

export function maxUseChatOutboundAttachmentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.USECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES ?? env.SHENNIAN_EXTERNAL_ATTACHMENT_MAX_BYTES ?? DEFAULT_USECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_USECHAT_OUTBOUND_ATTACHMENT_MAX_BYTES
}

export function readUseChatAttachment(
  filePath: string,
  kind: UseChatAttachmentKind,
  input: { env?: NodeJS.ProcessEnv } = {},
): UseChatAttachmentPayload {
  const absolutePath = path.resolve(expandHomePath(filePath))
  const stat = fs.statSync(absolutePath)
  if (!stat.isFile()) throw new Error(`Attachment is not a file: ${absolutePath}`)
  const maxBytes = maxUseChatOutboundAttachmentBytes(input.env)
  if (stat.size > maxBytes) {
    throw new Error(`Attachment is too large: ${stat.size} bytes. Max: ${maxBytes} bytes.`)
  }
  return {
    kind,
    name: path.basename(absolutePath),
    mimeType: inferMimeType(absolutePath, kind),
    size: stat.size,
    localPath: absolutePath,
  }
}

export function detectUseChatAttachmentKind(filePath: string): UseChatAttachmentKind {
  const ext = path.extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'].includes(ext)) return 'video'
  return 'file'
}

function inferMimeType(filePath: string, kind: UseChatAttachmentKind): string {
  const ext = path.extname(filePath).toLowerCase()
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext]
  if (kind === 'image') return 'image/jpeg'
  if (kind === 'video') return 'video/mp4'
  return 'application/octet-stream'
}

function expandHomePath(value: string): string {
  if (value === '~') return process.env.HOME || value
  if (value.startsWith('~/')) return path.join(process.env.HOME || '', value.slice(2))
  return value
}
