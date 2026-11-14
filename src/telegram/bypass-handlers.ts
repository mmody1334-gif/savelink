import type { TelegramApi } from './api'
import { escapeHtml, t, type Lang } from './i18n'
import type { TgMessage } from './types'
import { unshortenUrl, type BypassResult } from '../bypass'
import { detectPlatform, findUrl } from '../platforms'
import type { Env } from '../types'
import type { Store } from '../store'

export type HandleLinkFn = (
  tg: TelegramApi,
  message: TgMessage,
  url: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
) => Promise<void>

/**
 * Handles /bypass, /unshorten, and /skip commands.
 */
export async function handleBypassCommand(
  tg: TelegramApi,
  message: TgMessage,
  rawArg: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
  handleLink: HandleLinkFn,
): Promise<void> {
  const chatId = message.chat.id
  const targetUrl = findUrl(rawArg) || rawArg.trim()

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'bypassPrompt'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'bypassResolving'),
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  try {
    const result: BypassResult = await unshortenUrl(targetUrl)

    if (result.success && result.finalUrl && result.finalUrl !== result.originalUrl) {
      const platform = detectPlatform(result.finalUrl)

      if (platform !== 'unknown') {
        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: t(lang, 'bypassAutoResolved', { finalUrl: escapeHtml(result.finalUrl) }),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })
        await handleLink(tg, message, result.finalUrl, lang, env, store, origin)
        return
      }

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: t(lang, 'bypassSuccess', {
          finalUrl: escapeHtml(result.finalUrl),
          hops: String(result.hops),
        }),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [{ text: t(lang, 'bypassOpenBtn'), url: result.finalUrl }],
          ],
        },
      })
      return
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: t(lang, 'bypassFailed', { url: escapeHtml(targetUrl) }),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: t(lang, 'bypassFailed', { url: escapeHtml(targetUrl) }),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }
}
