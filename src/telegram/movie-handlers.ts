import type { TelegramApi } from './api'
import { escapeHtml, t, type Lang } from './i18n'
import type { TgCallbackQuery, TgMessage } from './types'
import {
  getMovieDetails,
  resolveAkwamStream,
  searchMovies,
  type MovieItemDetails,
  type MovieSearchResult,
} from '../movies'
import type { Env } from '../types'
import type { Store } from '../store'

export interface StoredMovieSearch {
  query: string
  results: MovieSearchResult[]
  lang: Lang
}

export interface StoredMovieItem {
  details: MovieItemDetails
  searchKey?: string
  lang: Lang
}

export interface StoredMovieEpisode {
  epDetails: MovieItemDetails
  itemKey: string
  lang: Lang
}

function shortKey(): string {
  return Math.random().toString(36).slice(2, 10)
}

/**
 * Robustly edits or updates a Telegram message, whether it was originally sent
 * as a photo (with caption) or as a text message.
 */
async function updateMovieMessage(
  tg: TelegramApi,
  query: TgCallbackQuery,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard: any,
  posterUrl?: string,
): Promise<void> {
  const isPhotoMessage = Boolean((query?.message as any)?.photo?.length)

  // 1. If currently a photo message and we have a new poster, try editMessageMedia
  if (isPhotoMessage && posterUrl) {
    try {
      await tg.call('editMessageMedia', {
        chat_id: chatId,
        message_id: messageId,
        media: JSON.stringify({
          type: 'photo',
          media: posterUrl,
          caption: text.slice(0, 1024),
          parse_mode: 'HTML',
        }),
        reply_markup: keyboard,
      })
      return
    } catch {
      /* fallback to caption edit */
    }
  }

  // 2. If currently a photo message, edit its caption
  if (isPhotoMessage) {
    try {
      await tg.safeEdit('editMessageCaption', {
        chat_id: chatId,
        message_id: messageId,
        caption: text.slice(0, 1024),
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      return
    } catch {
      /* fallback to text or delete & send */
    }
  }

  // 3. If currently a text message, try editMessageText
  try {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    })
    return
  } catch (err: any) {
    const errStr = (err?.message || '').toLowerCase()
    if (errStr.includes('there is no text in the message')) {
      try {
        await tg.safeEdit('editMessageCaption', {
          chat_id: chatId,
          message_id: messageId,
          caption: text.slice(0, 1024),
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
        return
      } catch {}
    }
  }

  // 4. Fallback: delete old message and send fresh message
  try {
    await tg.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => undefined)
    if (posterUrl) {
      await tg.call('sendPhoto', {
        chat_id: chatId,
        photo: posterUrl,
        caption: text.slice(0, 1024),
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    } else {
      await tg.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
    }
  } catch (err) {
    console.error('updateMovieMessage fatal fallback error', err)
  }
}

/**
 * Handles /movie, /film, /series, /cinema commands.
 */
export async function handleMovieCommand(
  tg: TelegramApi,
  message: TgMessage,
  query: string,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const chatId = message.chat.id
  const trimmed = query.trim()

  if (!trimmed) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'moviePrompt'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'movieSearching', { query: escapeHtml(trimmed) }),
    reply_to_message_id: message.message_id,
    parse_mode: 'HTML',
  })

  try {
    const results = await searchMovies(trimmed, env)
    if (!results.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'movieNotFound', { query: escapeHtml(trimmed) }),
        parse_mode: 'HTML',
      })
      return
    }

    const key = shortKey()
    const stored: StoredMovieSearch = { query: trimmed, results, lang }
    await store.put(`mov_s:${key}`, JSON.stringify(stored), 3600)

    const keyboard = buildSearchResultsKeyboard(stored, key)
    const text = t(lang, 'movieResultsHeader', { query: escapeHtml(trimmed) })

    // If only 1 result with a poster, show it directly with photo
    if (results.length === 1 && results[0]?.poster) {
      try {
        await tg.call('sendPhoto', {
          chat_id: chatId,
          photo: results[0].poster,
          caption: text,
          parse_mode: 'HTML',
          reply_markup: keyboard,
          reply_to_message_id: message.message_id,
        })
        await tg.call('deleteMessage', { chat_id: chatId, message_id: status.message_id }).catch(() => undefined)
        return
      } catch {
        /* fallback to text */
      }
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: `❌ ${(error as Error).message}`,
      parse_mode: 'HTML',
    })
  }
}

/**
 * Handles callback queries for movie search, details, and quality resolution.
 */
