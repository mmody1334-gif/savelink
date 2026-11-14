import type { TelegramApi } from './api'
import { escapeHtml, t, type Lang } from './i18n'
import type { TgMessage } from './types'
import { transcribeAndSummarizeAudio } from '../ai'
import type { Env } from '../types'
import type { Store } from '../store'

/**
 * Resolves Gemini API key from environment or KV store.
 */
export async function resolveGeminiApiKey(
  env: Env,
  store: Store,
  chatId?: number,
): Promise<string | null> {
  const envKey = (env as Record<string, unknown>).GEMINI_API_KEY as string | undefined
  if (envKey && envKey.trim()) return envKey.trim()

  if (chatId) {
    const userKey = await store.get(`user:gemini_key:${chatId}`)
    if (userKey && userKey.trim()) return userKey.trim()
  }

  const globalKey = await store.get('cfg:gemini_key')
  if (globalKey && globalKey.trim()) return globalKey.trim()

  return null
}

/**
 * Handles /setkey command.
 */
export async function handleSetKeyCommand(
  tg: TelegramApi,
  message: TgMessage,
  rawKey: string,
  lang: Lang,
  store: Store,
): Promise<void> {
  const chatId = message.chat.id
  const key = rawKey.trim()

  if (!key) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'setKeyPrompt'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  if (key.length < 15 || /\s/.test(key)) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'setKeyInvalid'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  await store.put(`user:gemini_key:${chatId}`, key, 86400 * 365)
  await store.put('cfg:gemini_key', key, 86400 * 365)

  await tg.call('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'setKeySuccess'),
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}

/**
 * Handles incoming voice notes or audio messages.
 */
export async function handleAudioMessage(
  tg: TelegramApi,
  message: TgMessage,
  lang: Lang,
  env: Env,
  store: Store,
): Promise<void> {
  const chatId = message.chat.id
  const fileRef = message.voice || message.audio
  if (!fileRef) return

  const apiKey = await resolveGeminiApiKey(env, store, chatId)
  if (!apiKey) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'aiKeyNeeded'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  // 20 MB size limit
  if (fileRef.file_size && fileRef.file_size > 20 * 1024 * 1024) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'aiAudioTooLarge'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'aiTranscribing'),
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  try {
    const fileInfo = await tg.call<{ file_path: string }>('getFile', { file_id: fileRef.file_id })
    if (!fileInfo?.file_path) {
      throw new Error('Could not get audio file path from Telegram')
    }

    const downloadUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`
    const res = await fetch(downloadUrl)
    if (!res.ok) {
      throw new Error(`Telegram download failed with status ${res.status}`)
    }

    const bytes = await res.arrayBuffer()
    const mime = fileRef.mime_type || (message.voice ? 'audio/ogg' : 'audio/mp3')

    const effectiveEnv = { ...env, GEMINI_API_KEY: apiKey }
    const result = await transcribeAndSummarizeAudio(bytes, mime, effectiveEnv)

    const formatted = t(lang, 'aiResult', {
      transcript: escapeHtml(result.transcript || '—'),
      summary: escapeHtml(result.summary || '—'),
    })

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: formatted,
      parse_mode: 'HTML',
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ ${escapeHtml(reason)}`,
      parse_mode: 'HTML',
    })
  }
}

/**
 * Handles /ai, /transcribe, and /summary commands.
 */
export async function handleAiCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
  store: Store,
): Promise<void> {
  const chatId = message.chat.id

  // Check if replying to a voice or audio file
  if (message.reply_to_message && (message.reply_to_message.voice || message.reply_to_message.audio)) {
    await handleAudioMessage(tg, message.reply_to_message, lang, env, store)
    return
  }

  const query = rest.trim()
  if (!query) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'aiNoMediaFound'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  // Answer text question using Gemini
  const apiKey = await resolveGeminiApiKey(env, store, chatId)
  if (!apiKey) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'aiKeyNeeded'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: '🤖 ⏳ جاري التفكير والإجابة…',
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  try {
    const models = ['gemini-2.0-flash', 'gemini-1.5-flash']
    let answerText = ''

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: query }] }],
        }),
      })

      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
        }
        answerText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || ''
        if (answerText) break
      }
    }

    if (!answerText) {
      throw new Error('Empty response from AI model')
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `🤖 <b>رد الذكاء الاصطناعي:</b>\n\n${escapeHtml(answerText)}`,
      parse_mode: 'HTML',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ تعذر الحصول على رد من الذكاء الاصطناعي: ${escapeHtml(msg)}`,
      parse_mode: 'HTML',
    })
  }
}
