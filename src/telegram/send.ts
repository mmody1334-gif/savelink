import { DESKTOP_UA, httpFetch } from '../http'
import type { MediaItem } from '../types'
import type { MultipartFile, TelegramApi } from './api'

export class UploadTooLarge extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
  ) {
    super('file too large for Telegram')
    this.name = 'UploadTooLarge'
  }
}

export interface SendOptions {
  caption?: string
  filename: string
  maxBytes: number
  timeoutMs?: number
}

/** Downloads an item through the Worker, enforcing the Telegram upload cap. */
async function downloadItem(item: MediaItem, maxBytes: number, timeoutMs = 90_000): Promise<Blob> {
  const headers: Record<string, string> = { 'User-Agent': DESKTOP_UA, Accept: '*/*' }
  if (item.referer) headers.Referer = item.referer

  const response = await httpFetch(item.url, { headers }, timeoutMs)
  if (!response.ok) throw new Error(`CDN responded HTTP ${response.status}`)

  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new UploadTooLarge(declared, maxBytes)
  }

  const blob = await response.blob()
  if (blob.size > maxBytes) throw new UploadTooLarge(blob.size, maxBytes)
  return blob
}

/**
 * Downloads the CDN file through the Worker and uploads it to Telegram as a
 * real file, so streamed/expiring CDN URLs never reach the user.
 */
export async function sendMedia(
  tg: TelegramApi,
  chatId: number | string,
  item: MediaItem,
  options: SendOptions,
): Promise<void> {
  const blob = await downloadItem(item, options.maxBytes, options.timeoutMs)

  const isAudio = item.kind === 'audio'
  const isImage = item.kind === 'image'
  const method = isAudio ? 'sendAudio' : isImage ? 'sendPhoto' : 'sendVideo'
  const field = isAudio ? 'audio' : isImage ? 'photo' : 'video'

  const body: Record<string, unknown> = {
    chat_id: chatId,
    [field]: blob,
    caption: options.caption?.slice(0, 1024),
    parse_mode: 'HTML',
  }
  if (!isAudio && !isImage) {
    body.supports_streaming = true
    // Telegram expects either both dimensions or neither.
    if (item.width && item.height) {
      body.width = item.width
      body.height = item.height
    }
  }

  try {
    await tg.call(method, body, { filename: options.filename })
  } catch (error) {
    // Unsupported codec/container: Telegram still accepts it as a document.
    try {
      await tg.call(
        'sendDocument',
        { chat_id: chatId, document: blob, caption: body.caption, parse_mode: 'HTML' },
        { filename: options.filename },
      )
    } catch {
      throw error
    }
  }
}

/** Telegram allows at most 10 items per album. */
export const ALBUM_SIZE = 10

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

/**
 * Sends photos as Telegram media groups (albums of ≤10). One request per album
 * instead of one request per photo, which keeps us far away from flood limits.
 */
export async function sendAlbum(
  tg: TelegramApi,
  chatId: number | string,
  items: MediaItem[],
  options: SendOptions,
): Promise<number> {
  let sent = 0

  for (const [groupIndex, group] of chunk(items, ALBUM_SIZE).entries()) {
    const files: MultipartFile[] = []
    const media: Array<Record<string, unknown>> = []
    const caption = groupIndex === 0 ? options.caption?.slice(0, 1024) : undefined

    try {
      for (const [index, item] of group.entries()) {
        const blob = await downloadItem(item, options.maxBytes)
        const field = `p${index}`
        const isVideo = item.kind === 'video'
        const ext = item.ext || (isVideo ? 'mp4' : 'jpg')
        files.push({ field, blob, filename: `${index}.${ext}` })
        media.push({
          type: isVideo ? 'video' : 'photo',
          media: `attach://${field}`,
          ...(caption && index === 0 ? { caption, parse_mode: 'HTML' } : {}),
        })
      }

      if (!files.length) continue

      if (files.length === 1) {
        await sendMedia(tg, chatId, group[0], { ...options, caption })
      } else {
        await tg.multipart('sendMediaGroup', { chat_id: chatId, media }, files)
      }
      sent += files.length
    } catch (error) {
      if (error instanceof UploadTooLarge) throw error
      // Album failed (codec/permission): fall back to plain single sends.
      for (const [index, item] of group.entries()) {
        try {
          const isVideo = item.kind === 'video'
          const ext = item.ext || (isVideo ? 'mp4' : 'jpg')
          await sendMedia(tg, chatId, item, {
            ...options,
            caption: groupIndex === 0 && index === 0 ? options.caption : undefined,
            filename: `${index}.${ext}`,
          })
          sent += 1
        } catch (inner) {
          if (inner instanceof UploadTooLarge) throw inner
        }
      }
    }
  }

  return sent
}