export async function handleMovieCallback(
  tg: TelegramApi,
  query: TgCallbackQuery,
  chatId: number | string,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const subtag = parts[1]

  // mov|s|{searchKey}|{idx} -> Pick from search results
  if (subtag === 's') {
    const searchKey = parts[2]
    const idx = Number(parts[3]) || 0
    const raw = await store.get(`mov_s:${searchKey}`)
    if (!raw) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    const storedSearch: StoredMovieSearch = JSON.parse(raw)
    const item = storedSearch.results[idx]
    if (!item) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)

    try {
      const details = await getMovieDetails(item.url, env)
      const itemKey = shortKey()
      const storedItem: StoredMovieItem = { details, searchKey, lang }
      await store.put(`mov_d:${itemKey}`, JSON.stringify(storedItem), 3600)

      const text = renderDetailsText(details, lang)
      const keyboard = buildDetailsKeyboard(details, itemKey, searchKey, lang)

      await updateMovieMessage(tg, query, chatId, messageId, text, keyboard, details.poster)
    } catch (error) {
      await updateMovieMessage(
        tg,
        query,
        chatId,
        messageId,
        `❌ ${(error as Error).message}`,
        {
          inline_keyboard: [[{ text: t(lang, 'movieBackBtn'), callback_data: `mov|b|${searchKey}` }]],
        },
      )
    }
    return
  }

  // mov|d|{itemKey} -> Return to movie details from quality/watch screen
  if (subtag === 'd') {
    const itemKey = parts[2]
    const raw = await store.get(`mov_d:${itemKey}`)
    if (!raw) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)

    const storedItem: StoredMovieItem = JSON.parse(raw)
    const text = renderDetailsText(storedItem.details, lang)
    const keyboard = buildDetailsKeyboard(storedItem.details, itemKey, storedItem.searchKey || '', lang)

    await updateMovieMessage(tg, query, chatId, messageId, text, keyboard, storedItem.details.poster)
    return
  }

  // mov|e|{itemKey}|{epIdx} -> Pick episode from series
  if (subtag === 'e') {
    const itemKey = parts[2]
    const epIdx = Number(parts[3]) || 0
    const raw = await store.get(`mov_d:${itemKey}`)
    if (!raw) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    const storedItem: StoredMovieItem = JSON.parse(raw)
    const ep = storedItem.details.episodes[epIdx]
    if (!ep) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)

    try {
      const epDetails = await getMovieDetails(ep.url, env)
      const epKey = shortKey()
      const storedEpisode: StoredMovieEpisode = { epDetails, itemKey, lang }
      await store.put(`mov_e:${epKey}`, JSON.stringify(storedEpisode), 3600)

      const text =
        lang === 'ar'
          ? `📺 <b>${escapeHtml(storedItem.details.title)}</b>\n▶️ <b>${escapeHtml(ep.title)}</b>\n\n👇 <b>اختر الجودة المطلوبة:</b>`
          : `📺 <b>${escapeHtml(storedItem.details.title)}</b>\n▶️ <b>${escapeHtml(ep.title)}</b>\n\n👇 <b>Select quality:</b>`

      const keyboard = buildEpisodeQualitiesKeyboard(epDetails, epKey, itemKey, lang)
      await updateMovieMessage(tg, query, chatId, messageId, text, keyboard, storedItem.details.poster)
    } catch (error) {
      await updateMovieMessage(
        tg,
        query,
        chatId,
        messageId,
        `❌ ${(error as Error).message}`,
        {
          inline_keyboard: [[{ text: t(lang, 'movieBackBtn'), callback_data: `mov|be|${itemKey}` }]],
        },
      )
    }
    return
  }

  // mov|q|{itemKey}|{qIdx} or mov|eq|{epKey}|{qIdx} -> Pick quality
  if (subtag === 'q' || subtag === 'eq') {
    const isEpisode = subtag === 'eq'
    const key = parts[2]
    const qIdx = Number(parts[3]) || 0

    const raw = await store.get(isEpisode ? `mov_e:${key}` : `mov_d:${key}`)
    if (!raw) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    const data = JSON.parse(raw)
    const details: MovieItemDetails = isEpisode ? data.epDetails : data.details
    const q = details?.qualities[qIdx]
    if (!q) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)

    try {
      const stream = await resolveAkwamStream(q.watchUrl, env)
      const title = details.title
      const text = t(lang, 'movieStreamReady', {
        title: escapeHtml(title),
        quality: q.quality,
        size: q.size || stream.quality || 'N/A',
      })

      const keyboard = {
        inline_keyboard: [
          [{ text: t(lang, 'movieDownloadBtn'), url: stream.directVideoUrl }],
          [{ text: t(lang, 'movieWatchBtn'), url: stream.directVideoUrl }],
          [
            {
              text: isEpisode ? t(lang, 'movieBackBtn') : (lang === 'ar' ? '🔙 جودة أخرى' : '🔙 Other Quality'),
              callback_data: isEpisode ? `mov|be|${data.itemKey}` : `mov|d|${key}`,
            },
            {
              text: lang === 'ar' ? '🔍 رجوع للبحث' : '🔍 Back to Search',
              callback_data: `mov|b|${data.searchKey || ''}`,
            },
          ],
        ],
      }

      await updateMovieMessage(tg, query, chatId, messageId, text, keyboard, details.poster)
    } catch (error) {
      const backKey = isEpisode ? `mov|be|${data.itemKey}` : `mov|d|${key}`
      await updateMovieMessage(
        tg,
        query,
        chatId,
        messageId,
        `❌ ${(error as Error).message}`,
        {
          inline_keyboard: [[{ text: t(lang, 'movieBackBtn'), callback_data: backKey }]],
        },
      )
    }
    return
  }

  // mov|b|{searchKey} -> Back to search results
  if (subtag === 'b') {
    const searchKey = parts[2]
    const raw = await store.get(`mov_s:${searchKey}`)
    if (!raw) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)

    const storedSearch: StoredMovieSearch = JSON.parse(raw)
    const keyboard = buildSearchResultsKeyboard(storedSearch, searchKey)
    const text = t(lang, 'movieResultsHeader', { query: escapeHtml(storedSearch.query) })

    await updateMovieMessage(tg, query, chatId, messageId, text, keyboard)
    return
  }

  // mov|be|{itemKey} -> Back to episodes list
  if (subtag === 'be') {
    const itemKey = parts[2]
    const raw = await store.get(`mov_d:${itemKey}`)
    if (!raw) {
      await tg.call('answerCallbackQuery', { callback_query_id: query.id, text: t(lang, 'expired'), show_alert: true })
      return
    }

    await tg.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)

    const storedItem: StoredMovieItem = JSON.parse(raw)
    const text = renderDetailsText(storedItem.details, lang)
    const keyboard = buildDetailsKeyboard(storedItem.details, itemKey, storedItem.searchKey || '', lang)

    await updateMovieMessage(tg, query, chatId, messageId, text, keyboard, storedItem.details.poster)
    return
  }
}

