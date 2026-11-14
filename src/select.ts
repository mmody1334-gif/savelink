import type { MediaItem, MediaResult } from './types'

export function qualityLabel(item: MediaItem): string {
  if (item.kind === 'audio') return (item.ext || 'mp3').toUpperCase()
  if (item.kind === 'image') return 'IMG'
  if (item.height) return `${item.height}p`
  if (item.label) return item.label
  return 'MP4'
}

export function humanSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded}${units[unit]}`
}

export function durationLabel(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * Telegram's inline keyboard has no room for 20 quality variants, so we keep
 * the best distinct video heights (plus one audio track and any photos).
 */
export function trimForTelegram(items: MediaItem[], maxVideos = 3): MediaItem[] {
  const videos = items
    .filter((item) => item.kind === 'video')
    .slice()
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))

  const picked: MediaItem[] = []
  const seenHeights = new Set<number>()
  for (const video of videos) {
    const height = video.height ?? 0
    if (seenHeights.has(height)) continue
    seenHeights.add(height)
    picked.push(video)
    if (picked.length >= maxVideos) break
  }

  const audio = items.find((item) => item.kind === 'audio')
  if (audio) picked.push(audio)

  const images = items.filter((item) => item.kind === 'image')
  if (images.length) picked.push(...images.slice(0, 10))

  return picked
}

export function pickForMode(items: MediaItem[], mode: 'video' | 'audio', quality: string): MediaItem | undefined {
  if (mode === 'audio') {
    return items.find((item) => item.kind === 'audio') ?? items.find((item) => item.kind === 'video')
  }
  const requested = quality === 'max' ? Infinity : Number(quality) || 720
  const videos = items
    .filter((item) => item.kind === 'video')
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
  if (!videos.length) return undefined
  return videos.find((item) => (item.height ?? 0) <= requested) ?? videos[videos.length - 1]
}

export function sanitizeFilename(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 64)
  return cleaned || 'savelink-media'
}

function defaultExt(item: MediaItem): string {
  if (item.kind === 'audio') return 'mp3'
  if (item.kind === 'image') return 'jpg'
  return 'mp4'
}

export function itemFilename(result: MediaResult, item: MediaItem): string {
  const base = sanitizeFilename(result.title || result.author || `${result.platform}-${result.engine}`)
  return `${base}.${(item.ext || defaultExt(item)).replace(/^\./, '')}`
}

export function shortKey(length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let out = ''
  for (const byte of bytes) out += alphabet[byte % alphabet.length]
  return out
}

export function cleanButtonText(str: string, maxLength = 28): string {
  if (!str) return ''
  const decoded = str
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#43;/g, '+')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const chars = Array.from(decoded)
  const sliced = chars.length <= maxLength ? decoded : chars.slice(0, maxLength).join('') + '…'
  return typeof (sliced as any).toWellFormed === 'function' ? (sliced as any).toWellFormed() : sliced
}
