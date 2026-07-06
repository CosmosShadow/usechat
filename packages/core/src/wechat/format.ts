// @arch ../../../docs/ARCHITECTURE.md
// @test src/__tests__/wechat-format.test.ts

import type { WeChatObservedMessage } from './types.js'

export function formatWeChatMessagesMarkdown(messages: WeChatObservedMessage[]): string {
  if (!messages.length) return '_没有读取到当前可见消息。_\n'
  return `${messages.map(formatOneMessage).join('\n')}\n`
}

export function applyMessageLimit(messages: WeChatObservedMessage[], limit?: number): WeChatObservedMessage[] {
  if (!limit || limit <= 0) return messages
  return messages.slice(Math.max(0, messages.length - limit))
}

function formatOneMessage(message: WeChatObservedMessage): string {
  const sender = displaySender(message)
  const text = displayText(message)
  return `${sender}: ${text}`
}

function displaySender(message: WeChatObservedMessage): string {
  if (message.senderRole === 'self') return '我'
  if (message.senderRole === 'system') return '系统'
  return message.senderName?.trim() || (message.senderRole === 'contact' ? '对方' : '未知')
}

function displayText(message: WeChatObservedMessage): string {
  const text = message.normalizedText ?? message.textExcerpt ?? message.anchorText
  if (text?.trim()) return text.trim()
  if (message.kind === 'image') return '[图片]'
  if (message.kind === 'file') return '[文件]'
  if (message.kind === 'video-file' || message.kind === 'video-card') return '[视频]'
  if (message.kind === 'link-card') return '[链接卡片]'
  return `[${message.kind || '未知消息'}]`
}