function buildSearchResultsKeyboard(
  stored: StoredMovieSearch,
  key: string,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []

  for (let i = 0; i < stored.results.length; i++) {
    const item = stored.results[i]
    const icon = item.kind === 'series' ? '📺' : '🎬'
    const yearStr = item.year ? ` (${item.year})` : ''
    const text = `${icon} ${item.title}${yearStr}`
    rows.push([{ text, callback_data: `mov|s|${key}|${i}` }])
  }

  return { inline_keyboard: rows }
}

function renderDetailsText(details: MovieItemDetails, lang: Lang): string {
  const badge = details.year ? `📅 ${details.year}` : ''
  const rating = details.rating ? `⭐ ${details.rating}` : ''
  const story = details.story ? escapeHtml(details.story.slice(0, 450)) : 'N/A'

  const templateKey = details.kind === 'series' ? 'seriesCard' : 'movieCard'
  return t(lang, templateKey, {
    title: escapeHtml(details.title),
    badge,
    rating,
    story,
  })
}

function buildDetailsKeyboard(
  details: MovieItemDetails,
  itemKey: string,
  searchKey: string,
  lang: Lang,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []

  if (details.kind === 'movie') {
    for (let i = 0; i < details.qualities.length; i++) {
      const q = details.qualities[i]
      const sizeStr = q.size ? ` (${q.size})` : ''
      rows.push([{ text: `📥 ${q.quality}${sizeStr}`, callback_data: `mov|q|${itemKey}|${i}` }])
    }
  } else {
    // Series episodes - 4 per row
    let currentRow: Array<{ text: string; callback_data: string }> = []
    for (let i = 0; i < details.episodes.length; i++) {
      const ep = details.episodes[i]
      currentRow.push({
        text: `حلقة ${ep.number}`,
        callback_data: `mov|e|${itemKey}|${i}`,
      })
      if (currentRow.length === 4) {
        rows.push(currentRow)
        currentRow = []
      }
    }
    if (currentRow.length > 0) rows.push(currentRow)
  }

  if (searchKey) {
    rows.push([{ text: t(lang, 'movieBackBtn'), callback_data: `mov|b|${searchKey}` }])
  }

  return { inline_keyboard: rows }
}

function buildEpisodeQualitiesKeyboard(
  epDetails: MovieItemDetails,
  epKey: string,
  itemKey: string,
  lang: Lang,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []

  for (let i = 0; i < epDetails.qualities.length; i++) {
    const q = epDetails.qualities[i]
    const sizeStr = q.size ? ` (${q.size})` : ''
    rows.push([{ text: `📥 ${q.quality}${sizeStr}`, callback_data: `mov|eq|${epKey}|${i}` }])
  }

  rows.push([{ text: t(lang, 'movieBackBtn'), callback_data: `mov|be|${itemKey}` }])
  return { inline_keyboard: rows }
}
