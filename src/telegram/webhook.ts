import type { Context } from 'hono'
import { maxUploadBytes, profileMaxItems, publicBase, rateLimitPerMin } from '../config'
import {
  clearArchiveEntries,
  deleteArchiveEntry,
  listArchiveEntries,
  signArchivePageUrl,
  type ArchiveEntry,
} from '../archive'
import {
  clearAllActiveRecordings,
  getActiveRecording,
  listActiveRecordings,
  markRecordingStarted,
  normalizeRecPlatform,
  type ActiveRecording,
} from '../active-recordings'
import { ResolveError, errorMessage } from '../errors'
import { signFileUrl } from '../files'
import { resolveInstagramProfile, fetchArchivePage, type InstagramProfileResult } from '../instagram-profile'
import { instagramApi } from '../instagram-public'
import { instagramSidecar } from '../instagram-sidecar'
import {
  fetchActiveStories,
  fetchHighlightItems,
  fetchHighlights,
  type InstagramHighlight,
} from '../instagram-stories'
import {
  resolveFacebookProfile,
  type FacebookProfileResult,
} from '../facebook-profile'
import { resolveFacebookShare } from '../engines/native/facebook'
import {
  fetchFacebookStories,
  fetchFacebookHighlights,
} from '../facebook-stories'
import { handleMovieCallback, handleMovieCommand } from './movie-handlers'
import { handleBypassCommand } from './bypass-handlers'
import {
  isPaused,
  isRecorderPaused,
  setPaused,
  setRecorderPaused,
  canControlPause,
  isPauseConfigured,
  cancelAllGitHubRuns,
  stopRecorderGitHubRuns,
} from '../pause'
import { invalidateSignalMemo } from '../routes/api'
import {
  handleAiCommand,
  handleAudioMessage,
  handleSetKeyCommand,
  resolveGeminiApiKey,
} from './ai-handlers'
import { transcribeAndSummarizeAudio } from '../ai'
import { isShortenerOrAdLink, unshortenUrl } from '../bypass'
import {
  detectPlatform,
  findFacebookProfile,
  findInstagramProfile,
  findUrl,
  parseFacebookProfile,
  parseFacebookStoryLink,
  parseInstagramProfile,
  parseInstagramStoryLink,
  parseYouTubeVideo,
  parseYouTubePlaylist,
  parseCoomerUrl,
  parseEromeUrl,
  parseBunkrUrl,
  canonicalTikTokUrl,
  type FacebookProfileTarget,
} from '../platforms'
import {
  searchErome,
  fetchEromeAlbum,
  type EromeAlbumDetail,
  type EromeAlbumSummary,
} from '../erome'
import {
  searchBunkr,
  fetchBunkrAlbum,
  resolveBunkrFile,
  type BunkrSearchResult,
  type BunkrAlbumDetail,
} from '../bunkr'
import {
  WATCH_CHECK_INTERVAL_MINUTES,
  addWatchTarget,
  clearAllWatchLocksForTarget,
  removeWatchTarget,
  listUserWatchTargets,
  triggerWatchTargetIfLive,
} from '../watch'
import {
  fetchYouTubeVideoDetails,
  fetchYouTubePlaylist,
  searchYouTube,
  formatDuration,
  type YouTubePlaylistResult,
} from '../youtube'
import {
  fetchCoomerPosts,
  extractVideosFromPosts,
  buildCoomerCdnUrls,
  fetchCoomerFansPosts,
  fetchCoomerFansPost,
  type CoomerMediaVideo,
} from '../coomer'
import { resolveMedia } from '../resolve'
import {
  cleanButtonText,
  durationLabel,
  humanSize,
  itemFilename,
  pickForMode,
  qualityLabel,
  shortKey,
  trimForTelegram,
} from '../select'
import { checkRateLimit, getStore, type Store } from '../store'
import type { Env, MediaItem, MediaResult, Mode, Quality } from '../types'
import { TelegramApi } from './api'
import { escapeHtml, pickLang, platformName, t, type Lang } from './i18n'
import { UploadTooLarge, sendAlbum, sendMedia } from './send'

interface StoredMedia {
  result: MediaResult
  items: MediaItem[]
  lang: Lang
  /** photos that belong to an Instagram profile (avatar excluded) */
  album?: MediaItem[]
  profile?: {
    username: string
    fullName?: string
    followers?: number
    posts?: number
    hd: boolean
    truncated: boolean
  }
  fbProfile?: {
    username: string
    name: string
    userId?: string
    storyBucketId?: string
    highlightId?: string
    highlightIds?: string[]
    photoCount: number
    hd: boolean
    /** fb_dtsg session token from the profile page; lets story/highlight fetches skip the stories shell page */
    dtsg?: string
  }
  /** full-archive pagination state (only when IG_COOKIE is configured) */
  archive?: {
    cursor?: string
    sent: number
    videos: number
    total?: number
  }
  /** highlight tray cached so each button can resolve its reel id */
  highlights?: InstagramHighlight[]
}

interface StoredCoomerPage {
  domain: string
  service: string
  creatorId: string
  username?: string
  offset: number
  videos: CoomerMediaVideo[]
  lang: Lang
}

interface StoredEromeSearch {
  query: string
  albums: EromeAlbumSummary[]
  offset: number
  lang: Lang
}

interface StoredEromeAlbum {
  album: EromeAlbumDetail
  offset: number
  lang: Lang
}

interface StoredBunkrSearch {
  query: string
  results: BunkrSearchResult[]
  offset: number
  lang: Lang
}

interface StoredBunkrAlbum {
  album: BunkrAlbumDetail
  offset: number
  lang: Lang
}

interface InlineButton {
  text: string
  callback_data?: string
  url?: string
}

interface InlineKeyboard {
  inline_keyboard: InlineButton[][]
}

interface ProfileView {
  username: string
  fullName?: string
  hd: boolean
  photoCount: number
  /** account total from Instagram; enables the "all posts" button when a session is set */
  archiveTotal?: number
  items: MediaItem[]
}

interface TgFileRef {
  file_id: string
  file_unique_id: string
  file_size?: number
  mime_type?: string
  duration?: number
  file_name?: string
}

interface TgMessage {
  message_id: number
  chat: { id: number; type: string }
  from?: { id: number; language_code?: string; is_bot?: boolean }
  text?: string
  caption?: string
  reply_to_message?: TgMessage
  voice?: TgFileRef
  audio?: TgFileRef
  video?: TgFileRef
  document?: TgFileRef
  animation?: TgFileRef
}

export async function telegramWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const env = c.env

  const secret = c.req.param('secret')
  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) return c.text('forbidden', 403)

  const headerSecret = c.req.header('x-telegram-bot-api-secret-token')
  if (headerSecret && headerSecret !== env.WEBHOOK_SECRET) return c.text('forbidden', 403)

  if (!env.BOT_TOKEN) return c.text('BOT_TOKEN is not configured', 503)

  let update: any
  try {
    update = await c.req.json()
  } catch {
    return c.text('ok')
  }

  const store = getStore(env)
  const tg = new TelegramApi(env.BOT_TOKEN)
  const origin = new URL(c.req.url).origin

  // Global kill switch: while paused, only /resumeall (and /stopall) get through.
  if (await isPaused(env)) {
    try {
      await handlePausedUpdate(tg, update, env)
    } catch (error) {
      console.error('paused update error', errorMessage(error))
    }
    return c.text('ok')
  }

  // Acknowledge Telegram first and finish the work in the background. Telegram
  // closes the webhook connection after a short wait, and once the client is
  // gone the runtime can cancel the still-running handler: slow flows (hosted
  // Instagram API, archive pagination, uploads) then die mid-flight and the
  // user is left with a permanent "sending" status. waitUntil keeps the
  // invocation alive after the response, so slow paths always reach their
  // success or failure message.
  c.executionCtx.waitUntil(
    (async () => {
      try {
        if (update?.update_id) {
          const dedupeKey = `u:${update.update_id}`
          if (await store.get(dedupeKey)) return
          await store.put(dedupeKey, '1', 600)
        }
        await handleUpdate(tg, update, env, store, origin)
      } catch (error) {
        console.error('telegram webhook error', errorMessage(error))
      }
    })(),
  )
  return c.text('ok')
}

async function handleUpdate(
  tg: TelegramApi,
  update: any,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  if (update?.inline_query) {
    await handleInlineQuery(tg, update.inline_query, env)
    return
  }

  if (update?.callback_query) {
    await handleCallback(tg, update.callback_query, env, store, origin)
    return
  }

  const message = (update?.message ?? update?.channel_post) as TgMessage | undefined
  if (!message?.chat) return
  if (message.from?.is_bot) return

  const lang = pickLang(message.from?.language_code, env)
  const text = String(message.text ?? message.caption ?? '').trim()
  const chatId = message.chat.id

  if (text.startsWith('/')) {
    await handleCommand(tg, message, text, lang, env, store, origin)
    return
  }

  if (message.voice || message.audio) {
    await handleAudioMessage(tg, message, lang, env, store)
    return
  }

  // A bare "@username" is an Instagram profile request.
  if (/^@[A-Za-z0-9._]{1,30}$/.test(text)) {
    const profile = parseInstagramProfile(text)
    if (profile) {
      await handleProfile(tg, message, profile.username, false, lang, env, store, origin)
      return
    }
  }

  const url = findUrl(text)
  if (!url) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'needLink'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  await handleLink(tg, message, url, lang, env, store, origin)
}

async function handleInlineQuery(
  tg: TelegramApi,
  iq: { id: string; query?: string; offset?: string; from?: { language_code?: string } },
  env: Env,
): Promise<void> {
  const lang = pickLang(iq.from?.language_code, env)
  const query = (iq.query ?? '').trim()

  if (!query) {
    try {
      await tg.call('answerInlineQuery', {
        inline_query_id: iq.id,
        results: [],
        cache_time: 10,
        is_personal: true,
        switch_pm_text: t(lang, 'inlineSearchPrompt'),
        switch_pm_parameter: 'search',
      })
    } catch (err) {
      console.error('answerInlineQuery empty err', err)
    }
    return
  }

  try {
    const results = await searchYouTube(query, 12)
    const inlineResults = results.map((item, idx) => ({
      type: 'article',
      id: `${item.videoId}_${idx}`,
      title: item.title,
      description: item.duration ? `${item.duration} • ${item.author}` : item.author,
      thumb_url: item.thumbnail,
      input_message_content: {
        message_text: `https://www.youtube.com/watch?v=${item.videoId}`,
      },
    }))

    await tg.call('answerInlineQuery', {
      inline_query_id: iq.id,
      results: inlineResults,
      cache_time: 300,
      is_personal: false,
    })
  } catch (err) {
    console.error('answerInlineQuery search err', err)
  }
}

/**
 * Any source that can serve Instagram stories/highlights: the hosted API
 * (IG_API_KEY, tried first by fetchActiveStories/fetchHighlights), the
 * sidecar, or a session cookie. The old gate demanded IG_COOKIE only, which
 * blocked the Apify path even when it was configured.
 */
export function hasInstagramStoriesSource(env: Env): boolean {
  return Boolean(env.IG_COOKIE) || Boolean(instagramApi(env)) || Boolean(instagramSidecar(env))
}

async function handleCommand(
  tg: TelegramApi,
  message: TgMessage,
  text: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  const match = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/)
  const command = (match?.[1] ?? '').toLowerCase()
  const rest = (match?.[2] ?? '').trim()

  switch (command) {
    case 'stopall':
    case 'pauseall': {
      await handleStopAll(tg, message, env)
      return
    }
    case 'resumeall':
    case 'startall': {
      await handleResumeAll(tg, message, env)
      return
    }
    case 'start':
    case 'help':
    case 'menu': {
      const { text, reply_markup } = renderMainMenu(lang)
      await tg.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
        reply_markup,
      })
      return
    }
    case 'id':
      await tg.call('sendMessage', { chat_id: chatId, text: `chat_id: <code>${chatId}</code>`, parse_mode: 'HTML' })
      return
    case 'mp3':
    case 'audio':
    case 'mp4':
    case 'video': {
      const mode = command === 'mp3' || command === 'audio' ? 'audio' : 'video'
      await handleQuickDownload(tg, message, rest, mode, lang, env, store, origin)
      return
    }
    case 'dp':
    case 'photos':
    case 'profile': {
      let resolvedRest = rest.trim()
      if (/fb\.watch|\/share\//i.test(resolvedRest)) {
        try {
          resolvedRest = await resolveFacebookShare(resolvedRest)
        } catch {}
      }
      const fbTarget = findFacebookProfile(resolvedRest) || findFacebookProfile(rest)
      if (fbTarget) {
        await handleFacebookProfile(tg, message, fbTarget, lang, env, store, origin)
        return
      }
      const target = findInstagramProfile(rest)
      if (!target) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'profilePrompt'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
        })
        return
      }
      await handleProfile(tg, message, target.username, command !== 'dp', lang, env, store, origin)
      return
    }
    case 'story':
    case 'stories': {
      let resolvedRest = rest.trim()
      if (/fb\.watch|\/share\//i.test(resolvedRest)) {
        try {
          resolvedRest = await resolveFacebookShare(resolvedRest)
        } catch {}
      }
      const fbStoryTarget = parseFacebookStoryLink(resolvedRest) || parseFacebookStoryLink(rest)
      const fbTarget = findFacebookProfile(resolvedRest) || findFacebookProfile(rest)
      if (fbStoryTarget || fbTarget) {
        if (!env.FB_COOKIE) {
          await tg.call('sendMessage', {
            chat_id: chatId,
            text: t(lang, 'fbStoriesNeedCookie'),
            parse_mode: 'HTML',
            reply_to_message_id: message.message_id,
          })
          return
        }
        if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return
        const status = await tg.call<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'storiesSending'),
          reply_to_message_id: message.message_id,
        })
        let targetId = fbStoryTarget && fbStoryTarget.kind === 'story' ? fbStoryTarget.bucketId : ''
        if (!targetId && fbTarget) {
          try {
            const profile = await resolveFacebookProfile({ target: fbTarget.url, env })
            targetId = profile.info.storyBucketId || profile.info.userId || fbTarget.value
          } catch {
            targetId = fbTarget.value
          }
        }
        await showFacebookStories(tg, chatId, status.message_id, targetId, lang, env)
        return
      }

      const target = findInstagramProfile(rest)
      if (!target) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'profilePrompt'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
        })
        return
      }
      if (!hasInstagramStoriesSource(env)) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'storiesNeedCookie'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
        })
        return
      }
      if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return
      const status = await tg.call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: t(lang, 'storiesSending'),
        reply_to_message_id: message.message_id,
      })
      await showStories(tg, chatId, status.message_id, target.username, lang, env)
      return
    }
    case 'highlights':
    case 'highlight': {
      let resolvedRest = rest.trim()
      if (/fb\.watch|\/share\//i.test(resolvedRest)) {
        try {
          resolvedRest = await resolveFacebookShare(resolvedRest)
        } catch {}
      }
      const fbStoryTarget = parseFacebookStoryLink(resolvedRest) || parseFacebookStoryLink(rest)
      const fbTarget = findFacebookProfile(resolvedRest) || findFacebookProfile(rest)
      if (fbStoryTarget || fbTarget) {
        if (!env.FB_COOKIE) {
          await tg.call('sendMessage', {
            chat_id: chatId,
            text: t(lang, 'fbStoriesNeedCookie'),
            parse_mode: 'HTML',
            reply_to_message_id: message.message_id,
          })
          return
        }
        if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return
        const status = await tg.call<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'highlightsSending'),
          reply_to_message_id: message.message_id,
        })
        if (fbStoryTarget && fbStoryTarget.kind === 'highlight') {
          await sendDirectFacebookHighlight(tg, chatId, status.message_id, fbStoryTarget.highlightId, lang, env)
          return
        }
        let targetId = ''
        let profileDtsg: string | undefined
        if (fbTarget) {
          try {
            const profile = await resolveFacebookProfile({ target: fbTarget.url, env })
            targetId = profile.info.storyBucketId || profile.info.userId || fbTarget.value
            profileDtsg = profile.info.dtsg
          } catch {
            targetId = fbTarget.value
          }
        }
        await showFacebookHighlights(tg, chatId, status.message_id, [targetId], lang, env, undefined, { dtsg: profileDtsg })
        return
      }

      const target = findInstagramProfile(rest)
      if (!target) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'profilePrompt'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
          disable_web_page_preview: true,
        })
        return
      }
      if (!hasInstagramStoriesSource(env)) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'storiesNeedCookie'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
        })
        return
      }
      if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return
      const status = await tg.call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text: t(lang, 'highlightsSending'),
        reply_to_message_id: message.message_id,
      })
      const highlightKey = shortKey()
      const highlightStore: StoredMedia = {
        result: {
          platform: 'instagram',
          sourceUrl: `https://www.instagram.com/${target.username}/`,
          title: `@${target.username}`,
          author: `@${target.username}`,
          items: [],
          engine: 'instagram-highlights',
        },
        items: [],
        lang,
        profile: { username: target.username, hd: false, truncated: false },
      }
      await store.put(`m:${highlightKey}`, JSON.stringify(highlightStore), 3600)
      await showHighlights(
        tg,
        chatId,
        status.message_id,
        target.username,
        lang,
        env,
        store,
        highlightKey,
        highlightStore,
      )
      return
    }
    case 'erome': {
      if (!rest) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'eromeSearchPrompt'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
        })
        return
      }
      await handleEromeSearch(tg, message, rest, lang, env, store, origin)
      return
    }
    case 'bunkr': {
      if (!rest) {
        await tg.call('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'bunkrSearchPrompt'),
          parse_mode: 'HTML',
          reply_to_message_id: message.message_id,
        })
        return
      }
      await handleBunkrSearch(tg, message, rest, lang, env, store, origin)
      return
    }
    case 'record': {
      await handleRecordCommand(tg, message, rest, lang, env, store, origin)
      return
    }
    case 'stop': {
      await handleStopCommand(tg, message, rest, lang, env, store, origin)
      return
    }
    case 'status':
    case 'active': {
      await handleStatusCommand(tg, message, lang, env, store)
      return
    }
    case 'stop_recorder': {
      await handleStopRecorderAll(tg, message, lang, env)
      return
    }
    case 'archive':
    case 'links':
    case 'recordings': {
      await handleRecordingsArchiveCommand(tg, message, rest, lang, env, store, origin)
      return
    }
    case 'watch': {
      await handleWatchCommand(tg, message, rest, lang, env, store)
      return
    }
    case 'unwatch': {
      await handleUnwatchCommand(tg, message, rest, lang, env, store)
      return
    }
    case 'watchlist': {
      await handleWatchListCommand(tg, message, lang, env, store)
      return
    }
    case 'trim': {
      await handleTrimCommand(tg, message, rest, lang, env)
      return
    }
    case 'frame':
    case 'frames': {
      await handleFrameCommand(tg, message, rest, lang, env)
      return
    }
    case 'movie':
    case 'film':
    case 'series':
    case 'cinema': {
      await handleMovieCommand(tg, message, rest, lang, env, store, origin)
      return
    }
    case 'bypass':
    case 'unshorten':
    case 'skip': {
      await handleBypassCommand(tg, message, rest, lang, env, store, origin, handleLink)
      return
    }
    case 'ai':
    case 'transcribe':
    case 'summary': {
      await handleAiCommand(tg, message, rest, lang, env, store)
      return
    }
    case 'setkey': {
      await handleSetKeyCommand(tg, message, rest, lang, store)
      return
    }
    default: {
      const { text, reply_markup } = renderMainMenu(lang)
      await tg.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
        reply_markup,
      })
    }
  }
}

async function handleWatchCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
  store: Store,
): Promise<void> {
  const chatId = message.chat.id
  if (!rest) {
    const helpMsg = lang === 'ar'
      ? `👁️ <b>المراقبة والتسجيل التلقائي (Auto-Record)</b>\n\n` +
        `يراقب البوت حسابك أو أي حساب كل ${WATCH_CHECK_INTERVAL_MINUTES} دقائق، وأول ما يفتح لايف يبدأ التسجيل السحابي فوراً بدون تدخل منك!\n\n` +
        `<b>طريقة الاستخدام:</b>\n` +
        `• تيك توك: <code>/watch @shad.208</code>\n` +
        `• شاتوربيت: <code>/watch visceratio</code>\n\n` +
        `• لإلغاء المراقبة: <code>/unwatch @username</code>\n` +
        `• لعرض قائمة المراقبة: <code>/watchlist</code>`
      : `👁️ <b>Auto-Record Watcher</b>\n\n` +
        `Watches creators (checked every ${WATCH_CHECK_INTERVAL_MINUTES} minutes) and automatically starts recording as soon as they go live!\n\n` +
        `<b>Usage:</b>\n` +
        `• TikTok: <code>/watch @username</code>\n` +
        `• Chaturbate: <code>/watch model</code>\n\n` +
        `• Stop: <code>/unwatch @username</code>\n` +
        `• List: <code>/watchlist</code>`

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: helpMsg,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const res = await addWatchTarget(chatId, rest, store)
  const isAlreadyWatched = !res.ok && res.error === 'already_watched'
  if (!res.ok && !isAlreadyWatched) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '❌ تعذر إضافة الحساب، تأكد من صحة الاسم أو الرابط.' : '❌ Invalid target.',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const target = res.target!
  const plat = target.platform === 'tiktok' ? 'TikTok Live' : (target.platform === 'stripchat' ? 'Stripchat' : 'Chaturbate')

  // Immediate live check: if live right now, dispatch recorder right now!
  let liveTrigger: { live: boolean; triggered: boolean; detail: string } | null = null
  try {
    liveTrigger = await triggerWatchTargetIfLive(env, store, target)
    if (liveTrigger.triggered && liveTrigger.live) {
      const liveMsg = lang === 'ar'
        ? `🟢 <b>الحساب مباشر (LIVE) الآن!</b>\n\n` +
          `👤 <b>الحساب:</b> <code>${escapeHtml(target.target)}</code> (${plat})\n` +
          (isAlreadyWatched
            ? `🎥 <b>الحساب مسجل مسبقاً، وبدأ التسجيل السحابي فوراً دون انتظار!</b>\n`
            : `🎥 <b>تمت إضافته للمراقبة وبدأ التسجيل السحابي فوراً دون انتظار!</b>\n`) +
          `📦 سيتم إرسال الفيديو لك فور انتهاء البث.`
        : `🟢 <b>Target is LIVE right now!</b>\n\n` +
          `👤 <b>Target:</b> <code>${escapeHtml(target.target)}</code> (${plat})\n` +
          `🎥 <b>Recording started immediately!</b>\n` +
          `📦 Video will be sent when broadcast ends.`

      await tg.call('sendMessage', {
        chat_id: chatId,
        text: liveMsg,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
      })
      return
    }

    if (liveTrigger.triggered && !liveTrigger.live) {
      const watcherMsg = lang === 'ar'
        ? `⏳ <b>تعذّرت قراءة حالة الحساب من هنا.</b>\n\n` +
          `👤 <b>الحساب:</b> <code>${escapeHtml(target.target)}</code> (${plat})\n` +
          `☁️ <b>تم تشغيل مراقب سحابي</b> يتابع الحساب بدلاً من ذلك، وسيبدأ التسجيل تلقائياً أول ما يفتح لايف.\n` +
          `📦 سيتم إرسال الفيديو لك فور انتهاء البث.`
        : `⏳ <b>Could not read this account's status from here.</b>\n\n` +
          `👤 <b>Target:</b> <code>${escapeHtml(target.target)}</code> (${plat})\n` +
          `☁️ <b>A cloud watcher is now tracking it</b> instead, and will start recording automatically when it goes live.\n` +
          `📦 Video will be sent when the broadcast ends.`

      await tg.call('sendMessage', {
        chat_id: chatId,
        text: watcherMsg,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
      })
      return
    }

    if (liveTrigger.live && liveTrigger.detail === 'already_recording') {
      const alreadyMsg = lang === 'ar'
        ? `🟢 <b>الحساب مباشر (LIVE) الآن، والتسجيل السحابي يعمل له بالفعل!</b>\n\n` +
          `👤 <b>الحساب:</b> <code>${escapeHtml(target.target)}</code> (${plat})\n` +
          `📦 سيتم إرسال الفيديو فور اكتمال التسجيل.`
        : `🟢 <b>Target is LIVE and already recording!</b>`

      await tg.call('sendMessage', {
        chat_id: chatId,
        text: alreadyMsg,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
      })
      return
    }

    if (isAlreadyWatched) {
      const pausedSuffix =
        liveTrigger.detail === 'recorder_paused'
          ? lang === 'ar'
            ? `\n\n⏸️ <b>ملاحظة:</b> المسجل و<code>/watch</code> متوقفان حالياً بأمر <code>/stop recorder</code> — سيعودان للعمل تلقائياً مع أول أمر <code>/record ...</code> جديد.`
            : `\n\n⏸️ <b>Note:</b> Recorder & <code>/watch</code> are paused by <code>/stop recorder</code> and will resume on the next <code>/record ...</code>.`
          : ''
      const alreadyOfflineMsg = (lang === 'ar'
        ? `ℹ️ <b>الحساب <code>${escapeHtml(target.target)}</code> موجود بالفعل في قائمة المراقبة لديك!</b>\n\n` +
          `📡 <b>الحالة الآن:</b> غير مباشر (${escapeHtml(liveTrigger.detail || 'Offline')})\n` +
          `⏱️ البوت يراقبه باستمرار في السحابة، وفور أن يفتح لايف سيبدأ التسجيل فوراً ويرسل لك إشعاراً.`
        : `ℹ️ <b>Target <code>${escapeHtml(target.target)}</code> is already in your watchlist!</b>\n\n` +
          `📡 <b>Current status:</b> Offline (${escapeHtml(liveTrigger.detail || 'Offline')})\n` +
          `Will record automatically when live.`) + pausedSuffix

      await tg.call('sendMessage', {
        chat_id: chatId,
        text: alreadyOfflineMsg,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
      })
      return
    }
  } catch (e) {
    console.error('Immediate live check error:', e)
  }

  const tokenWarning =
    liveTrigger?.detail === 'no_github_token'
      ? lang === 'ar'
        ? `\n\n⚠️ <b>تنبيه:</b> التسجيل السحابي غير مهيأ (GITHUB_TOKEN غير مضبوط)، فالمراقبة وحدها لن تبدأ أي تسجيل.`
        : `\n\n⚠️ <b>Warning:</b> cloud recording is not configured (GITHUB_TOKEN is missing), so watching alone will not start any recording.`
      : liveTrigger?.detail === 'recorder_paused'
        ? lang === 'ar'
          ? `\n\n⏸️ <b>ملاحظة:</b> المسجل و<code>/watch</code> متوقفان حالياً بأمر <code>/stop recorder</code> — سيعودان للعمل تلقائياً مع أول أمر <code>/record ...</code> جديد.`
          : `\n\n⏸️ <b>Note:</b> Recorder & <code>/watch</code> are paused by <code>/stop recorder</code> and will resume on the next <code>/record ...</code>.`
        : ''
  const successMsg =
    (lang === 'ar'
      ? `✅ <b>تمت الإضافة لقائمة المراقبة والتسجيل التلقائي!</b>\n\n` +
        `👤 <b>الحساب:</b> <code>${escapeHtml(res.target!.target)}</code> (${plat})\n` +
        `⏱️ <b>الفحص:</b> كل ${WATCH_CHECK_INTERVAL_MINUTES} دقائق\n` +
        `🎥 <b>الإجراء:</b> البوت يراقب الحساب باستمرار، وأول ما يفتح لايف سيبدأ التسجيل السحابي تلقائياً ويرسل لك الفيديو — حتى وجهازك مغلق!`
      : `✅ <b>Added to Auto-Record Watchlist!</b>\n\n` +
        `👤 <b>Target:</b> <code>${escapeHtml(res.target!.target)}</code> (${plat})\n` +
        `⏱️ <b>Interval:</b> Checked every ${WATCH_CHECK_INTERVAL_MINUTES} minutes\n` +
        `🎥 <b>Action:</b> The bot keeps watching and will start recording automatically when live.`) + tokenWarning

  await tg.call('sendMessage', {
    chat_id: chatId,
    text: successMsg,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}

async function handleUnwatchCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  _env: Env,
  store: Store,
): Promise<void> {
  const chatId = message.chat.id
  if (!rest) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '⚠️ أرسل الحساب لإلغاء مراقبته، مثال:\n<code>/unwatch @username</code>' : '⚠️ Usage: /unwatch @username',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const res = await removeWatchTarget(chatId, rest, store)
  await tg.call('sendMessage', {
    chat_id: chatId,
    text: res.count > 0
      ? (lang === 'ar' ? `✅ تم إلغاء مراقبة <code>${escapeHtml(rest)}</code>.` : `✅ Stopped watching <code>${escapeHtml(rest)}</code>.`)
      : (lang === 'ar' ? `⚠️ الحساب غير موجود في قائمة مراقبتك.` : `⚠️ Target not found in watchlist.`),
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}

async function handleWatchListCommand(
  tg: TelegramApi,
  message: TgMessage,
  lang: Lang,
  _env: Env,
  store: Store,
): Promise<void> {
  const chatId = message.chat.id
  const list = await listUserWatchTargets(chatId, store)
  if (!list.length) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar'
        ? '📋 <b>قائمة المراقبة فارغة حالياً.</b>\nأضف حسابات ترغب بمراقبتها عبر:\n<code>/watch @username</code>'
        : '📋 <b>Your watchlist is empty.</b>\nAdd targets with /watch @username',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const items = list
    .map((t, i) => `${i + 1}. <code>${escapeHtml(t.target)}</code> (${t.platform === 'tiktok' ? 'TikTok' : 'Chaturbate'})`)
    .join('\n')

  const text = lang === 'ar'
    ? `📋 <b>حساباتك قيد المراقبة والتسجيل التلقائي:</b>\n\n${items}\n\n💡 لإلغاء أي حساب: <code>/unwatch &lt;الاسم&gt;</code>`
    : `📋 <b>Your Auto-Record Watchlist:</b>\n\n${items}\n\n💡 To remove: <code>/unwatch &lt;name&gt;</code>`

  await tg.call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}

async function handleTrimCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'

  if (!token) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '⚠️ خدمة القص السحابي غير مهيأة.' : '⚠️ Trimming service not configured.',
      reply_to_message_id: message.message_id,
    })
    return
  }

  // Parse arguments: /trim <start> <end> [url]
  const parts = rest.trim().split(/\s+/).filter(Boolean)
  let start = ''
  let end = ''
  let url = ''

  if (parts.length >= 3) {
    start = parts[0]
    end = parts[1]
    url = parts.slice(2).join(' ')
  } else if (parts.length === 2) {
    start = parts[0]
    end = parts[1]
  }

  // If URL not in arguments, try current message or reply
  if (!url) {
    const curFileId = message.video?.file_id || 
      (message.document?.mime_type?.startsWith('video/') ? message.document.file_id : undefined) ||
      message.animation?.file_id

    if (curFileId && env.BOT_TOKEN) {
      try {
        const fileInfo = await tg.call<{ file_id: string; file_path?: string }>('getFile', { file_id: curFileId })
        if (fileInfo?.file_path) {
          url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`
        }
      } catch (err) {
        console.error('Failed to getFile from current message for trim:', err)
      }
    }

    const reply = message.reply_to_message
    if (!url && reply) {
      const replyFileId = reply.video?.file_id ||
        (reply.document?.mime_type?.startsWith('video/') ? reply.document.file_id : undefined) ||
        reply.animation?.file_id

      if (replyFileId && env.BOT_TOKEN) {
        try {
          const fileInfo = await tg.call<{ file_id: string; file_path?: string }>('getFile', { file_id: replyFileId })
          if (fileInfo?.file_path) {
            url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`
          }
        } catch (err) {
          console.error('Failed to getFile from reply message for trim:', err)
        }
      }

      if (!url) {
        const text = reply.text || reply.caption || ''
        const urlMatch = text.match(/https?:\/\/[^\s]+/)
        if (urlMatch) url = urlMatch[0]
      }
    }
  }

  if (/gofile\.io\/d\//i.test(url)) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar'
        ? `⚠️ <b>تنبيه بخصوص رابط Gofile:</b>\n\n` +
          `الرابط المرسل (<code>${escapeHtml(url)}</code>) هو صفحة عرض وتنزيل ويب وليس رابط تدفق فيديو مباشر لـ ffmpeg.\n\n` +
          `💡 <b>طريقة القص أو الاستخراج الصحيحة:</b>\n` +
          `1. <b>إذا كان الفيديو في تيليجرام:</b> اعمل رد (Reply) مباشرة على رسالة الفيديو واكتب: <code>/trim ${escapeHtml(start)} ${escapeHtml(end)}</code>.\n` +
          `2. <b>إذا حملته من Gofile:</b> افتح الصفحة بالمتصفح واضغط كليك يمين على زر Download واختر <i>Copy link address</i> (نسخ عنوان الرابط المباشر المنتهي بـ mp4) واستخدمه هنا.`
        : `⚠️ <b>Gofile URL is a web viewer page, not a direct video stream:</b>\n\nPlease reply directly to the video in Telegram or right-click the Download button on Gofile and copy the direct stream link.`,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  if (!start || !end || !url) {
    const helpMsg = lang === 'ar'
      ? `✂️ <b>أداة قص واقتطاع الفيديو السريعة (/trim)</b>\n\n` +
        `طريقة الاستخدام:\n` +
        `1. مع الرابط مباشرة:\n` +
        `<code>/trim 00:01:00 00:02:30 https://pixeldrain.com/u/...</code>\n` +
        `أو بالثواني:\n` +
        `<code>/trim 60 150 https://pixeldrain.com/u/...</code>\n\n` +
        `2. أو بالرد على رسالة بها فيديو/رابط:\n` +
        `<code>/trim 00:00:10 00:00:45</code>\n\n` +
        `💡 يتم القص سحابياً وإرسال الفيديو المقتطع إليك مباشرة في تيليجرام مع رابط تحميل سريع.`
      : `✂️ <b>Cloud Video Trimmer (/trim)</b>\n\n` +
        `Usage:\n` +
        `<code>/trim 00:01:00 00:02:30 https://...</code>\n` +
        `Or reply to a video/link:\n` +
        `<code>/trim 00:00:10 00:00:45</code>`

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: helpMsg,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: lang === 'ar'
      ? `⏳ <b>جاري قص الفيديو سحابياً…</b>\n⏱️ من: <code>${escapeHtml(start)}</code> إلى: <code>${escapeHtml(end)}</code>\nسيتم إرسال المقطع هنا خلال ثوانٍ.`
      : `⏳ Trimming video in cloud (from ${escapeHtml(start)} to ${escapeHtml(end)})…`,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  try {
    const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/trim.yml/dispatches`
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SaveLink-Telegram-Bot',
        'Content-Type': 'application/json',
      },
      // NOTE: the bot token is NOT sent here. Workflow inputs are visible in
      // the Actions UI of the public repo; the runner reads BOT_TOKEN from a
      // GitHub secret instead (see .github/workflows/trim.yml).
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          url,
          start,
          end,
          chat_id: String(chatId),
        },
      }),
    })

    if (!res.ok && res.status !== 204) {
      const err = await res.text()
      throw new Error(`GitHub error: ${err}`)
    }
  } catch (e: any) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ تعذر بدء القص: ${escapeHtml(e.message)}`,
      parse_mode: 'HTML',
    })
  }
}

export function parseFrameCommandArgs(rest: string): { start: string; end: string; url: string } | null {
  const trimmed = rest.trim()
  if (!trimmed) return null

  // 1. Hyphenated range: "00:01-0:20 [url]" or "00:01 - 0:20 [url]"
  const hyphenMatch = trimmed.match(/^(\d{1,2}(?::\d{1,2}){0,2})\s*-\s*(\d{1,2}(?::\d{1,2}){0,2})(?:\s+([\s\S]*))?$/)
  if (hyphenMatch) {
    return {
      start: hyphenMatch[1],
      end: hyphenMatch[2],
      url: hyphenMatch[3]?.trim() || '',
    }
  }

  // 2. Space-separated: "00:01 0:20 [url]"
  const spaceMatch = trimmed.match(/^(\d{1,2}(?::\d{1,2}){0,2})\s+(\d{1,2}(?::\d{1,2}){0,2})(?:\s+([\s\S]*))?$/)
  if (spaceMatch) {
    return {
      start: spaceMatch[1],
      end: spaceMatch[2],
      url: spaceMatch[3]?.trim() || '',
    }
  }

  return null
}

export function parseTimestampSeconds(ts: string): number {
  const parts = ts.trim().split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 1) return parts[0]
  return 0
}

async function handleFrameCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'

  if (!token) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '⚠️ خدمة استخراج الفريمات غير مهيأة.' : '⚠️ Frame extraction service not configured.',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const parsed = parseFrameCommandArgs(rest)
  let start = parsed?.start || ''
  let end = parsed?.end || ''
  let url = parsed?.url || ''

  // If URL not in arguments, try current message or reply
  if (!url) {
    // 1. Current message video/document/animation
    const curFileId = message.video?.file_id || 
      (message.document?.mime_type?.startsWith('video/') ? message.document.file_id : undefined) ||
      message.animation?.file_id

    if (curFileId && env.BOT_TOKEN) {
      try {
        const fileInfo = await tg.call<{ file_id: string; file_path?: string }>('getFile', { file_id: curFileId })
        if (fileInfo?.file_path) {
          url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`
        }
      } catch (err) {
        console.error('Failed to getFile from current message:', err)
      }
    }

    // 2. Replied message
    const reply = message.reply_to_message
    if (!url && reply) {
      const replyFileId = reply.video?.file_id ||
        (reply.document?.mime_type?.startsWith('video/') ? reply.document.file_id : undefined) ||
        reply.animation?.file_id

      if (replyFileId && env.BOT_TOKEN) {
        try {
          const fileInfo = await tg.call<{ file_id: string; file_path?: string }>('getFile', { file_id: replyFileId })
          if (fileInfo?.file_path) {
            url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileInfo.file_path}`
          }
        } catch (err) {
          console.error('Failed to getFile from reply message:', err)
        }
      }

      if (!url) {
        const replyText = reply.text || reply.caption || ''
        const urlMatch = replyText.match(/https?:\/\/[^\s]+/)
        if (urlMatch) url = urlMatch[0]
      }
    }
  }

  if (url && /gofile\.io\/d\//i.test(url)) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar'
        ? `⚠️ <b>تنبيه بخصوص رابط Gofile:</b>\n\n` +
          `الرابط المرسل (<code>${escapeHtml(url)}</code>) هو صفحة عرض وتنزيل ويب وليس رابط تدفق فيديو مباشر لـ ffmpeg.\n\n` +
          `💡 <b>طريقة استخراج الفريمات الصحيحة:</b>\n` +
          `1. <b>إذا كان الفيديو في تيليجرام:</b> اعمل رد (Reply) مباشرة على رسالة الفيديو واكتب: <code>/frame ${escapeHtml(start || '00:01')}-${escapeHtml(end || '00:20')}</code>.\n` +
          `2. <b>إذا حملته من Gofile:</b> افتح الصفحة بالمتصفح واضغط كليك يمين على زر Download واختر <i>Copy link address</i> (نسخ عنوان الرابط المباشر المنتهي بـ mp4) واستخدمه هنا.`
        : `⚠️ <b>Gofile URL is a web viewer page, not a direct video stream:</b>\n\nPlease reply directly to the video in Telegram or right-click the Download button on Gofile and copy the direct stream link.`,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  if (!start || !end || !url) {
    const helpMsg = lang === 'ar'
      ? `🎞️ <b>أداة استخراج فريمات الفيديو الحرفية (/frame)</b>\n\n` +
        `تستخرج <b>كل فريم في الفيديو حرفياً</b> بدون تفويت أي لقطة، وترسل لك ألبوم معاينة فورية + ملف ZIP كامل بجميع الصور بدقتها الأصلية!\n\n` +
        `<b>طرق الاستخدام:</b>\n` +
        `1. <b>بالرد (Reply) على أي فيديو أو رابط:</b>\n` +
        `<code>/frame 00:01-0:20</code>\n` +
        `أو بالمسافة:\n` +
        `<code>/frame 00:01 00:20</code>\n\n` +
        `2. <b>كـ Caption مع فيديو ترسله للبوت مباشرة:</b>\n` +
        `اكتب في الوصف: <code>/frame 00:00-00:15</code>\n\n` +
        `3. <b>مع رابط الفيديو مباشرة:</b>\n` +
        `<code>/frame 00:01-0:20 https://pixeldrain.com/u/...</code>\n\n` +
        `💡 <i>أقصى مدة للنطاق الزمني هي 60 ثانية لضمان سرعة المعالجة وجودة الملفات.</i>`
      : `🎞️ <b>Cloud Video Frame Extractor (/frame)</b>\n\n` +
        `Extracts <b>every single video frame literally</b> in the specified range and sends a preview album + full ZIP archive!\n\n` +
        `<b>Usage:</b>\n` +
        `1. Reply to video/link:\n` +
        `<code>/frame 00:01-0:20</code>\n\n` +
        `2. Direct URL:\n` +
        `<code>/frame 00:01-0:20 https://...</code>\n\n` +
        `3. Send as caption with uploaded video:\n` +
        `<code>/frame 00:00-00:10</code>`

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: helpMsg,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const startSec = parseTimestampSeconds(start)
  const endSec = parseTimestampSeconds(end)
  const durationSec = endSec - startSec

  if (durationSec <= 0) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar'
        ? `❌ <b>خطأ في التوقيت:</b> وقت النهاية (<code>${escapeHtml(end)}</code>) يجب أن يكون أكبر من وقت البداية (<code>${escapeHtml(start)}</code>).`
        : `❌ <b>Time error:</b> End time must be greater than start time.`,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  if (durationSec > 60) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar'
        ? `⚠️ <b>تنبيه:</b> أقصى فترة مسموحة لاستخراج جميع الفريمات حرفياً هي <b>60 ثانية</b> (الفترة المطلوبة: ${Math.round(durationSec)} ثانية).\nيرجى تحديد نطاق زمني أقل من دقيقة لضمان سرعة المعالجة وتفادي تضخم حجم الملف.`
        : `⚠️ <b>Limit reached:</b> Maximum time window for literal frame extraction is 60 seconds (requested: ${Math.round(durationSec)}s). Please choose a shorter range.`,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: lang === 'ar'
      ? `⏳ <b>جاري استخراج جميع فريمات الفيديو سحابياً…</b>\n⏱️ الفترة: من <code>${escapeHtml(start)}</code> إلى <code>${escapeHtml(end)}</code> (${Math.round(durationSec)} ثانية)\n🖼️ سيتم إرسال ألبوم المعاينة وملف الـ ZIP الكامل فور اكتمال الاستخراج.`
      : `⏳ Extracting all video frames in cloud (from ${escapeHtml(start)} to ${escapeHtml(end)})…`,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  try {
    const dispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/frame.yml/dispatches`
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SaveLink-Telegram-Bot',
        'Content-Type': 'application/json',
      },
      // NOTE: the bot token is NOT sent here. Workflow inputs are visible in
      // the Actions UI of the public repo; the runner reads BOT_TOKEN from a
      // GitHub secret instead (see .github/workflows/frame.yml).
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          url,
          start,
          end,
          chat_id: String(chatId),
        },
      }),
    })

    if (!res.ok && res.status !== 204) {
      const err = await res.text()
      throw new Error(`GitHub error: ${err}`)
    }
  } catch (e: any) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ تعذر بدء استخراج الفريمات: ${escapeHtml(e.message)}`,
      parse_mode: 'HTML',
    })
  }
}

interface StoredYouTubeVideo {
  videoId: string
  title: string
  author: string
  duration?: number
  thumbnail?: string
  url: string
}

async function handleYouTubeLink(
  tg: TelegramApi,
  message: TgMessage,
  url: string,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const chatId = message.chat.id

  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  // 1. YouTube playlist
  const plTarget = parseYouTubePlaylist(url)
  if (plTarget) {
    const status = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'resolving', { platform: platformName('youtube', lang) }),
      reply_to_message_id: message.message_id,
    })
    try {
      const pl = await fetchYouTubePlaylist(plTarget.playlistId)
      if (!pl.items.length) {
        throw new Error('Playlist is empty or private')
      }
      const key = shortKey()
      await store.put(`ytpl:${key}`, JSON.stringify(pl), 3600)

      const kb = {
        inline_keyboard: [
          [
            { text: t(lang, 'ytPlaylistVideoBtn'), callback_data: `ytplf|${key}|video` },
          ],
          [
            { text: t(lang, 'ytPlaylistAudioBtn'), callback_data: `ytplf|${key}|audio` },
          ],
          [
            { text: t(lang, 'ytPlaylistBrowseBtn'), callback_data: `ytpli|${key}|0` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'ytPlaylistTitle', {
          title: escapeHtml(pl.title),
          author: escapeHtml(pl.author),
          count: pl.videoCount,
        }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
      return
    } catch (error) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'resolveFailed', { reason: errorMessage(error) }),
        parse_mode: 'HTML',
      })
      return
    }
  }

  // 2. YouTube single video
  const vTarget = parseYouTubeVideo(url)
  if (vTarget) {
    const status = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'resolving', { platform: platformName('youtube', lang) }),
      reply_to_message_id: message.message_id,
    })
    try {
      const details = await fetchYouTubeVideoDetails(vTarget.videoId)
      const key = shortKey()
      await store.put(`ytv:${key}`, JSON.stringify({ ...details, url }), 3600)

      const kb = {
        inline_keyboard: [
          [
            { text: t(lang, 'ytVideoFormatBtn'), callback_data: `ytf|${key}|video` },
            { text: t(lang, 'ytAudioFormatBtn'), callback_data: `ytf|${key}|audio` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'ytChooseFormat', {
          title: escapeHtml(details.title),
          author: escapeHtml(details.author),
          duration: formatDuration(details.duration),
        }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
      return
    } catch (error) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'resolveFailed', { reason: errorMessage(error) }),
        parse_mode: 'HTML',
      })
      return
    }
  }

  await tg.call('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'unsupported'),
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}

async function handleCoomerLink(
  tg: TelegramApi,
  message: TgMessage,
  url: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const target = parseCoomerUrl(url)
  if (!target) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'unsupported'),
      reply_to_message_id: message.message_id,
    })
    return
  }

  // Single post
  if (target.postId) {
    const status = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'resolving', { platform: 'Coomer' }),
      reply_to_message_id: message.message_id,
    })
    try {
      const result = await resolveMedia({ url, mode: 'video', quality: 'max' }, env, store)
      const items = trimForTelegram(result.items)
      if (!items.length) throw new ResolveError('empty_result', 'No downloadable media found in this post.')

      const key = shortKey()
      const stored: StoredMedia = { result, items, lang }
      await store.put(`m:${key}`, JSON.stringify(stored), 3600)

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: summary(result, lang),
        parse_mode: 'HTML',
        reply_markup: await buildKeyboard(result, items, key, lang, env, origin),
        disable_web_page_preview: true,
      })
    } catch (error) {
      await reportFailure(tg, chatId, status.message_id, error, lang, env)
    }
    return
  }

  // Profile / user with offset / page
  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: target.domain.includes('coomerfans') ? 'CoomerFans' : 'Coomer' }),
    reply_to_message_id: message.message_id,
  })

  try {
    if (target.domain.includes('coomerfans')) {
      const pageNum = target.page ?? 1
      const profile = await fetchCoomerFansPosts(target.service, target.creatorId, target.username, pageNum)
      if (!profile || !profile.posts.length) {
        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: status.message_id,
          text: t(lang, 'cmrNoVideos'),
          parse_mode: 'HTML',
        })
        return
      }

      const videos: CoomerMediaVideo[] = profile.posts.map((p) => ({
        id: p.id,
        title: p.title,
        published: p.date,
        videoUrl: `https://coomerfans.com${p.url}`,
        postUrl: p.url,
        filename: `${p.id}.mp4`,
      }))

      const key = shortKey()
      const storedPage: StoredCoomerPage = {
        domain: target.domain,
        service: target.service,
        creatorId: target.creatorId,
        username: target.username || profile.title,
        offset: pageNum,
        videos,
        lang,
      }
      await store.put(`cmr:${key}`, JSON.stringify(storedPage), 3600)

      const kb = buildCoomerKeyboard(storedPage, key, lang)
      const text = t(lang, 'cmrProfileTitle', {
        creator: escapeHtml(profile.title || target.creatorId),
        service: escapeHtml(target.service),
        page: pageNum,
        count: videos.length,
      })

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text,
        parse_mode: 'HTML',
        reply_markup: kb,
        disable_web_page_preview: true,
      })
      return
    }

    const offset = target.offset ?? 0
    const posts = await fetchCoomerPosts(target.domain, target.service, target.creatorId, offset)
    const videos = extractVideosFromPosts(posts, target.domain)

    if (!videos.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'cmrNoVideos'),
        parse_mode: 'HTML',
      })
      return
    }

    const key = shortKey()
    const storedPage: StoredCoomerPage = {
      domain: target.domain,
      service: target.service,
      creatorId: target.creatorId,
      offset,
      videos,
      lang,
    }
    await store.put(`cmr:${key}`, JSON.stringify(storedPage), 3600)

    const kb = buildCoomerKeyboard(storedPage, key, lang)
    const pageNum = Math.floor(offset / 50) + 1
    const text = t(lang, 'cmrProfileTitle', {
      creator: escapeHtml(target.creatorId),
      service: escapeHtml(target.service),
      page: pageNum,
      count: videos.length,
    })

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text,
      parse_mode: 'HTML',
      reply_markup: kb,
      disable_web_page_preview: true,
    })
  } catch (error) {
    await reportFailure(tg, chatId, status.message_id, error, lang, env)
  }
}

function buildCoomerKeyboard(
  page: StoredCoomerPage,
  key: string,
  lang: Lang,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  const rows: Array<Array<{ text: string; callback_data: string }>> = []

  for (let i = 0; i < Math.min(8, page.videos.length); i++) {
    const vid = page.videos[i]
    const title = cleanButtonText(vid.title, 28)
    rows.push([
      { text: `📹 ${i + 1}. ${title}`, callback_data: `cmrv|${key}|${i}` },
    ])
  }

  const isFans = page.domain.includes('coomerfans')
  const navRow: Array<{ text: string; callback_data: string }> = []

  if (isFans) {
    const prevPage = page.offset - 1
    const nextPage = page.offset + 1
    if (page.offset > 1) {
      navRow.push({ text: `⬅️ Prev (${prevPage})`, callback_data: `cmrp|${key}|${prevPage}` })
    }
    navRow.push({ text: `Next (${nextPage}) ➡️`, callback_data: `cmrp|${key}|${nextPage}` })
  } else {
    const prevOffset = Math.max(0, page.offset - 50)
    const nextOffset = page.offset + 50
    if (page.offset > 0) {
      navRow.push({ text: t(lang, 'cmrPrevPage', { offset: prevOffset }), callback_data: `cmrp|${key}|${prevOffset}` })
    }
    navRow.push({ text: t(lang, 'cmrNextPage', { offset: nextOffset }), callback_data: `cmrp|${key}|${nextOffset}` })
  }

  if (navRow.length) rows.push(navRow)

  return { inline_keyboard: rows }
}

async function handleCoomerCallback(
  tg: TelegramApi,
  query: any,
  chatId: number | string,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const tag = parts[0]
  const key = parts[1]

  const raw = await store.get(`cmr:${key}`)
  if (!raw) {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  const page = JSON.parse(raw) as StoredCoomerPage

  // 1. Pagination: cmrp|key|targetOffset
  if (tag === 'cmrp') {
    if (page.domain.includes('coomerfans')) {
      const targetPage = parseInt(parts[2], 10) || 1
      await answer(tg, query?.id, '')

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'resolving', { platform: 'CoomerFans' }),
      })

      try {
        const profile = await fetchCoomerFansPosts(page.service, page.creatorId, page.username, targetPage)
        if (!profile || !profile.posts.length) {
          await tg.safeEdit('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text: t(lang, 'cmrNoVideos'),
          })
          return
        }

        const videos: CoomerMediaVideo[] = profile.posts.map((p) => ({
          id: p.id,
          title: p.title,
          published: p.date,
          videoUrl: `https://coomerfans.com${p.url}`,
          postUrl: p.url,
          filename: `${p.id}.mp4`,
        }))

        const newKey = shortKey()
        const newPage: StoredCoomerPage = {
          ...page,
          offset: targetPage,
          videos,
        }
        await store.put(`cmr:${newKey}`, JSON.stringify(newPage), 3600)

        const kb = buildCoomerKeyboard(newPage, newKey, lang)
        const text = t(lang, 'cmrProfileTitle', {
          creator: escapeHtml(profile.title || page.creatorId),
          service: escapeHtml(page.service),
          page: targetPage,
          count: videos.length,
        })

        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text,
          parse_mode: 'HTML',
          reply_markup: kb,
          disable_web_page_preview: true,
        })
      } catch (error) {
        await reportFailure(tg, chatId, messageId, error, lang, env)
      }
      return
    }

    const targetOffset = parseInt(parts[2], 10) || 0
    await answer(tg, query?.id, '')

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'resolving', { platform: 'Coomer' }),
    })

    try {
      const posts = await fetchCoomerPosts(page.domain, page.service, page.creatorId, targetOffset)
      const videos = extractVideosFromPosts(posts, page.domain)
      if (!videos.length) {
        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: t(lang, 'cmrNoVideos'),
        })
        return
      }

      const newKey = shortKey()
      const newPage: StoredCoomerPage = {
        ...page,
        offset: targetOffset,
        videos,
      }
      await store.put(`cmr:${newKey}`, JSON.stringify(newPage), 3600)

      const kb = buildCoomerKeyboard(newPage, newKey, lang)
      const pageNum = Math.floor(targetOffset / 50) + 1
      const text = t(lang, 'cmrProfileTitle', {
        creator: escapeHtml(page.creatorId),
        service: escapeHtml(page.service),
        page: pageNum,
        count: videos.length,
      })

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        reply_markup: kb,
        disable_web_page_preview: true,
      })
    } catch (error) {
      await reportFailure(tg, chatId, messageId, error, lang, env)
    }
    return
  }

  // 2. Download single video: cmrv|key|videoIndex
  if (tag === 'cmrv') {
    const vidIndex = parseInt(parts[2], 10)
    const vid = page.videos[vidIndex]
    if (!vid) {
      await answer(tg, query?.id, 'Video not found', true)
      return
    }

    await answer(tg, query?.id, '')

    const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'cmrDownloading'),
    })

    if (page.domain.includes('coomerfans')) {
      try {
        const post = await fetchCoomerFansPost(vid.id, page.creatorId, page.service)
        if (!post) throw new Error('Post not found or unavailable')

        const items: MediaItem[] = []
        for (let i = 0; i < post.videos.length; i++) {
          items.push({
            kind: 'video',
            url: post.videos[i],
            ext: 'mp4',
            mime: 'video/mp4',
            label: post.videos.length > 1 ? `Video ${i + 1}` : post.title.slice(0, 30),
          })
        }
        for (let i = 0; i < post.images.length; i++) {
          items.push({
            kind: 'image',
            url: post.images[i],
            ext: 'jpg',
            mime: 'image/jpeg',
            label: `Photo ${i + 1}`,
          })
        }

        if (!items.length) {
          await tg.safeEdit('editMessageText', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            text: lang === 'ar' ? '❌ لا يوجد وسائط قابلة للتحميل في هذا المنشور.' : '❌ No downloadable media in this post.',
          })
          return
        }

        for (const item of items.slice(0, 5)) {
          try {
            await sendMedia(tg, chatId, item, {
              caption: `📹 <b>${escapeHtml(post.title)}</b>\n👤 ${escapeHtml(page.username || page.creatorId)} (${escapeHtml(page.service)})`,
              filename: `${vid.id}.${item.ext}`,
              maxBytes: maxUploadBytes(env),
            })
          } catch (error) {
            if (error instanceof UploadTooLarge) {
              const directUrl = await signFileUrl(item, `${vid.id}.${item.ext}`, env, origin, 86400)
              await reportFailure(tg, chatId, statusMsg.message_id, error, lang, env, directUrl)
              return
            }
            throw error
          }
        }

        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: t(lang, 'sent', { label: post.title.slice(0, 30) }),
          parse_mode: 'HTML',
        })
      } catch (error) {
        await reportFailure(tg, chatId, statusMsg.message_id, error, lang, env)
      }
      return
    }

    const urlsToTry = vid.videoPath
      ? buildCoomerCdnUrls(page.domain, vid.videoPath)
      : [vid.videoUrl]

    let sent = false
    let lastError: unknown

    for (const u of urlsToTry) {
      const item: MediaItem = {
        kind: 'video',
        url: u,
        ext: 'mp4',
        mime: 'video/mp4',
        label: vid.title,
      }

      try {
        await sendMedia(tg, chatId, item, {
          caption: `📹 <b>${escapeHtml(vid.title)}</b>\n👤 ${escapeHtml(page.creatorId)} (${escapeHtml(page.service)})`,
          filename: vid.filename,
          maxBytes: maxUploadBytes(env),
          timeoutMs: 10_000,
        })

        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: t(lang, 'sent', { label: vid.title.slice(0, 30) }),
          parse_mode: 'HTML',
        })
        sent = true
        break
      } catch (error) {
        lastError = error
        if (error instanceof UploadTooLarge) {
          const directUrl = await signFileUrl(item, vid.filename, env, origin, 86400)
          await reportFailure(tg, chatId, statusMsg.message_id, error, lang, env, directUrl)
          sent = true
          break
        }
      }
    }

    if (!sent) {
      const errText = lastError ? errorMessage(lastError) : 'Timeout'
      const is522 = errText.includes('522') || errText.includes('timeout') || errText.includes('Abort')
      const directUrl = await signFileUrl(
        { kind: 'video', url: urlsToTry[0], ext: 'mp4', mime: 'video/mp4' },
        vid.filename,
        env,
        origin,
        86400,
      )

      const msg = is522
        ? (lang === 'ar'
            ? '⚠️ سيرفرات تخزين ملفات Coomer تعاني من انقطاع أو بطء حالياً من المصدر (Cloudflare Timeout).\nيمكنك تجربة الرابط المباشر في المتصفح أو عبر سيرفر البوت:'
            : '⚠️ Coomer media storage servers are temporarily unreachable (Cloudflare Timeout).\nTry opening the direct link in your browser or bot proxy:')
        : t(lang, 'downloadFailed', { reason: escapeHtml(errText.slice(0, 320)) })

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: msg,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: lang === 'ar' ? '🌐 فتح الرابط في المتصفح' : '🌐 Open in browser', url: urlsToTry[0] }],
            [{ text: lang === 'ar' ? '🚀 رابط مباشر بديل (سيرفر البوت)' : '🚀 Direct Bot Proxy Link', url: directUrl }],
          ],
        },
      })
    }
    return
  }
}

// ==========================================
// EROME HANDLERS
// ==========================================

async function handleEromeSearch(
  tg: TelegramApi,
  message: TgMessage,
  query: string,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'eromeSearching', { query: escapeHtml(query) }),
    reply_to_message_id: message.message_id,
    parse_mode: 'HTML',
  })

  try {
    const albums = await searchErome(query, 1)
    if (!albums.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'eromeNoResults', { query: escapeHtml(query) }),
        parse_mode: 'HTML',
      })
      return
    }

    const key = shortKey()
    const stored: StoredEromeSearch = { query, albums, offset: 0, lang }
    await store.put(`erm_s:${key}`, JSON.stringify(stored), 3600)

    const kb = buildEromeSearchKeyboard(stored, key, lang)
    const caption = lang === 'ar'
      ? `✨ نتائج البحث في <b>Erome</b>: "${escapeHtml(query)}"\n📁 عُثر على ${albums.length} ألبومات. اختر ألبوماً لعرض فيديوهاته:`
      : `✨ <b>Erome</b> Search Results: "${escapeHtml(query)}"\n📁 Found ${albums.length} albums. Pick one:`

    if (albums[0]?.thumb) {
      try {
        await tg.call('sendPhoto', {
          chat_id: chatId,
          photo: albums[0].thumb,
          caption,
          parse_mode: 'HTML',
          reply_markup: kb,
          reply_to_message_id: message.message_id,
        })
        await tg.call('deleteMessage', { chat_id: chatId, message_id: status.message_id }).catch(() => undefined)
        return
      } catch {
        // Fallback to text
      }
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: kb,
    })
  } catch (error) {
    await reportFailure(tg, chatId, status.message_id, error, lang, env)
  }
}

function buildEromeSearchKeyboard(stored: StoredEromeSearch, key: string, lang: Lang): InlineKeyboard {
  const PAGE_SIZE = 6
  const pageItems = stored.albums.slice(stored.offset, stored.offset + PAGE_SIZE)
  const rows: InlineButton[][] = []

  for (let i = 0; i < pageItems.length; i++) {
    const alb = pageItems[i]
    const idx = stored.offset + i + 1
    const vCount = alb.videosCount ? ` (${alb.videosCount} 📹)` : ''
    rows.push([
      {
        text: cleanButtonText(`${idx}. 📁 ${alb.title}${vCount}`, 32),
        callback_data: `erm|a|${alb.id}`,
      },
    ])
  }

  const navRow: InlineButton[] = []
  if (stored.offset > 0) {
    navRow.push({
      text: '⬅️ ' + (lang === 'ar' ? 'السابق' : 'Prev'),
      callback_data: `erm|sp|${key}|${stored.offset - PAGE_SIZE}`,
    })
  }
  if (stored.offset + PAGE_SIZE < stored.albums.length) {
    navRow.push({
      text: (lang === 'ar' ? 'التالي' : 'Next') + ' ➡️',
      callback_data: `erm|sp|${key}|${stored.offset + PAGE_SIZE}`,
    })
  }
  if (navRow.length) rows.push(navRow)

  return { inline_keyboard: rows }
}

async function handleEromeLink(
  tg: TelegramApi,
  message: TgMessage,
  url: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const target = parseEromeUrl(url)
  if (!target) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'unsupported'),
      reply_to_message_id: message.message_id,
    })
    return
  }

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: 'Erome' }),
    reply_to_message_id: message.message_id,
  })

  await showEromeAlbum(tg, chatId, status.message_id, target.albumId, 0, lang, env, store, origin, message.message_id)
}

async function showEromeAlbum(
  tg: TelegramApi,
  chatId: number,
  messageId: number,
  albumId: string,
  offset: number,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
  replyToId?: number,
): Promise<void> {
  try {
    const album = await fetchEromeAlbum(albumId)
    if (!album || (!album.videos.length && !album.photos.length)) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: lang === 'ar' ? '⚠️ لم يتم العثور على وسائط في هذا الألبوم.' : '⚠️ No media found in this album.',
      })
      return
    }

    const key = shortKey()
    const storedAlbum: StoredEromeAlbum = { album, offset, lang }
    await store.put(`erm_alb:${key}`, JSON.stringify(storedAlbum), 3600)

    const kb = buildEromeAlbumKeyboard(storedAlbum, key, lang)
    const caption = lang === 'ar'
      ? `🎬 <b>${escapeHtml(album.title)}</b>\n👤 ${escapeHtml(album.user || 'Erome')} • 📹 ${album.videos.length} فيديو\nاختر فيديو للتنزيل:`
      : `🎬 <b>${escapeHtml(album.title)}</b>\n👤 ${escapeHtml(album.user || 'Erome')} • 📹 ${album.videos.length} videos\nPick a video to download:`

    const thumb = album.videos[0]?.thumb || album.photos[0]?.thumb
    if (thumb && replyToId) {
      try {
        await tg.call('sendPhoto', {
          chat_id: chatId,
          photo: thumb,
          caption,
          parse_mode: 'HTML',
          reply_markup: kb,
          reply_to_message_id: replyToId,
        })
        await tg.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => undefined)
        return
      } catch {
        // fallback
      }
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: kb,
    })
  } catch (error) {
    await reportFailure(tg, chatId, messageId, error, lang, env)
  }
}

function buildEromeAlbumKeyboard(stored: StoredEromeAlbum, key: string, lang: Lang): InlineKeyboard {
  const PAGE_SIZE = 8
  const videos = stored.album.videos
  const pageVideos = videos.slice(stored.offset, stored.offset + PAGE_SIZE)
  const rows: InlineButton[][] = []

  for (let i = 0; i < pageVideos.length; i++) {
    const v = pageVideos[i]
    const idx = stored.offset + i
    rows.push([
      {
        text: cleanButtonText(`${idx + 1}. 📹 ${v.title || `Video ${idx + 1}`}`, 30),
        callback_data: `erm|v|${key}|${idx}`,
      },
    ])
  }

  const navRow: InlineButton[] = []
  if (stored.offset > 0) {
    navRow.push({
      text: '⬅️ ' + (lang === 'ar' ? 'السابق' : 'Prev'),
      callback_data: `erm|ap|${key}|${stored.offset - PAGE_SIZE}`,
    })
  }
  if (stored.offset + PAGE_SIZE < videos.length) {
    navRow.push({
      text: (lang === 'ar' ? 'التالي' : 'Next') + ' ➡️',
      callback_data: `erm|ap|${key}|${stored.offset + PAGE_SIZE}`,
    })
  }
  if (navRow.length) rows.push(navRow)

  return { inline_keyboard: rows }
}

async function handleEromeCallback(
  tg: TelegramApi,
  query: any,
  chatId: number,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const action = parts[1] // 'a' | 'sp' | 'ap' | 'v'

  if (action === 'sp') {
    const key = parts[2]
    const targetOffset = parseInt(parts[3] || '0', 10)
    const raw = await store.get(`erm_s:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const stored = JSON.parse(raw) as StoredEromeSearch
    stored.offset = targetOffset
    await store.put(`erm_s:${key}`, JSON.stringify(stored), 3600)
    const kb = buildEromeSearchKeyboard(stored, key, lang)
    await tg.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: kb,
    }).catch(() => undefined)
    await answer(tg, query?.id, '')
    return
  }

  if (action === 'a') {
    const albumId = parts[2]
    await answer(tg, query?.id, '')
    const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '⏳ جاري فتح ألبوم Erome…' : '⏳ Opening Erome album…',
    })
    await showEromeAlbum(tg, chatId, statusMsg.message_id, albumId, 0, lang, env, store, origin)
    return
  }

  if (action === 'ap') {
    const key = parts[2]
    const targetOffset = parseInt(parts[3] || '0', 10)
    const raw = await store.get(`erm_alb:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const stored = JSON.parse(raw) as StoredEromeAlbum
    stored.offset = targetOffset
    await store.put(`erm_alb:${key}`, JSON.stringify(stored), 3600)
    const kb = buildEromeAlbumKeyboard(stored, key, lang)
    await tg.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: kb,
    }).catch(() => undefined)
    await answer(tg, query?.id, '')
    return
  }

  if (action === 'v') {
    const key = parts[2]
    const idx = parseInt(parts[3] || '0', 10)
    const raw = await store.get(`erm_alb:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const stored = JSON.parse(raw) as StoredEromeAlbum
    const vid = stored.album.videos[idx]
    if (!vid) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }

    await answer(tg, query?.id, '')
    const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'eromeDownloading'),
    })

    const item: MediaItem = {
      kind: 'video',
      url: vid.url,
      ext: 'mp4',
      mime: 'video/mp4',
      referer: `https://www.erome.com/a/${stored.album.id}`,
    }

    const filename = `${stored.album.id}_v${idx + 1}.mp4`
    try {
      await sendMedia(tg, chatId, item, {
        caption: `🎬 <b>${escapeHtml(stored.album.title)} - ${escapeHtml(vid.title || `Video ${idx + 1}`)}</b>`,
        filename,
        maxBytes: maxUploadBytes(env),
        timeoutMs: 30_000,
      })
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: t(lang, 'sent', { label: vid.title || `Video ${idx + 1}` }),
        parse_mode: 'HTML',
      })
    } catch (error) {
      const directUrl = await signFileUrl(item, filename, env, origin, 86400)
      if (error instanceof UploadTooLarge) {
        await reportFailure(tg, chatId, statusMsg.message_id, error, lang, env, directUrl)
      } else {
        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          text: lang === 'ar'
            ? `⚠️ تعذر إرسال الفيديو عبر تيليجرام (${escapeHtml((error as Error).message)}).\nاختر طريقة التحميل المباشر:`
            : `⚠️ Could not send video via Telegram (${escapeHtml((error as Error).message)}).\nDownload directly:`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: lang === 'ar' ? '🌐 فتح الرابط في المتصفح' : '🌐 Open in browser', url: vid.url }],
              [{ text: lang === 'ar' ? '🚀 رابط مباشر بديل (سيرفر البوت)' : '🚀 Direct Bot Proxy Link', url: directUrl }],
            ],
          },
        })
      }
    }
  }
}

// ==========================================
// BUNKR HANDLERS
// ==========================================

async function handleBunkrSearch(
  tg: TelegramApi,
  message: TgMessage,
  query: string,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'bunkrSearching', { query: escapeHtml(query) }),
    reply_to_message_id: message.message_id,
    parse_mode: 'HTML',
  })

  try {
    const results = await searchBunkr(query)
    if (!results.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'bunkrNoResults', { query: escapeHtml(query) }),
        parse_mode: 'HTML',
      })
      return
    }

    const key = shortKey()
    const stored: StoredBunkrSearch = { query, results, offset: 0, lang }
    await store.put(`bkr_s:${key}`, JSON.stringify(stored), 3600)

    const kb = buildBunkrSearchKeyboard(stored, key, lang)
    const caption = lang === 'ar'
      ? `✨ نتائج البحث في <b>Bunkr</b>: "${escapeHtml(query)}"\n📦 عُثر على ${results.length} نتيجة. اختر للفتح:`
      : `✨ <b>Bunkr</b> Search Results: "${escapeHtml(query)}"\n📦 Found ${results.length} results. Pick one:`

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: kb,
    })
  } catch (error) {
    await reportFailure(tg, chatId, status.message_id, error, lang, env)
  }
}

function buildBunkrSearchKeyboard(stored: StoredBunkrSearch, key: string, lang: Lang): InlineKeyboard {
  const PAGE_SIZE = 6
  const pageItems = stored.results.slice(stored.offset, stored.offset + PAGE_SIZE)
  const rows: InlineButton[][] = []

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i]
    const idx = stored.offset + i + 1
    const icon = item.kind === 'album' ? '📁' : '📹'
    rows.push([
      {
        text: cleanButtonText(`${idx}. ${icon} ${item.title}`, 32),
        callback_data: item.kind === 'album' ? `bkr|a|${item.id}` : `bkr|f|${item.id}`,
      },
    ])
  }

  const navRow: InlineButton[] = []
  if (stored.offset > 0) {
    navRow.push({
      text: '⬅️ ' + (lang === 'ar' ? 'السابق' : 'Prev'),
      callback_data: `bkr|sp|${key}|${stored.offset - PAGE_SIZE}`,
    })
  }
  if (stored.offset + PAGE_SIZE < stored.results.length) {
    navRow.push({
      text: (lang === 'ar' ? 'التالي' : 'Next') + ' ➡️',
      callback_data: `bkr|sp|${key}|${stored.offset + PAGE_SIZE}`,
    })
  }
  if (navRow.length) rows.push(navRow)

  return { inline_keyboard: rows }
}

async function handleBunkrLink(
  tg: TelegramApi,
  message: TgMessage,
  url: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const target = parseBunkrUrl(url)
  if (!target) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'unsupported'),
      reply_to_message_id: message.message_id,
    })
    return
  }

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: 'Bunkr' }),
    reply_to_message_id: message.message_id,
  })

  if (target.kind === 'album') {
    await showBunkrAlbum(tg, chatId, status.message_id, target.id, target.domain, 0, lang, env, store, origin, message.message_id)
  } else {
    await downloadBunkrFile(tg, chatId, status.message_id, target.id, target.domain, lang, env, origin)
  }
}

async function showBunkrAlbum(
  tg: TelegramApi,
  chatId: number,
  messageId: number,
  albumId: string,
  domain: string,
  offset: number,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
  _replyToId?: number,
): Promise<void> {
  try {
    const album = await fetchBunkrAlbum(albumId, domain)
    if (!album || !album.files.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: lang === 'ar' ? '⚠️ لم يتم العثور على ملفات في هذا الألبوم.' : '⚠️ No files found in this album.',
      })
      return
    }

    const key = shortKey()
    const storedAlbum: StoredBunkrAlbum = { album, offset, lang }
    await store.put(`bkr_alb:${key}`, JSON.stringify(storedAlbum), 3600)

    const kb = buildBunkrAlbumKeyboard(storedAlbum, key, lang)
    const caption = lang === 'ar'
      ? `📁 <b>${escapeHtml(album.title)}</b>\n📦 عُثر على ${album.files.length} ملفاً.\nاختر ملفاً للتنزيل:`
      : `📁 <b>${escapeHtml(album.title)}</b>\n📦 Found ${album.files.length} files.\nPick a file to download:`

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: kb,
    })
  } catch (error) {
    await reportFailure(tg, chatId, messageId, error, lang, env)
  }
}

function buildBunkrAlbumKeyboard(stored: StoredBunkrAlbum, key: string, lang: Lang): InlineKeyboard {
  const PAGE_SIZE = 8
  const files = stored.album.files
  const pageFiles = files.slice(stored.offset, stored.offset + PAGE_SIZE)
  const rows: InlineButton[][] = []

  for (let i = 0; i < pageFiles.length; i++) {
    const f = pageFiles[i]
    const idx = stored.offset + i
    rows.push([
      {
        text: cleanButtonText(`${idx + 1}. 📹 ${f.name}`, 30),
        callback_data: `bkr|f|${f.id}|${stored.album.domain}`,
      },
    ])
  }

  const navRow: InlineButton[] = []
  if (stored.offset > 0) {
    navRow.push({
      text: '⬅️ ' + (lang === 'ar' ? 'السابق' : 'Prev'),
      callback_data: `bkr|ap|${key}|${stored.offset - PAGE_SIZE}`,
    })
  }
  if (stored.offset + PAGE_SIZE < files.length) {
    navRow.push({
      text: (lang === 'ar' ? 'التالي' : 'Next') + ' ➡️',
      callback_data: `bkr|ap|${key}|${stored.offset + PAGE_SIZE}`,
    })
  }
  if (navRow.length) rows.push(navRow)

  return { inline_keyboard: rows }
}

async function downloadBunkrFile(
  tg: TelegramApi,
  chatId: number,
  messageId: number,
  fileId: string,
  domain: string,
  lang: Lang,
  env: Env,
  origin: string,
): Promise<void> {
  try {
    const media = await resolveBunkrFile(fileId, domain)
    const item: MediaItem = {
      kind: 'video',
      url: media.directUrl,
      ext: media.ext,
      mime: media.ext === 'mp4' || media.ext === 'm4v' ? 'video/mp4' : 'application/octet-stream',
    }

    const filename = `${media.id}.${media.ext}`
    try {
      await sendMedia(tg, chatId, item, {
        caption: `📹 <b>${escapeHtml(media.title)}</b>`,
        filename,
        maxBytes: maxUploadBytes(env),
        timeoutMs: 30_000,
      })
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'sent', { label: media.title.slice(0, 30) }),
        parse_mode: 'HTML',
      })
    } catch (error) {
      const directUrl = await signFileUrl(item, filename, env, origin, 86400)
      if (error instanceof UploadTooLarge) {
        await reportFailure(tg, chatId, messageId, error, lang, env, directUrl)
      } else {
        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: lang === 'ar'
            ? `⚠️ الملف كبير أو تعذر إرساله عبر تيليجرام (${escapeHtml((error as Error).message)}).\nاختر طريقة التحميل المباشر السريع:`
            : `⚠️ File is large or failed sending (${escapeHtml((error as Error).message)}).\nDownload directly:`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: lang === 'ar' ? '🌐 فتح الرابط في المتصفح' : '🌐 Open in browser', url: media.directUrl }],
              [{ text: lang === 'ar' ? '🚀 رابط مباشر بديل (سيرفر البوت)' : '🚀 Direct Bot Proxy Link', url: directUrl }],
            ],
          },
        })
      }
    }
  } catch (error) {
    await reportFailure(tg, chatId, messageId, error, lang, env)
  }
}

async function handleBunkrCallback(
  tg: TelegramApi,
  query: any,
  chatId: number,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const action = parts[1] // 'a' | 'sp' | 'ap' | 'f'

  if (action === 'sp') {
    const key = parts[2]
    const targetOffset = parseInt(parts[3] || '0', 10)
    const raw = await store.get(`bkr_s:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const stored = JSON.parse(raw) as StoredBunkrSearch
    stored.offset = targetOffset
    await store.put(`bkr_s:${key}`, JSON.stringify(stored), 3600)
    const kb = buildBunkrSearchKeyboard(stored, key, lang)
    await tg.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: kb,
    }).catch(() => undefined)
    await answer(tg, query?.id, '')
    return
  }

  if (action === 'a') {
    const albumId = parts[2]
    const domain = parts[3] || 'bunkr.cr'
    await answer(tg, query?.id, '')
    const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '⏳ جاري فتح ألبوم Bunkr…' : '⏳ Opening Bunkr album…',
    })
    await showBunkrAlbum(tg, chatId, statusMsg.message_id, albumId, domain, 0, lang, env, store, origin)
    return
  }

  if (action === 'ap') {
    const key = parts[2]
    const targetOffset = parseInt(parts[3] || '0', 10)
    const raw = await store.get(`bkr_alb:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const stored = JSON.parse(raw) as StoredBunkrAlbum
    stored.offset = targetOffset
    await store.put(`bkr_alb:${key}`, JSON.stringify(stored), 3600)
    const kb = buildBunkrAlbumKeyboard(stored, key, lang)
    await tg.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: kb,
    }).catch(() => undefined)
    await answer(tg, query?.id, '')
    return
  }

  if (action === 'f') {
    const fileId = parts[2]
    const domain = parts[3] || 'bunkr.cr'
    await answer(tg, query?.id, '')
    const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'bunkrDownloading'),
    })
    await downloadBunkrFile(tg, chatId, statusMsg.message_id, fileId, domain, lang, env, origin)
  }
}

// ==========================================
// CHATURBATE RECORDER HANDLERS
// ==========================================

async function triggerGitHubRecorder(
  model: string,
  chatId: number | string,
  env: Env,
): Promise<{ ok: boolean; error?: string }> {
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'
  if (!token) return { ok: false, error: 'No GITHUB_TOKEN configured' }

  const url = `https://api.github.com/repos/${repo}/actions/workflows/record.yml/dispatches`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'SaveLink-Telegram-Bot',
      'Content-Type': 'application/json',
    },
    // NOTE: the bot token is NOT sent here. Workflow inputs are visible in
    // the Actions UI of the public repo; the runner reads BOT_TOKEN from a
    // GitHub secret instead (see .github/workflows/record.yml).
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        model,
        chat_id: String(chatId),
      },
    }),
  })

  if (res.status === 204 || res.ok) {
    return { ok: true }
  }
  const errText = await res.text()
  return { ok: false, error: `GitHub API error (${res.status}): ${errText}` }
}

export async function cancelGitHubRecorder(
  _model: string,
  env: Env,
): Promise<{ ok: boolean; count?: number; error?: string }> {
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'
  if (!token) return { ok: false, error: 'No GITHUB_TOKEN configured' }

  const listRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?status=in_progress`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'SaveLink-Telegram-Bot',
    },
  })
  if (!listRes.ok) return { ok: false, error: 'Failed to fetch active runs' }
  const data: any = await listRes.json()
  const runs = data.workflow_runs || []
  if (runs.length === 0) return { ok: false, error: 'No active recording found' }

  for (const r of runs) {
    await fetch(`https://api.github.com/repos/${repo}/actions/runs/${r.id}/cancel`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SaveLink-Telegram-Bot',
      },
    })
  }
  return { ok: true, count: runs.length }
}

async function getGitHubRecorderRuns(
  env: Env,
): Promise<{ ok: boolean; activeCount: number; queuedCount: number }> {
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'
  if (!token) return { ok: false, activeCount: 0, queuedCount: 0 }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/record.yml/runs?per_page=25`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SaveLink-Telegram-Bot',
      },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { ok: false, activeCount: 0, queuedCount: 0 }
    const data: any = await res.json()
    let activeCount = 0
    let queuedCount = 0
    for (const run of data.workflow_runs || []) {
      if (run.status === 'in_progress') activeCount += 1
      else if (run.status === 'queued' || run.status === 'waiting' || run.status === 'pending') queuedCount += 1
    }
    return { ok: true, activeCount, queuedCount }
  } catch {
    return { ok: false, activeCount: 0, queuedCount: 0 }
  }
}

async function getGitHubRecorderStatus(
  env: Env,
): Promise<{ active: boolean; count: number }> {
  const gh = await getGitHubRecorderRuns(env)
  return { active: gh.activeCount > 0, count: gh.activeCount }
}

function safeCallbackData(prefix: string, raw: string, maxBytes = 64): string {
  const enc = new TextEncoder()
  const prefixBytes = enc.encode(prefix).length
  if (prefixBytes >= maxBytes) return prefix.slice(0, maxBytes)
  let out = ''
  for (const ch of raw) {
    const candidate = out + ch
    if (prefixBytes + enc.encode(candidate).length > maxBytes) break
    out = candidate
  }
  return prefix + out
}

function formatRecordingElapsed(startedAt: number, lang: Lang): string {
  const totalMins = Math.max(0, Math.floor((Date.now() - startedAt) / 60_000))
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (lang === 'ar') {
    return hours > 0 ? `${hours} س ${mins} د` : `${mins} د`
  }
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
}

function recPlatformBadge(platform: ActiveRecording['platform']): string {
  if (platform === 'chaturbate') return '🔴 Chaturbate'
  if (platform === 'tiktok') return '🎵 TikTok'
  if (platform === 'stripchat') return '🟣 Stripchat'
  return '🎥 Live'
}

async function renderRecorderStatusView(
  lang: Lang,
  env: Env,
  store: Store,
): Promise<{ text: string; reply_markup: InlineKeyboard }> {
  const paused = await isRecorderPaused(env)
  let active = await listActiveRecordings(store)
  const endpoint = env.RECORDER_ENDPOINT || env.YTDLP_ENDPOINT
  const gh = env.GITHUB_TOKEN && !endpoint ? await getGitHubRecorderRuns(env) : { ok: false, activeCount: 0, queuedCount: 0 }

  // Heal stale tracked locks if GitHub reports zero live or queued runs and none started under 60s ago.
  if (gh.ok && gh.activeCount === 0 && gh.queuedCount === 0 && active.length > 0) {
    const newest = Math.max(...active.map((a) => a.startedAt))
    if (Date.now() - newest > 60_000) {
      await clearAllActiveRecordings(store)
      active = []
    }
  }

  const stateLine = paused
    ? (lang === 'ar' ? '⏸️ <b>الحالة العامة:</b> متوقف مؤقتاً (/stop recorder)' : '⏸️ <b>Recorder State:</b> Paused (/stop recorder)')
    : (lang === 'ar' ? '🟢 <b>الحالة العامة:</b> نشط وجاهز' : '🟢 <b>Recorder State:</b> Active')

  let body = ''
  if (active.length > 0) {
    const lines = active.map((rec, i) => {
      const elapsed = formatRecordingElapsed(rec.startedAt, lang)
      const srcLabel = rec.source === 'watch'
        ? (lang === 'ar' ? 'مراقبة تلقائية' : 'watch')
        : rec.source === 'continuation'
          ? (lang === 'ar' ? 'جزء مكمل' : 'part')
          : (lang === 'ar' ? 'يدوي' : 'manual')
      return `<b>${i + 1}.</b> ${recPlatformBadge(rec.platform)} — <code>${escapeHtml(rec.model)}</code>\n   ⏱️ ${elapsed} • (${srcLabel})`
    })
    body = `\n\n${lines.join('\n\n')}`
    if (gh.ok && gh.activeCount > active.length) {
      const untracked = gh.activeCount - active.length
      body += lang === 'ar'
        ? `\n\nℹ️ <i>+${untracked} مهمة سحابية إضافية جارية على GitHub.</i>`
        : `\n\nℹ️ <i>+${untracked} additional untracked GitHub run(s) active.</i>`
    }
  } else if (gh.ok && (gh.activeCount > 0 || gh.queuedCount > 0)) {
    body = lang === 'ar'
      ? `\n\n🔴 توجد <b>${gh.activeCount}</b> مهمة تسجيل جارية و<b>${gh.queuedCount}</b> بالانتظار على GitHub Actions (بدأت قبل تفعيل التتبع التفصيلي).`
      : `\n\n🔴 <b>${gh.activeCount}</b> active and <b>${gh.queuedCount}</b> queued GitHub run(s) running.`
  } else {
    body = lang === 'ar'
      ? '\n\n📭 لا توجد تسجيلات نشطة حالياً.'
      : '\n\n📭 No active recordings right now.'
  }

  const header = lang === 'ar' ? '📊 <b>حالة مسجل البثوث المباشرة</b>' : '📊 <b>Live Stream Recorder Status</b>'
  const text = `${header}\n\n${stateLine}${body}`

  const rows: InlineKeyboard['inline_keyboard'] = []
  for (const rec of active.slice(0, 6)) {
    rows.push([
      {
        text: lang === 'ar' ? `⏹️ إيقاف وحفظ: ${rec.model}` : `⏹️ Stop & Save: ${rec.model}`,
        callback_data: safeCallbackData('rec|stop|', rec.model),
      },
    ])
  }
  rows.push([
    { text: lang === 'ar' ? '🔄 تحديث الحالة' : '🔄 Refresh Status', callback_data: 'rec|list' },
    { text: lang === 'ar' ? '🗄️ الأرشيف' : '🗄️ Archive', callback_data: 'arch|p|0|' },
  ])

  return { text, reply_markup: { inline_keyboard: rows } }
}

async function handleStatusCommand(
  tg: TelegramApi,
  message: TgMessage,
  lang: Lang,
  env: Env,
  store: Store,
): Promise<void> {
  const { text, reply_markup } = await renderRecorderStatusView(lang, env, store)
  await tg.call('sendMessage', {
    chat_id: message.chat.id,
    text,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
    reply_markup,
  })
}

/**
 * Shared-secret auth for the sidecar (YTDLP_TOKEN). Without it the sidecar
 * rejects /record/* calls when its own YTDLP_TOKEN is set — and the bot token
 * must never travel in these requests: the sidecar reads BOT_TOKEN from its
 * own environment.
 */
function sidecarAuthHeaders(env: Env): Record<string, string> {
  const token = (env.YTDLP_TOKEN || '').trim()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function handleRecordCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  if (!rest) {
    const helpMsg = lang === 'ar'
      ? `🔴 <b>مسجل البثوث المباشرة العالمي (Universal Cloud Stream Recorder)</b>\n\n` +
        `يدعم تسجيل البثوث الحية من <b>أي منصة أو موقع بث على الإنترنت</b> بدون استثناء:\n` +
        `• <b>تيك توك لايف:</b> <code>/record @username</code> أو رابط البث\n` +
        `• <b>ستريب شات:</b> <code>/record https://stripchat.com/username</code>\n` +
        `• <b>شاتوربيت:</b> <code>/record https://chaturbate.com/username</code> أو <code>/record username</code>\n` +
        `• <b>تويتش & كيك:</b> <code>/record https://twitch.tv/channel</code> أو <code>kick.com/channel</code>\n` +
        `• <b>يوتيوب لايف:</b> <code>/record https://youtube.com/watch?v=...</code>\n` +
        `• <b>بث مباشر عام (HLS / m3u8):</b> <code>/record https://.../stream.m3u8</code>\n\n` +
        `💡 يقوم سيرفر السحابة بتسجيل البث حتى نهايته أو طلبك إيقافه، ثم يرفع الفيديو فوراً ويرسل لك رابط التحميل المباشر.`
      : `🔴 <b>Universal Cloud Live Stream Recorder</b>\n\n` +
        `Record live streams from <b>literally any platform or website on the internet</b>:\n` +
        `• TikTok Live, Stripchat, Chaturbate, Twitch, Kick, YouTube Live, or direct HLS (.m3u8).\n\n` +
        `Usage: <code>/record &lt;stream_url_or_user&gt;</code>`

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: helpMsg,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const hasGitHub = !!env.GITHUB_TOKEN
  const endpoint = env.RECORDER_ENDPOINT || env.YTDLP_ENDPOINT
  if (!hasGitHub && !endpoint) {
    const noServiceMsg = lang === 'ar'
      ? `⚠️ <b>خدمة التسجيل الخلفي غير مهيأة بعد</b>\n\n` +
        `التسجيل المستمر للبثوث يحتاج تفعيل GitHub Actions أو السيرفر المساعد.\n\n` +
        `<b>للربط السحابي:</b>\n` +
        `ضع التوكن في إعدادات البوت:\n<code>npx wrangler secret put GITHUB_TOKEN</code>`
      : `⚠️ <b>Background recorder service not configured</b>\nSet GITHUB_TOKEN or RECORDER_ENDPOINT.`

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: noServiceMsg,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  let clean = rest.trim()
  let forceStart = false
  if (/^force\s+/i.test(clean)) {
    forceStart = true
    clean = clean.replace(/^force\s+/i, '').trim()
  }
  let model = clean
  let platformLabel = 'Live Stream'
  let isSupported = false

  // Normalize URLs without protocol (e.g. stripchat.com/user, kick.com/user, etc.)
  if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
    if (/^(?:www\.|stripchat\.|twitch\.tv|kick\.com|youtube\.com|bongacams\.|cam4\.|camsoda\.)/i.test(clean) || (clean.includes('/') && clean.split('/')[0].includes('.'))) {
      clean = `https://${clean}`
    }
  }

  // 1. TikTok URL or @username
  const scMatch = clean.match(/stripchat\.(?:com|org|me|cc)\/(?:[a-z]{2}\/)?([a-zA-Z0-9_.-]+)/i)
    || clean.match(/^stripchat[_\/]([a-zA-Z0-9_.-]+)$/i)
    || clean.match(/^sc[_\/]([a-zA-Z0-9_.-]+)$/i)

  if (scMatch) {
    isSupported = true
    platformLabel = 'Stripchat'
    model = scMatch[1].toLowerCase().replace(/\/(?:videos?|vod|clips?|archive)\/?$/i, '')
    clean = `https://stripchat.com/${model}`
  } else if (clean.includes('tiktok.com') || clean.startsWith('@')) {
    isSupported = true
    platformLabel = 'TikTok Live'
    const m = clean.match(/@([a-zA-Z0-9_.-]+)/)
    model = m ? `@${m[1]}` : clean
  } else if (/chaturbate\.(?:com|eu|global)\/(?:b\/)?([a-zA-Z0-9_.-]+)/i.test(clean)) {
    // 2. Chaturbate URL
    isSupported = true
    platformLabel = 'Chaturbate'
    const cbMatch = clean.match(/chaturbate\.(?:com|eu|global)\/(?:b\/)?([a-zA-Z0-9_.-]+)/i)
    model = cbMatch ? cbMatch[1].toLowerCase() : clean
  } else if (clean.startsWith('http://') || clean.startsWith('https://')) {
    // 3. Universal Live Stream URL (Any streaming website on the internet)
    isSupported = true
    clean = clean.replace(/\/(?:videos?|vod|clips?|archive)\/?$/i, '')
    try {
      const u = new URL(clean)
      const host = u.hostname.toLowerCase().replace(/^www\./, '')
      if (host.includes('stripchat.')) platformLabel = 'Stripchat'
      else if (host.includes('twitch.tv')) platformLabel = 'Twitch'
      else if (host.includes('kick.com')) platformLabel = 'Kick'
      else if (host.includes('youtube.com') || host.includes('youtu.be')) platformLabel = 'YouTube Live'
      else if (host.includes('facebook.com')) platformLabel = 'Facebook Live'
      else if (host.includes('bongacams.')) platformLabel = 'BongaCams'
      else if (host.includes('cam4.')) platformLabel = 'Cam4'
      else if (host.includes('camsoda.')) platformLabel = 'CamSoda'
      else if (clean.includes('.m3u8')) platformLabel = 'HLS Stream'
      else platformLabel = host

      const segments = u.pathname.split('/').filter(Boolean).filter(s => !['live', 'c', 'channel', 'u', 'user', 'p', 'videos'].includes(s.toLowerCase()))
      model = segments.length > 0 ? segments[segments.length - 1] : host
    } catch {
      platformLabel = 'Live Stream'
      model = clean
    }
  } else if (/^[a-zA-Z0-9_.-]{3,60}$/.test(clean)) {
    // 4. Bare alphanumeric name without domain: check Chaturbate room
    isSupported = true
    platformLabel = 'Chaturbate'
    model = clean.toLowerCase()
  }

  if (!isSupported) {
    const errorMsg = lang === 'ar'
      ? `⚠️ <b>الرابط غير صالح للتسجيل</b>\n\n` +
        `يرجى إرسال رابط البث المباشر (مثل: <code>https://stripchat.com/username</code> أو <code>https://twitch.tv/username</code> أو <code>@username</code> لتيك توك).`
      : `⚠️ <b>Invalid stream target</b>\nPlease provide a full live stream URL or username.`

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: errorMsg,
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }

  let resumedNote = ''
  if (await isRecorderPaused(env)) {
    if (isPauseConfigured(env) && !canControlPause(env, message.from?.id)) {
      await tg.call('sendMessage', {
        chat_id: chatId,
        text: lang === 'ar'
          ? '⏸️ المسجل متوقف حالياً بواسطة المالك.'
          : '⏸️ Recording is currently paused by the owner.',
        reply_to_message_id: message.message_id,
      })
      return
    }
    await setRecorderPaused(env, false)
    resumedNote = lang === 'ar'
      ? '\n▶️ <i>تم إعادة تفعيل المسجل والمراقبة التلقائية (/watch) تلقائياً.</i>'
      : '\n▶️ <i>Recorder & /watch resumed automatically.</i>'
  }

  const initialRecPlatform = normalizeRecPlatform(platformLabel)
  if (!forceStart) {
    let existing = await getActiveRecording(store, initialRecPlatform, model)
    if (existing && hasGitHub && !endpoint && Date.now() - existing.startedAt > 90_000) {
      const gh = await getGitHubRecorderRuns(env)
      if (gh.ok && gh.activeCount === 0 && gh.queuedCount === 0) {
        await clearAllActiveRecordings(store)
        await clearAllWatchLocksForTarget(store, model)
        existing = null
      }
    }
    if (existing) {
      const elapsed = formatRecordingElapsed(existing.startedAt, lang)
      const stopCb = safeCallbackData('rec|stop|', existing.model)
      const forceCb = safeCallbackData('rec|force|', existing.model)
      await tg.call('sendMessage', {
        chat_id: chatId,
        text: (lang === 'ar'
          ? `⚠️ <b>الحساب <code>${escapeHtml(existing.model)}</code> قيد التسجيل بالفعل!</b>\n\n` +
            `• المنصة: ${recPlatformBadge(existing.platform)}\n` +
            `• بدأ منذ: <b>${elapsed}</b>\n\n` +
            `لتجنب تكرار المهام، أوقف التسجيل الحالي أولاً أو افتح قائمة التسجيلات النشطة.`
          : `⚠️ <b><code>${escapeHtml(existing.model)}</code> is already recording!</b>\n\n` +
            `• Platform: ${recPlatformBadge(existing.platform)}\n` +
            `• Running for: <b>${elapsed}</b>`) + resumedNote,
        parse_mode: 'HTML',
        reply_to_message_id: message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: lang === 'ar' ? '⏹️ إيقاف وحفظ التسجيل الحالي' : '⏹️ Stop & Save Current', callback_data: stopCb }],
            [
              { text: lang === 'ar' ? '📊 التسجيلات النشطة' : '📊 Active Recordings', callback_data: 'rec|list' },
              { text: lang === 'ar' ? '🔁 فرض تسجيل جديد' : '🔁 Force New Run', callback_data: forceCb },
            ],
          ],
        },
      })
      return
    }
  }

  const cleanStopKey = model.replace(/^@/, '').toLowerCase()
  try {
    if (await store.get(`stop:${cleanStopKey}`)) {
      await store.delete(`stop:${cleanStopKey}`)
      invalidateSignalMemo(cleanStopKey)
    }
  } catch {}

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: lang === 'ar' ? `⏳ جاري فحص بث <b>${escapeHtml(model)}</b> (${platformLabel}) وبدء التسجيل…` : `⏳ Checking stream for <b>${escapeHtml(model)}</b>…`,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  // Pre-check Chaturbate room status to immediately catch Private Shows or Offline
  if (platformLabel === 'Chaturbate') {
    try {
      const cbRes = await fetch(`https://chaturbate.com/api/chatvideocontext/${model}/`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(6000),
      })
      if (cbRes.ok) {
        const cbData: any = await cbRes.json()
        const roomStatus = String(cbData.room_status || '').toLowerCase()
        if (roomStatus === 'private' || roomStatus === 'group_show') {
          await tg.safeEdit('editMessageText', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            text: (lang === 'ar'
              ? `🔒 <b>الموديل ${escapeHtml(model)} حالياً في عرض خاص مشفر (Private Show / PVT).</b>\n\n` +
                `البثوث الخاصة تكون مشفرة ومغلقة وتتطلب حساباً مدفوعاً بتوكنات داخل الموقع ولا يمكن التقاطها كبث عام.\n\n` +
                `💡 <b>الحل التلقائي:</b> فعل المراقبة التلقائية الآن:\n<code>/watch ${escapeHtml(model)}</code>\nوسيقوم البوت بالبدء بتسجيل البث تلقائياً فور انتهائها من الخاص وعودتها للبث العام المجاني!`
              : `🔒 <b>${escapeHtml(model)} is currently in a Private Show (PVT).</b>\nPrivate sessions cannot be captured without paid token authentication.\nUse <code>/watch ${escapeHtml(model)}</code> to record automatically once public stream resumes!`) + resumedNote,
            parse_mode: 'HTML',
          })
          return
        }
        if (roomStatus === 'offline') {
          // Check if this username is active on Stripchat before reporting offline
          let isStripchatLive = false
          try {
            const scCheck = await fetch(`https://stripchat.com/api/front/v2/users/username/${model}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
                'Accept': 'application/json',
              },
              signal: AbortSignal.timeout(4000),
            })
            if (scCheck.ok) {
              const scJson: any = await scCheck.json()
              const u = scJson?.user
              if (u && u.isLive && u.status === 'public') {
                isStripchatLive = true
                platformLabel = 'Stripchat'
                clean = `https://stripchat.com/${model}`
              }
            }
          } catch {}

          if (!isStripchatLive) {
            await tg.safeEdit('editMessageText', {
              chat_id: chatId,
              message_id: statusMsg.message_id,
              text: (lang === 'ar'
                ? `⚠️ <b>الموديل ${escapeHtml(model)} غير متصلة حالياً (Offline).</b>\n\n` +
                  `💡 <b>لتسجيل البث فور بدئه بدون انتظار:</b>\n` +
                  `اكتب: <code>/watch ${escapeHtml(model)}</code>\n` +
                  `سيقوم البوت بمراقبة الحساب كل ${WATCH_CHECK_INTERVAL_MINUTES} دقائق، وأول ما تفتح لايف عام سيسجله السيرفر تلقائياً ويرسل لك الرابط!`
                : `⚠️ <b>${escapeHtml(model)} is currently Offline.</b>\nUse <code>/watch ${escapeHtml(model)}</code> to record automatically once live.`) + resumedNote,
              parse_mode: 'HTML',
            })
            return
          }
        }
      }
    } catch {}
  }

  // Pre-check Stripchat room status to immediately catch Private Shows or Offline
  if (platformLabel === 'Stripchat') {
    try {
      const scRes = await fetch(`https://stripchat.com/api/front/v2/users/username/${model}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(6000),
      })
      if (scRes.ok) {
        const scData: any = await scRes.json()
        const u = scData.user
        const showMode = u?.show?.mode
        const isLive = u?.isLive
        const status = u?.status
        if (showMode === 'private' || showMode === 'groupShow' || status === 'private') {
          await tg.safeEdit('editMessageText', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            text: (lang === 'ar'
              ? `🔒 <b>الموديل ${escapeHtml(model)} حالياً في عرض خاص مشفر (Private Show / PVT).</b>\n\n` +
                `البثوث الخاصة تكون مشفرة ومغلقة وتتطلب حساباً مدفوعاً بتوكنات داخل الموقع ولا يمكن التقاطها كبث عام.\n\n` +
                `💡 <b>الحل التلقائي:</b> فعل المراقبة التلقائية الآن:\n<code>/watch https://stripchat.com/${escapeHtml(model)}</code>\nوسيقوم البوت بالبدء بتسجيل البث تلقائياً فور انتهائها من الخاص وعودتها للبث العام المجاني!`
              : `🔒 <b>${escapeHtml(model)} is currently in a Private Show (PVT).</b>\nUse <code>/watch https://stripchat.com/${escapeHtml(model)}</code> to record automatically once public stream resumes!`) + resumedNote,
            parse_mode: 'HTML',
          })
          return
        }
        if (!isLive || status === 'off') {
          await tg.safeEdit('editMessageText', {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            text: (lang === 'ar'
              ? `⚠️ <b>الموديل ${escapeHtml(model)} غير متصلة حالياً (Offline).</b>\n\n` +
                `💡 <b>لتسجيل البث فور بدئه بدون انتظار:</b>\n` +
                `اكتب: <code>/watch https://stripchat.com/${escapeHtml(model)}</code>\n` +
                `سيقوم البوت بمراقبة الحساب كل ${WATCH_CHECK_INTERVAL_MINUTES} دقائق، وأول ما تفتح لايف عام سيسجله السيرفر تلقائياً ويرسل لك الرابط!`
              : `⚠️ <b>${escapeHtml(model)} is currently Offline.</b>\nUse <code>/watch https://stripchat.com/${escapeHtml(model)}</code> to record automatically once live.`) + resumedNote,
            parse_mode: 'HTML',
          })
          return
        }
      }
    } catch {}
  }

  try {
    if (hasGitHub) {
      const ghRes = await triggerGitHubRecorder(clean, chatId, env)
      if (!ghRes.ok) throw new Error(ghRes.error || 'Failed to dispatch GitHub Actions runner')
    } else if (endpoint) {
      const base = endpoint.replace(/\/+$/, '')
      const recRes = await fetch(`${base}/record/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders(env) },
        // The bot token is NOT sent here: the sidecar reads BOT_TOKEN from its
        // own environment. The shared YTDLP_TOKEN bearer authenticates us.
        body: JSON.stringify({
          url: clean,
          chat_id: chatId,
        }),
        signal: AbortSignal.timeout(15_000),
      })

      const data: any = await recRes.json()
      if (!recRes.ok || !data.ok) {
        throw new Error(data.detail || data.error || 'Failed to start recording')
      }
    }

    try {
      await markRecordingStarted(store, {
        platform: normalizeRecPlatform(platformLabel),
        model,
        target: clean,
        chatId,
        source: 'manual',
      })
    } catch (err) {
      console.warn('[record] markRecordingStarted failed:', (err as Error)?.message || err)
    }

    const startMsg = (lang === 'ar'
      ? `🔴 <b>جاري الاتصال وتسجيل بث ${platformLabel} في السحابة!</b>\n\n` +
        `👤 <b>المعرف:</b> <code>${escapeHtml(model)}</code>\n` +
        `☁️ <b>الخادم السحابي:</b> سيرفر مايكروسوفت (GitHub Actions) فائق السرعة\n` +
        `⏳ <b>الحالة:</b> قيد المتابعة والتسجيل... (إذا كان الحساب في عرض خاص مؤقت PVT سينتظره السيرفر تلقائياً حتى يعود للبث العام ويسجله فوراً)\n` +
        `💡 يمكنك إغلاق هاتفك أو جهازك تماماً؛ فور انتهاء البث أو إيقافه سيتم رفع الفيديو فوراً وإرسال رابط التحميل هنا.`
      : `🔴 <b>Recording ${platformLabel} in Cloud!</b>\n\n` +
        `👤 <b>Target:</b> <code>${escapeHtml(model)}</code>\n` +
        `☁️ <b>Cloud Runner:</b> High-speed GitHub Actions\n` +
        `⏳ <b>Status:</b> Recording in background...\n` +
        `💡 You can turn off your device. Video will be uploaded and link sent when done.`) + resumedNote

    // Byte-safe like the other recording buttons: callback_data is capped at 64 bytes.
    const stopCb = safeCallbackData('rec|stop|', model)
    const statCb = safeCallbackData('rec|stat|', model)
    const kb: InlineKeyboard = {
      inline_keyboard: [
        [{ text: lang === 'ar' ? '⏹️ إيقاف وحفظ التسجيل الآن' : '⏹️ Stop & Save Now', callback_data: stopCb }],
        [{ text: lang === 'ar' ? '🔄 تحديث حالة التسجيل' : '🔄 Refresh Status', callback_data: statCb }],
      ],
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: startMsg,
      parse_mode: 'HTML',
      reply_markup: kb,
    })
  } catch (error: any) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: lang === 'ar'
        ? `❌ تعذر بدء التسجيل: ${escapeHtml(error.message)}`
        : `❌ Could not start recording: ${escapeHtml(error.message)}`,
      parse_mode: 'HTML',
    })
  }
}

async function handleStopRecorderAll(
  tg: TelegramApi,
  message: TgMessage,
  lang: Lang,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id
  if (!isPauseConfigured(env)) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text:
        '⛔ <b>أمر إيقاف المسجل معطّل.</b>\n\n' +
        'لم يتم ضبط <code>OWNER_ID</code> في إعدادات الووركر.',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }
  if (!canControlPause(env, message.from?.id)) return

  await setRecorderPaused(env, true, message.from?.id)
  let gh = { running: 0, cancelledQueued: 0 }
  try {
    gh = await stopRecorderGitHubRuns(env)
  } catch (error) {
    console.error('stop recorder github error', errorMessage(error))
  }

  const endpoint = env.RECORDER_ENDPOINT || env.YTDLP_ENDPOINT
  if (endpoint) {
    try {
      const base = endpoint.replace(/\/+$/, '')
      const statRes = await fetch(`${base}/record/status`, {
        headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders(env) },
        signal: AbortSignal.timeout(8_000),
      })
      if (statRes.ok) {
        const data: any = await statRes.json()
        for (const rec of data.recordings || []) {
          await fetch(`${base}/record/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders(env) },
            body: JSON.stringify({ url: rec.model }),
            signal: AbortSignal.timeout(8_000),
          }).catch(() => {})
        }
      }
    } catch {}
  }

  const queuedNote = gh.cancelledQueued ? ` (وإلغاء ${gh.cancelledQueued} بالانتظار)` : ''
  const text = lang === 'ar'
    ? `⏹️ <b>تم إيقاف جميع التسجيلات والمراقبة التلقائية (/watch)!</b>\n\n` +
      `• تم إرسال أمر الإيقاف والحفظ الآمن لـ <b>${gh.running}</b> تسجيل جاري${queuedNote}.\n` +
      `• المراقبة التلقائية <code>/watch</code> متوقفة مؤقتاً.\n` +
      `• باقي ميزات البوت تعمل بشكل طبيعي.\n\n` +
      `▶️ <b>لإعادة التشغيل تلقائياً:</b> أرسل أي أمر تسجيل جديد مثل <code>/record اسم_الحساب</code>.`
    : `⏹️ <b>Paused all recordings & auto-watch (/watch)!</b>\n\n` +
      `• Safe stop signaled to <b>${gh.running}</b> active run(s)` +
      (gh.cancelledQueued ? ` (${gh.cancelledQueued} queued cancelled)` : '') +
      `.\n• Auto-watch is paused until you start a new <code>/record &lt;target&gt;</code>.`

  await tg.call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: lang === 'ar' ? '🗄️ أرشيف التسجيلات' : '🗄️ Recordings Archive', callback_data: 'arch|p|0|' }],
      ],
    },
  })
}

async function handleStopCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  if (rest.trim().toLowerCase() === 'recorder') {
    await handleStopRecorderAll(tg, message, lang, env)
    return
  }

  const chatId = message.chat.id
  const hasGitHub = !!env.GITHUB_TOKEN
  const endpoint = env.RECORDER_ENDPOINT || env.YTDLP_ENDPOINT
  if (!hasGitHub && !endpoint) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: lang === 'ar' ? '⚠️ خدمة التسجيل غير مهيأة.' : '⚠️ Recorder service not configured.',
      reply_to_message_id: message.message_id,
    })
    return
  }

  const modelMatch = rest.match(/chaturbate\.com\/(?:b\/)?([a-zA-Z0-9_.-]+)/i) || rest.match(/^([a-zA-Z0-9_.-]{3,60})$/)
  const model = modelMatch ? modelMatch[1].toLowerCase() : rest.trim()

  const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: lang === 'ar' ? `⏳ جاري إيقاف التسجيل للموديل <b>${escapeHtml(model || 'الحالي')}</b>…` : `⏳ Stopping recording…`,
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })

  try {
    const cleanModel = model.replace(/^@/, '').toLowerCase()
    await store.put(`stop:${cleanModel}`, '1', 3600)
    const trimmed = cleanModel.replace(/^_+|_+$/g, '')
    if (trimmed && trimmed !== cleanModel) {
      await store.put(`stop:${trimmed}`, '1', 3600)
    }
    invalidateSignalMemo(cleanModel)

    if (endpoint) {
      const base = endpoint.replace(/\/+$/, '')
      const stopRes = await fetch(`${base}/record/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders(env) },
        body: JSON.stringify({ url: model }),
        signal: AbortSignal.timeout(15_000),
      })

      const data: any = await stopRes.json()
      if (!stopRes.ok || !data.ok) {
        throw new Error(data.detail || data.error || 'Failed to stop recording')
      }
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: lang === 'ar'
        ? `⏹️ تم طلب إيقاف التسجيل للموديل <b>${escapeHtml(model)}</b>.\nجاري تجهيز الفيديو ورفعه، سيصلك الرابط خلال لحظات — أو تفقّد الأرشيف لاحقاً.`
        : `⏹️ Stop requested. Processing and uploading video... Check the archive if a message doesn't arrive.`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: lang === 'ar' ? '🗄️ أرشيف التسجيلات' : '🗄️ Recordings Archive', callback_data: 'arch|p|0|' }],
        ],
      },
    })
  } catch (error: any) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      text: `❌ ${escapeHtml(error.message)}`,
      parse_mode: 'HTML',
    })
  }
}

async function handleRecordCallback(
  tg: TelegramApi,
  query: any,
  chatId: number,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  _store: Store,
  _origin: string,
): Promise<void> {
  const action = parts[1] // 'stop' | 'stat' | 'list' | 'force'
  const model = parts.slice(2).join('|')

  if (action === 'list') {
    await answer(tg, query?.id, '')
    const { text, reply_markup } = await renderRecorderStatusView(lang, env, _store)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup,
    })
    return
  }

  const hasGitHub = !!env.GITHUB_TOKEN
  const endpoint = env.RECORDER_ENDPOINT || env.YTDLP_ENDPOINT
  if (!hasGitHub && !endpoint) {
    await answer(tg, query?.id, 'Recorder endpoint not configured', true)
    return
  }

  if (action === 'force') {
    await answer(tg, query?.id, lang === 'ar' ? 'جاري بدء تسجيل جديد...' : 'Starting new recording...')
    const active = await listActiveRecordings(_store)
    const found = active.find((r) => r.model === model.replace(/^@/, '').toLowerCase())
    const targetToStart = found?.target || model
    const syntheticMessage: TgMessage = {
      message_id: messageId,
      chat: { id: chatId, type: query?.message?.chat?.type || 'private' },
      from: query?.from,
    }
    await handleRecordCommand(tg, syntheticMessage, `force ${targetToStart}`, lang, env, _store, _origin)
    return
  }

  if (action === 'stop') {
    await answer(tg, query?.id, lang === 'ar' ? 'جاري إيقاف التسجيل...' : 'Stopping...')
    try {
      const cleanModel = model.replace(/^@/, '').toLowerCase()
      await _store.put(`stop:${cleanModel}`, '1', 3600)
      const trimmed = cleanModel.replace(/^_+|_+$/g, '')
      if (trimmed && trimmed !== cleanModel) {
        await _store.put(`stop:${trimmed}`, '1', 3600)
      }
      invalidateSignalMemo(cleanModel)

      if (endpoint) {
        const base = endpoint.replace(/\/+$/, '')
        const stopRes = await fetch(`${base}/record/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders(env) },
          body: JSON.stringify({ url: model }),
          signal: AbortSignal.timeout(15_000),
        })
        const data: any = await stopRes.json()
        if (!stopRes.ok || !data.ok) throw new Error(data.detail || data.error)
      }

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: lang === 'ar'
          ? `⏹️ تم إيقاف تسجيل <b>${escapeHtml(model)}</b> بنجاح!\nجاري تجهيز ورفع الفيديو، ستصلك رسالة بالرابط فوراً أو تجده في الأرشيف.`
          : `⏹️ Recording stopped for <b>${escapeHtml(model)}</b>. Video is being uploaded...`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: lang === 'ar' ? '🗄️ أرشيف التسجيلات' : '🗄️ Recordings Archive', callback_data: 'arch|p|0|' },
              { text: lang === 'ar' ? '📊 التسجيلات النشطة' : '📊 Active Status', callback_data: 'rec|list' },
            ],
          ],
        },
      })
    } catch (err: any) {
      await answer(tg, query?.id, err.message, true)
    }
    return
  }

  if (action === 'stat') {
    try {
      if (hasGitHub) {
        const active = await listActiveRecordings(_store)
        const tracked = active.find((r) => r.model === model.replace(/^@/, '').toLowerCase())
        const stat = await getGitHubRecorderStatus(env)
        const text = tracked
          ? (lang === 'ar'
              ? `🔴 ${tracked.model} قيد التسجيل منذ ${formatRecordingElapsed(tracked.startedAt, lang)} (الإجمالي النشط: ${Math.max(stat.count, active.length)})`
              : `🔴 ${tracked.model} recording for ${formatRecordingElapsed(tracked.startedAt, lang)} (Active: ${Math.max(stat.count, active.length)})`)
          : stat.active
            ? (lang === 'ar' ? `🔴 مسجل GitHub السحابي نشط حالياً (${stat.count} بث قيد التسجيل)` : `🔴 GitHub Cloud Recorder active (${stat.count} running)`)
            : (lang === 'ar' ? 'التسجيل انتهى أو تم الرفع' : 'Recording completed or not found')
        await answer(tg, query?.id, text, true)
      } else if (endpoint) {
        const base = endpoint.replace(/\/+$/, '')
        const statRes = await fetch(`${base}/record/status`, {
          headers: { 'Content-Type': 'application/json', ...sidecarAuthHeaders(env) },
          signal: AbortSignal.timeout(10_000),
        })
        const data: any = await statRes.json()
        const rec = (data.recordings || []).find((r: any) => r.model.toLowerCase() === model.toLowerCase())
        if (rec) {
          const text = lang === 'ar'
            ? `🔴 البث قيد التسجيل: ${rec.model}\n⏱️ مضى: ${Math.round(rec.elapsed_seconds / 60)} دقيقة\n📦 الحجم الحالي: ${rec.size_mb} MB`
            : `🔴 Live: ${rec.model}\n⏱️ Elapsed: ${Math.round(rec.elapsed_seconds / 60)} min\n📦 Size: ${rec.size_mb} MB`
          await answer(tg, query?.id, text, true)
        } else {
          await answer(tg, query?.id, lang === 'ar' ? 'التسجيل انتهى أو غير موجود' : 'Recording completed or not found', true)
        }
      }
    } catch (err: any) {
      await answer(tg, query?.id, err.message, true)
    }
  }
}

const ARCHIVE_PAGE_SIZE = 6

function formatArchiveDate(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return '—'
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm} UTC`
}

function archivePlatformBadge(platform: ArchiveEntry['platform']): string {
  if (platform === 'chaturbate') return '🔴 Chaturbate'
  if (platform === 'tiktok') return '🎵 TikTok'
  if (platform === 'stripchat') return '🟣 Stripchat'
  return '🎥 Live'
}

async function renderRecordingsArchiveMessage(
  store: Store,
  chatId: number,
  page: number,
  query: string,
  lang: Lang,
  env: Env,
  origin: string,
): Promise<{ text: string; reply_markup: InlineKeyboard }> {
  const cleanQuery = query.trim().replace(/\|/g, '').slice(0, 24)
  const entries = await listArchiveEntries(store, chatId, cleanQuery)
  const total = entries.length
  const totalPages = Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE))
  const safePage = Math.max(0, Math.min(page, totalPages - 1))
  const slice = entries.slice(safePage * ARCHIVE_PAGE_SIZE, (safePage + 1) * ARCHIVE_PAGE_SIZE)

  const header = cleanQuery
    ? (lang === 'ar'
        ? `🗄️ <b>أرشيف التسجيلات — بحث:</b> <code>${escapeHtml(cleanQuery)}</code> (${total})`
        : `🗄️ <b>Recordings Archive — Filter:</b> <code>${escapeHtml(cleanQuery)}</code> (${total})`)
    : (lang === 'ar'
        ? `🗄️ <b>أرشيف روابط التسجيلات</b> (${total})`
        : `🗄️ <b>Recordings Link Archive</b> (${total})`)

  let text = header
  if (!total) {
    text += cleanQuery
      ? (lang === 'ar'
          ? `\n\nلا توجد تسجيلات مطابقة لـ <code>${escapeHtml(cleanQuery)}</code>.\nجرب <code>/archive</code> لعرض كل الروابط.`
          : `\n\nNo recordings match <code>${escapeHtml(cleanQuery)}</code>.\nTry <code>/archive</code> for all links.`)
      : (lang === 'ar'
          ? `\n\nالأرشيف فارغ حالياً.\nكل بث يتم تسجيله أو إيقافه (Chaturbate / TikTok / Stripchat) سيُحفظ رابطه هنا تلقائياً.\n\n💡 للبحث داخل الأرشيف: <code>/archive اسم_الموديل</code>`
          : `\n\nArchive is empty.\nEvery completed or stopped cloud recording link will be saved here automatically.`)
  } else {
    const blocks = slice.map((entry, idx) => {
      const num = safePage * ARCHIVE_PAGE_SIZE + idx + 1
      const meta = [entry.size, entry.duration, formatArchiveDate(entry.createdAt)].filter(Boolean).join(' • ')
      const linkText = lang === 'ar' ? '🔗 مشاهدة وتحميل البث' : '🔗 Watch & Download'
      return (
        `<b>${num}.</b> ${archivePlatformBadge(entry.platform)} — <code>${escapeHtml(entry.model)}</code>\n` +
        `   📦 ${escapeHtml(meta)}\n` +
        `   <a href="${escapeHtml(entry.url)}">${linkText}</a>`
      )
    })
    text += `\n\n${blocks.join('\n\n')}`
    if (totalPages > 1) {
      text += lang === 'ar'
        ? `\n\n📄 صفحة ${safePage + 1} من ${totalPages} • للبحث: <code>/archive اسم_الموديل</code>`
        : `\n\n📄 Page ${safePage + 1} of ${totalPages}`
    }
  }

  const rows: InlineKeyboard['inline_keyboard'] = []
  const filterKey = cleanQuery.toLowerCase()
  rows.push([
    { text: (!filterKey ? '• ' : '') + (lang === 'ar' ? 'الكل' : 'All'), callback_data: 'arch|p|0|' },
    { text: (filterKey === 'chaturbate' ? '• ' : '') + '🔴 CB', callback_data: 'arch|p|0|chaturbate' },
    { text: (filterKey === 'tiktok' ? '• ' : '') + '🎵 TT', callback_data: 'arch|p|0|tiktok' },
    { text: (filterKey === 'stripchat' ? '• ' : '') + '🟣 SC', callback_data: 'arch|p|0|stripchat' },
  ])

  if (slice.length > 0) {
    const deleteBtns = slice.map((entry, idx) => {
      const num = safePage * ARCHIVE_PAGE_SIZE + idx + 1
      return {
        text: `🗑️ #${num}`,
        callback_data: safeCallbackData(`arch|d|${entry.id}|${safePage}|`, cleanQuery),
      }
    })
    for (let i = 0; i < deleteBtns.length; i += 3) {
      rows.push(deleteBtns.slice(i, i + 3))
    }
  }

  if (totalPages > 1) {
    const navRow: InlineKeyboard['inline_keyboard'][number] = []
    if (safePage > 0) {
      navRow.push({
        text: lang === 'ar' ? '⬅️ السابق' : '⬅️ Prev',
        callback_data: safeCallbackData(`arch|p|${safePage - 1}|`, cleanQuery),
      })
    }
    navRow.push({
      text: `${safePage + 1}/${totalPages}`,
      callback_data: safeCallbackData(`arch|r|${safePage}|`, cleanQuery),
    })
    if (safePage < totalPages - 1) {
      navRow.push({
        text: lang === 'ar' ? 'التالي ➡️' : 'Next ➡️',
        callback_data: safeCallbackData(`arch|p|${safePage + 1}|`, cleanQuery),
      })
    }
    rows.push(navRow)
  }

  const actionRow: InlineKeyboard['inline_keyboard'][number] = [
    {
      text: lang === 'ar' ? '🔄 تحديث الأرشيف' : '🔄 Refresh Archive',
      callback_data: safeCallbackData(`arch|r|${safePage}|`, cleanQuery),
    },
  ]
  const baseUrl = publicBase(env, origin)
  if (/^https:\/\//i.test(baseUrl)) {
    const webUrl = await signArchivePageUrl(chatId, env, origin)
    actionRow.push({
      text: lang === 'ar' ? '🌐 صفحة الأرشيف الكاملة' : '🌐 Full Archive Page',
      url: webUrl,
    })
  }
  rows.push(actionRow)

  return { text, reply_markup: { inline_keyboard: rows } }
}

async function handleRecordingsArchiveCommand(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  if (rest.trim().toLowerCase() === 'clear') {
    await tg.call('sendMessage', {
      chat_id: message.chat.id,
      text: lang === 'ar'
        ? '⚠️ <b>هل تريد مسح جميع روابط التسجيلات من أرشيفك؟</b>\nلن يمكن التراجع عن هذا الإجراء.'
        : '⚠️ <b>Clear every recording link from your archive?</b>\nThis cannot be undone.',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: lang === 'ar' ? '🗑️ نعم، مسح كل الأرشيف' : '🗑️ Yes, clear all', callback_data: 'arch|clr_yes' },
            { text: lang === 'ar' ? '↩️ إلغاء' : '↩️ Cancel', callback_data: 'arch|p|0|' },
          ],
        ],
      },
    })
    return
  }

  const { text, reply_markup } = await renderRecordingsArchiveMessage(store, message.chat.id, 0, rest, lang, env, origin)
  await tg.call('sendMessage', {
    chat_id: message.chat.id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_to_message_id: message.message_id,
    reply_markup,
  })
}

async function handleRecordingsArchiveCallback(
  tg: TelegramApi,
  query: any,
  chatId: number,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const action = parts[1]
  let page = 0
  let filter = ''

  if (action === 'd') {
    const entryId = parts[2] || ''
    page = Number(parts[3] || '0') || 0
    filter = parts.slice(4).join('|')
    const removed = await deleteArchiveEntry(store, chatId, entryId)
    await answer(
      tg,
      query?.id,
      removed
        ? (lang === 'ar' ? '🗑️ تم حذف الرابط من الأرشيف' : 'Deleted from archive')
        : (lang === 'ar' ? 'الرابط محذوف مسبقاً' : 'Already deleted'),
    )
  } else if (action === 'clr_yes') {
    const count = await clearArchiveEntries(store, chatId)
    await answer(
      tg,
      query?.id,
      lang === 'ar' ? `🗑️ تم مسح ${count} رابط من الأرشيف` : `Cleared ${count} links`,
    )
  } else {
    page = Number(parts[2] || '0') || 0
    filter = parts.slice(3).join('|')
    await answer(tg, query?.id, '')
  }

  const { text, reply_markup } = await renderRecordingsArchiveMessage(store, chatId, page, filter, lang, env, origin)
  await tg.safeEdit('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup,
  })
}


async function handleLink(
  tg: TelegramApi,
  message: TgMessage,
  url: string,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  const platform = detectPlatform(url)

  if (platform === 'unknown') {
    if (isShortenerOrAdLink(url)) {
      try {
        const bypassed = await unshortenUrl(url)
        if (bypassed.success && bypassed.finalUrl && bypassed.finalUrl !== bypassed.originalUrl) {
          const destPlatform = detectPlatform(bypassed.finalUrl)
          if (destPlatform !== 'unknown') {
            await tg.call('sendMessage', {
              chat_id: chatId,
              text: t(lang, 'bypassAutoResolved', { finalUrl: escapeHtml(bypassed.finalUrl) }),
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            })
            await handleLink(tg, message, bypassed.finalUrl, lang, env, store, origin)
            return
          }
          await tg.call('sendMessage', {
            chat_id: chatId,
            text: t(lang, 'bypassSuccess', {
              finalUrl: escapeHtml(bypassed.finalUrl),
              hops: String(bypassed.hops),
            }),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [
                [{ text: t(lang, 'bypassOpenBtn'), url: bypassed.finalUrl }],
              ],
            },
          })
          return
        }
      } catch {}
    }

    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'unsupported'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  // TikTok Live link auto-detection (vt.tiktok.com, vm.tiktok.com, or tiktok.com/@.../live)
  if (platform === 'tiktok') {
    let checkUrl = url
    if (url.includes('vt.tiktok.com') || url.includes('vm.tiktok.com') || /\/t\//.test(url)) {
      try {
        checkUrl = await canonicalTikTokUrl(url)
      } catch {}
    }
    if (checkUrl.includes('/live')) {
      await handleRecordCommand(tg, message, url, lang, env, store, origin)
      return
    }
  }

  // Facebook story, highlight, or profile link
  if (platform === 'facebook') {
    let resolvedFbUrl = url
    if (/fb\.watch|\/share\//i.test(resolvedFbUrl)) {
      try {
        resolvedFbUrl = await resolveFacebookShare(resolvedFbUrl)
      } catch {}
    }

    const storyTarget = parseFacebookStoryLink(resolvedFbUrl) || parseFacebookStoryLink(url)
    if (storyTarget) {
      if (storyTarget.kind === 'story') {
        const status = await tg.call<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'storiesSending'),
          reply_to_message_id: message.message_id,
        })
        await showFacebookStories(tg, chatId, status.message_id, storyTarget.bucketId, lang, env)
        return
      }
      if (storyTarget.kind === 'highlight') {
        const status = await tg.call<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'highlightsSending'),
          reply_to_message_id: message.message_id,
        })
        await sendDirectFacebookHighlight(tg, chatId, status.message_id, storyTarget.highlightId, lang, env)
        return
      }
    }

    const fbProfile = parseFacebookProfile(resolvedFbUrl) || parseFacebookProfile(url)
    if (fbProfile) {
      await handleFacebookProfile(tg, message, fbProfile, lang, env, store, origin)
      return
    }
  }

  // Instagram story or highlight link
  if (platform === 'instagram') {
    const storyTarget = parseInstagramStoryLink(url)
    if (storyTarget) {
      if (storyTarget.kind === 'story') {
        const status = await tg.call<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'storiesSending'),
          reply_to_message_id: message.message_id,
        })
        await showStories(tg, chatId, status.message_id, storyTarget.username, lang, env)
        return
      }
      if (storyTarget.kind === 'highlight') {
        const status = await tg.call<{ message_id: number }>('sendMessage', {
          chat_id: chatId,
          text: t(lang, 'highlightsSending'),
          reply_to_message_id: message.message_id,
        })
        await sendDirectHighlight(
          tg,
          chatId,
          status.message_id,
          storyTarget.highlightId,
          lang,
          env,
          (storyTarget as { username?: string }).username,
        )
        return
      }
    }

    const profile = parseInstagramProfile(url)
    if (profile) {
      await handleProfile(tg, message, profile.username, true, lang, env, store, origin)
      return
    }
  }

  // YouTube video or playlist link
  if (platform === 'youtube') {
    await handleYouTubeLink(tg, message, url, lang, env, store, origin)
    return
  }

  // Coomer profile or post link
  if (platform === 'coomer') {
    await handleCoomerLink(tg, message, url, lang, env, store, origin)
    return
  }

  // Erome album link
  if (platform === 'erome') {
    await handleEromeLink(tg, message, url, lang, env, store, origin)
    return
  }

  // Bunkr album or file link
  if (platform === 'bunkr') {
    await handleBunkrLink(tg, message, url, lang, env, store, origin)
    return
  }

  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: platformName(platform, lang) }),
    reply_to_message_id: message.message_id,
  })

  try {
    const result = await resolveMedia({ url, mode: 'video', quality: 'max' }, env, store)
    const items = trimForTelegram(result.items)
    if (!items.length) throw new ResolveError('empty_result', 'No downloadable media found in this link.')

    const key = shortKey()
    const stored: StoredMedia = { result, items, lang }
    await store.put(`m:${key}`, JSON.stringify(stored), 3600)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: summary(result, lang),
      parse_mode: 'HTML',
      reply_markup: await buildKeyboard(result, items, key, lang, env, origin),
      disable_web_page_preview: true,
    })
  } catch (error) {
    const reason = escapeHtml(errorMessage(error).slice(0, 320))
    const hint = error instanceof ResolveError && error.hint ? `\n\n${escapeHtml(error.hint.slice(0, 320))}` : ''
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: t(lang, 'resolveFailed', { reason }) + hint,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }
}

async function handleProfile(
  tg: TelegramApi,
  message: TgMessage,
  username: string,
  withPhotos: boolean,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: platformName('instagram', lang) }),
    reply_to_message_id: message.message_id,
  })

  try {
    const profile = await resolveInstagramProfile({
      username,
      env,
      withPhotos,
      maxItems: profileMaxItems(env),
    })

    const result: MediaResult = {
      platform: 'instagram',
      sourceUrl: `https://www.instagram.com/${profile.info.username}/`,
      title: profile.info.fullName
        ? `${profile.info.fullName} (@${profile.info.username})`
        : `@${profile.info.username}`,
      author: `@${profile.info.username}`,
      thumbnail: profile.info.avatarUrl,
      items: profile.items,
      engine: 'instagram-profile',
    }

    const key = shortKey()
    const stored: StoredMedia = {
      result,
      items: profile.items,
      lang,
      album: profile.photos,
      profile: {
        username: profile.info.username,
        fullName: profile.info.fullName,
        followers: profile.info.followers,
        posts: profile.info.posts,
        hd: profile.info.hd,
        truncated: profile.truncated,
      },
    }
    await store.put(`m:${key}`, JSON.stringify(stored), 3600)

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: profileText(profile, lang, withPhotos),
      parse_mode: 'HTML',
      reply_markup: await buildProfileKeyboard(
        {
          username: profile.info.username,
          fullName: profile.info.fullName,
          hd: profile.info.hd,
          photoCount: profile.photoCount,
          archiveTotal:
            env.IG_COOKIE ? (profile.info.posts && profile.info.posts > 0 ? profile.info.posts : 1) : undefined,
          items: profile.items,
        },
        key,
        lang,
        env,
        origin,
      ),
      disable_web_page_preview: true,
    })
  } catch (error) {
    const missing = error instanceof Error && /private|not a valid|unavailable/i.test(error.message)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: missing
        ? t(lang, 'profileNotFound')
        : t(lang, 'resolveFailed', { reason: escapeHtml(errorMessage(error).slice(0, 320)) }),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }
}

function profileText(profile: InstagramProfileResult, lang: Lang, withPhotos: boolean): string {
  const { info } = profile
  const name = escapeHtml(info.fullName || `@${info.username}`)
  const followers = info.followers ? String(info.followers) : '—'
  const posts = info.posts ? String(info.posts) : '—'
  const photosLine = profile.photoCount ? t(lang, 'profilePhotosLine', { n: profile.photoCount }) : ''

  const lines = [
    t(lang, 'profileHeader', { name, followers, posts, photosLine }),
    '',
    info.hd ? t(lang, 'profileHdActive') : t(lang, 'profileHdNote'),
  ]
  if (withPhotos && profile.truncated && profile.photoCount > 0 && info.posts) {
    lines.push(t(lang, 'profileTruncated', { shown: profile.photoCount, total: info.posts }))
  }
  if (withPhotos && !profile.photoCount) lines.push(t(lang, 'profileNoPhotos'))
  return lines.join('\n')
}

async function handleFacebookProfile(
  tg: TelegramApi,
  message: TgMessage,
  target: FacebookProfileTarget,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: platformName('facebook', lang) }),
    reply_to_message_id: message.message_id,
  })

  try {
    const profile = await resolveFacebookProfile({
      target: target.url,
      env,
      maxItems: profileMaxItems(env),
    })

    const result: MediaResult = {
      platform: 'facebook',
      sourceUrl: target.url,
      title: profile.info.name,
      author: profile.info.name,
      thumbnail: profile.info.avatarUrl,
      items: profile.items,
      engine: 'facebook-profile',
    }

    const key = shortKey()
    const stored: StoredMedia = {
      result,
      items: profile.items,
      lang,
      album: profile.photos,
      fbProfile: {
        username: profile.info.username,
        name: profile.info.name,
        userId: profile.info.userId,
        storyBucketId: profile.info.storyBucketId,
        highlightId: profile.info.highlightId,
        highlightIds: profile.info.highlightIds,
        photoCount: profile.photoCount,
        hd: profile.info.hd,
        dtsg: profile.info.dtsg,
      },
    }
    await store.put(`m:${key}`, JSON.stringify(stored), 3600)

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: facebookProfileText(profile, lang),
      parse_mode: 'HTML',
      reply_markup: await buildFacebookProfileKeyboard(
        {
          username: profile.info.username,
          name: profile.info.name,
          hd: profile.info.hd,
          photoCount: profile.photoCount,
          items: profile.items,
        },
        key,
        lang,
        env,
        origin,
      ),
      disable_web_page_preview: true,
    })
  } catch (error) {
    const missing = error instanceof Error && /private|not found|unavailable/i.test(error.message)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: missing
        ? t(lang, 'profileNotFound')
        : t(lang, 'resolveFailed', { reason: escapeHtml(errorMessage(error).slice(0, 320)) }),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }
}

function facebookProfileText(profile: FacebookProfileResult, lang: Lang): string {
  const name = escapeHtml(profile.info.name)
  const photosLine = profile.photoCount ? t(lang, 'fbPhotosLine', { n: profile.photoCount }) : ''
  const lines = [t(lang, 'fbProfileHeader', { name, photosLine })]
  if (!profile.photoCount) lines.push(t(lang, 'fbNoPhotos'))
  return lines.join('\n')
}

async function handleQuickDownload(
  tg: TelegramApi,
  message: TgMessage,
  rest: string,
  mode: 'video' | 'audio',
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const chatId = message.chat.id
  const url = findUrl(rest)

  if (!url) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'quickFailed'),
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
      disable_web_page_preview: true,
    })
    return
  }

  if (!(await withinLimit(tg, store, message.from?.id ?? chatId, chatId, lang, env))) return

  const status = await tg.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'resolving', { platform: platformName(detectPlatform(url), lang) }),
    reply_to_message_id: message.message_id,
  })

  let result: MediaResult | undefined
  let item: MediaItem | undefined
  try {
    result = await resolveMedia({ url, mode, quality: 'max' }, env, store)
    item = pickForMode(result.items, mode, 'max')
    if (!item || (mode === 'audio' && item.kind !== 'audio')) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: status.message_id,
        text: t(lang, 'audioMissing'),
        parse_mode: 'HTML',
      })
      return
    }

    const items = trimForTelegram(result.items)
    const key = shortKey()
    await store.put(`m:${key}`, JSON.stringify({ result, items, lang } satisfies StoredMedia), 3600)

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: t(lang, 'sending', { label: qualityLabel(item) }),
      parse_mode: 'HTML',
    })

    await sendMedia(tg, chatId, item, {
      caption: summary(result, lang),
      filename: itemFilename(result, item),
      maxBytes: maxUploadBytes(env),
    })

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: status.message_id,
      text: t(lang, 'sent', { label: qualityLabel(item) }),
      parse_mode: 'HTML',
      reply_markup: await buildKeyboard(result, items, key, lang, env, origin),
    })
  } catch (error) {
    let directUrl: string | undefined
    if (error instanceof UploadTooLarge && item && result) {
      directUrl = await signFileUrl(item, itemFilename(result, item), env, origin, 86400)
    }
    await reportFailure(tg, chatId, status.message_id, error, lang, env, directUrl)
  }
}

const REEL_LIMIT = 12

/** Stories/highlights mix photos and videos; post the photos as one album. */
async function sendReel(
  tg: TelegramApi,
  chatId: number | string,
  items: MediaItem[],
  caption: string,
  env: Env,
): Promise<number> {
  const chosen = items.slice(0, REEL_LIMIT)
  const photos = chosen.filter((entry) => entry.kind === 'image')
  const videos = chosen.filter((entry) => entry.kind === 'video')
  let sent = 0
  let captionUsed = false

  if (photos.length) {
    sent += await sendAlbum(tg, chatId, photos, {
      caption,
      filename: 'story.jpg',
      maxBytes: maxUploadBytes(env),
    })
    captionUsed = true
  }

  for (const video of videos) {
    await sendMedia(tg, chatId, video, {
      caption: captionUsed ? undefined : caption,
      filename: 'story.mp4',
      maxBytes: maxUploadBytes(env),
    })
    captionUsed = true
    sent += 1
  }

  return sent
}

async function showStories(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  username: string,
  lang: Lang,
  env: Env,
  back?: () => Promise<InlineKeyboard | undefined>,
): Promise<void> {
  try {
    const stories = await fetchActiveStories(username, env)
    const items = stories.items.slice(0, REEL_LIMIT)

    if (!items.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'storiesEmpty'),
        reply_markup: back ? await back() : undefined,
        parse_mode: 'HTML',
      })
      return
    }

    const sent = await sendReel(
      tg,
      chatId,
      items,
      t(lang, 'storiesCaption', { user: username, sent: items.length }),
      env,
    )

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'storiesSent', { n: sent }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'storiesFailed', { reason: escapeHtml(errorMessage(error).slice(0, 200)) }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  }
}

function highlightsKeyboard(highlights: InstagramHighlight[], key: string): InlineKeyboard {
  return {
    inline_keyboard: highlights.slice(0, 25).map((highlight, index) => [
      {
        text: cleanButtonText(`${highlight.title}${highlight.count ? ` (${highlight.count})` : ''}`, 40),
        callback_data: `H|${key}|${index}`,
      },
    ]),
  }
}

async function showHighlights(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  username: string,
  lang: Lang,
  env: Env,
  store: Store,
  key: string,
  stored: StoredMedia,
  back?: () => Promise<InlineKeyboard | undefined>,
): Promise<void> {
  try {
    const highlights = await fetchHighlights(username, env)

    if (!highlights.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'highlightsEmpty'),
        reply_markup: back ? await back() : undefined,
        parse_mode: 'HTML',
      })
      return
    }

    stored.highlights = highlights
    await store.put(`m:${key}`, JSON.stringify(stored), 3600)

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'highlightsHeader', { user: username, n: highlights.length }),
      reply_markup: highlightsKeyboard(highlights, key),
      parse_mode: 'HTML',
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'highlightsFailed', { reason: escapeHtml(errorMessage(error).slice(0, 200)) }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  }
}

async function sendHighlight(
  tg: TelegramApi,
  query: any,
  chatId: number | string,
  messageId: number,
  key: string,
  indexRaw: string | undefined,
  stored: StoredMedia,
  lang: Lang,
  env: Env,
): Promise<void> {
  const highlights = stored.highlights ?? []
  const highlight = highlights[Number(indexRaw)]
  if (!highlight) {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  await answer(tg, query?.id, t(lang, 'highlightsSending'))
  const keyboard = highlights.length ? highlightsKeyboard(highlights, key) : undefined

  try {
    const page = await fetchHighlightItems(highlight.id, env, stored.profile?.username)
    const items = page.items.slice(0, REEL_LIMIT)

    if (!items.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'highlightsEmpty'),
        reply_markup: keyboard,
        parse_mode: 'HTML',
      })
      return
    }

    const username = stored.profile?.username ?? highlight.title
    const sent = await sendReel(
      tg,
      chatId,
      items,
      t(lang, 'storiesCaption', { user: username, sent: items.length }),
      env,
    )
    const note =
      page.items.length > items.length
        ? `\n${t(lang, 'highlightsTooMany', { sent: items.length, total: page.items.length })}`
        : ''

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `${t(lang, 'highlightsSent', { n: sent, title: escapeHtml(highlight.title) })}${note}`,
      reply_markup: keyboard,
      parse_mode: 'HTML',
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'highlightsFailed', { reason: escapeHtml(errorMessage(error).slice(0, 200)) }),
      reply_markup: keyboard,
      parse_mode: 'HTML',
    })
  }
}

async function sendDirectHighlight(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  highlightId: string,
  lang: Lang,
  env: Env,
  username?: string,
): Promise<void> {
  try {
    const page = await fetchHighlightItems(highlightId, env, username)
    const items = page.items
    if (!items.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'highlightsEmpty'),
        parse_mode: 'HTML',
      })
      return
    }

    const title = page.title || 'Highlight'
    const sent = await sendReel(
      tg,
      chatId,
      items,
      `✨ <b>${escapeHtml(title)}</b>`,
      env,
    )

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'highlightsSent', { n: sent, title: escapeHtml(title) }),
      parse_mode: 'HTML',
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'highlightsFailed', { reason: escapeHtml(errorMessage(error).slice(0, 200)) }),
      parse_mode: 'HTML',
    })
  }
}

async function showFacebookStories(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  targetId: string,
  lang: Lang,
  env: Env,
  back?: () => Promise<InlineKeyboard | undefined>,
  opts: { dtsg?: string } = {},
): Promise<void> {
  if (!env.FB_COOKIE) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'fbStoriesNeedCookie'),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
    return
  }

  try {
    const stories = await fetchFacebookStories(targetId, env, opts)
    const items = stories.items.slice(0, REEL_LIMIT)

    if (!items.length) {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'fbStoriesEmpty'),
        reply_markup: back ? await back() : undefined,
        parse_mode: 'HTML',
      })
      return
    }

    const name = stories.name ?? targetId
    const sent = await sendReel(
      tg,
      chatId,
      items,
      t(lang, 'fbStoriesCaption', { name, sent: items.length }),
      env,
    )

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'storiesSent', { n: sent }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  } catch (error) {
    const is404 = error instanceof Error && /404|not found|unavailable/i.test(error.message)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: is404
        ? t(lang, 'fbStoriesEmpty')
        : t(lang, 'fbStoriesFailed', { reason: escapeHtml(errorMessage(error).slice(0, 200)) }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  }
}

async function showFacebookHighlights(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  highlightIds: string[],
  lang: Lang,
  env: Env,
  back?: () => Promise<InlineKeyboard | undefined>,
  opts: { dtsg?: string } = {},
): Promise<void> {
  if (!env.FB_COOKIE) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'fbStoriesNeedCookie'),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
    return
  }

  try {
    // A profile can have several highlight collections; merge their items in
    // page order. One unreadable collection must not sink the rest, but if
    // everything fails we surface the real error instead of "no highlights".
    const merged: MediaItem[] = []
    const seenUrls = new Set<string>()
    let title: string | undefined
    let firstError: unknown
    for (const id of highlightIds.slice(0, 6)) {
      try {
        const hl = await fetchFacebookHighlights(id, env, opts)
        if (!title && hl.title) title = hl.title
        for (const item of hl.items) {
          if (!seenUrls.has(item.url)) {
            seenUrls.add(item.url)
            merged.push(item)
          }
        }
      } catch (error) {
        firstError ??= error
      }
      if (merged.length >= REEL_LIMIT) break
    }

    const items = merged.slice(0, REEL_LIMIT)

    if (!items.length) {
      if (firstError) throw firstError
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'fbHighlightsEmpty'),
        reply_markup: back ? await back() : undefined,
        parse_mode: 'HTML',
      })
      return
    }

    const captionTitle = title ?? 'Highlights'
    const sent = await sendReel(
      tg,
      chatId,
      items,
      t(lang, 'fbHighlightsCaption', { title: captionTitle, sent: items.length }),
      env,
    )

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'highlightsSent', { n: sent, title: escapeHtml(captionTitle) }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  } catch (error) {
    const is404 = error instanceof Error && /404|not found|unavailable/i.test(error.message)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: is404
        ? t(lang, 'fbHighlightsEmpty')
        : t(lang, 'fbHighlightsFailed', { reason: escapeHtml(errorMessage(error).slice(0, 200)) }),
      reply_markup: back ? await back() : undefined,
      parse_mode: 'HTML',
    })
  }
}

async function sendDirectFacebookHighlight(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  highlightId: string,
  lang: Lang,
  env: Env,
): Promise<void> {
  await showFacebookHighlights(tg, chatId, messageId, [highlightId], lang, env)
}

async function handleArchive(
  tg: TelegramApi,
  query: any,
  chatId: number | string,
  messageId: number,
  key: string,
  stored: StoredMedia,
  lang: Lang,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  if (!env.IG_COOKIE) {
    await answer(tg, query?.id, t(lang, 'archiveNeedsCookie'), true)
    return
  }
  const username = stored.profile?.username
  if (!username) {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  const state = stored.archive ?? { sent: 0, videos: 0 }
  await answer(tg, query?.id, t(lang, 'archiveSending'))

  try {
    const page = await fetchArchivePage({ username, env, cursor: state.cursor, pageSize: 17 })
    const sent = state.sent + page.items.length
    const videos = state.videos + page.videoCount
    const total = page.total ?? state.total
    stored.archive = { cursor: page.nextCursor, sent, videos, total }
    if (stored.profile && total) stored.profile.posts = total

    if (page.items.length) {
      await sendAlbum(tg, chatId, page.items, {
        caption: summary(stored.result, lang),
        filename: itemFilename(stored.result, page.items[0]),
        maxBytes: maxUploadBytes(env),
      })
    }

    await store.put(`m:${key}`, JSON.stringify(stored), 21_600)

    const hasMore = Boolean(page.nextCursor)
    const text = hasMore
      ? t(lang, 'archiveProgress', { sent, videos, total: total ?? sent })
      : t(lang, 'archiveDone', { sent, videos })

    const rows: InlineButton[][] = []
    if (hasMore) rows.push([{ text: t(lang, 'archiveMoreBtn'), callback_data: `A|${key}|1` }])
    const avatar = stored.items[0]
    if (avatar) {
      rows.push([
        {
          text: t(lang, 'directLink'),
          url: await signFileUrl(avatar, itemFilename(stored.result, avatar), env, origin),
        },
      ])
    }

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: rows.length ? { inline_keyboard: rows } : undefined,
      disable_web_page_preview: true,
    })
  } catch (error) {
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: `${t(lang, 'archiveFailed')}\n<code>${escapeHtml(errorMessage(error).slice(0, 300))}</code>`,
      parse_mode: 'HTML',
    })
  }
}

async function handleYouTubeCallback(
  tg: TelegramApi,
  query: any,
  chatId: number | string,
  messageId: number,
  parts: string[],
  lang: Lang,
  env: Env,
  store: Store,
  _origin: string,
): Promise<void> {
  const [tag, key, p2, p3, p4] = parts

  // 1. YouTube Single Video: Format chosen (MP4 vs MP3)
  if (tag === 'ytf') {
    const raw = await store.get(`ytv:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const video = JSON.parse(raw) as StoredYouTubeVideo
    await answer(tg, query?.id, '')

    if (p2 === 'video') {
      const kb = {
        inline_keyboard: [
          [
            { text: '🌟 1080p FHD', callback_data: `ytq|${key}|1080` },
            { text: '🎬 720p HD', callback_data: `ytq|${key}|720` },
          ],
          [
            { text: '📺 480p SD', callback_data: `ytq|${key}|480` },
            { text: '📱 360p', callback_data: `ytq|${key}|360` },
          ],
          [
            { text: t(lang, 'ytBackBtn'), callback_data: `ytb|${key}|0` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'ytChooseVideoQuality', { title: escapeHtml(video.title) }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
      return
    }

    if (p2 === 'audio') {
      const kb = {
        inline_keyboard: [
          [
            { text: '💎 320 kbps (عالية جداً)', callback_data: `ytq|${key}|320` },
          ],
          [
            { text: '🎧 192 kbps (ممتازة)', callback_data: `ytq|${key}|192` },
            { text: '📻 128 kbps (قياسية)', callback_data: `ytq|${key}|128` },
          ],
          [
            { text: t(lang, 'ytBackBtn'), callback_data: `ytb|${key}|0` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'ytChooseAudioQuality', { title: escapeHtml(video.title) }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
      return
    }
  }

  // 2. YouTube Single Video: Back to format selection
  if (tag === 'ytb') {
    const raw = await store.get(`ytv:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const video = JSON.parse(raw) as StoredYouTubeVideo
    await answer(tg, query?.id, '')

    const kb = {
      inline_keyboard: [
        [
          { text: t(lang, 'ytVideoFormatBtn'), callback_data: `ytf|${key}|video` },
          { text: t(lang, 'ytAudioFormatBtn'), callback_data: `ytf|${key}|audio` },
        ],
      ],
    }
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'ytChooseFormat', {
        title: escapeHtml(video.title),
        author: escapeHtml(video.author),
        duration: formatDuration(video.duration),
      }),
      parse_mode: 'HTML',
      reply_markup: kb,
    })
    return
  }

  // 3. YouTube Single Video: Quality chosen -> Resolve & Send!
  if (tag === 'ytq') {
    const raw = await store.get(`ytv:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const video = JSON.parse(raw) as StoredYouTubeVideo
    const quality = (p2 || '720') as Quality
    const mode: Mode = ['320', '192', '128'].includes(quality) ? 'audio' : 'video'

    await answer(tg, query?.id, t(lang, 'sending', { label: quality }))
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'sending', { label: quality }),
      parse_mode: 'HTML',
    })

    let result: MediaResult | undefined
    try {
      result = await resolveMedia({ url: video.url, mode, quality }, env, store)
      const item = result.items[0]
      if (!item) throw new ResolveError('empty_result', 'No downloadable media found in this video.')

      await sendMedia(tg, chatId, item, {
        caption: summary(result, lang),
        filename: itemFilename(result, item),
        maxBytes: maxUploadBytes(env),
      })

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'sent', { label: quality }),
        parse_mode: 'HTML',
      })
    } catch (error) {
      let directUrl: string | undefined
      if (error instanceof UploadTooLarge && result?.items?.[0]) {
        directUrl = await signFileUrl(result.items[0], itemFilename(result, result.items[0]), env, origin, 86400)
      }
      await reportFailure(tg, chatId, messageId, error, lang, env, directUrl)
    }
    return
  }

  // 4. YouTube Playlist: Format chosen (MP4 vs MP3)
  if (tag === 'ytplf') {
    const raw = await store.get(`ytpl:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const pl = JSON.parse(raw) as YouTubePlaylistResult
    await answer(tg, query?.id, '')

    if (p2 === 'video') {
      const kb = {
        inline_keyboard: [
          [
            { text: '🌟 1080p FHD', callback_data: `ytplq|${key}|v|1080|0` },
            { text: '🎬 720p HD', callback_data: `ytplq|${key}|v|720|0` },
          ],
          [
            { text: '📺 480p SD', callback_data: `ytplq|${key}|v|480|0` },
            { text: '📱 360p', callback_data: `ytplq|${key}|v|360|0` },
          ],
          [
            { text: t(lang, 'ytBackBtn'), callback_data: `ytplb|${key}|0` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'ytPlaylistQualityPrompt', {
          title: escapeHtml(pl.title),
          mode: t(lang, 'ytVideoFormatBtn'),
        }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
      return
    }

    if (p2 === 'audio') {
      const kb = {
        inline_keyboard: [
          [
            { text: '💎 320 kbps (عالية جداً)', callback_data: `ytplq|${key}|a|320|0` },
          ],
          [
            { text: '🎧 192 kbps (ممتازة)', callback_data: `ytplq|${key}|a|192|0` },
            { text: '📻 128 kbps (قياسية)', callback_data: `ytplq|${key}|a|128|0` },
          ],
          [
            { text: t(lang, 'ytBackBtn'), callback_data: `ytplb|${key}|0` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'ytPlaylistQualityPrompt', {
          title: escapeHtml(pl.title),
          mode: t(lang, 'ytAudioFormatBtn'),
        }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
      return
    }
  }

  // 5. YouTube Playlist: Back to playlist main card
  if (tag === 'ytplb') {
    const raw = await store.get(`ytpl:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const pl = JSON.parse(raw) as YouTubePlaylistResult
    await answer(tg, query?.id, '')

    const kb = {
      inline_keyboard: [
        [
          { text: t(lang, 'ytPlaylistVideoBtn'), callback_data: `ytplf|${key}|video` },
        ],
        [
          { text: t(lang, 'ytPlaylistAudioBtn'), callback_data: `ytplf|${key}|audio` },
        ],
        [
          { text: t(lang, 'ytPlaylistBrowseBtn'), callback_data: `ytpli|${key}|0` },
        ],
      ],
    }
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'ytPlaylistTitle', {
        title: escapeHtml(pl.title),
        author: escapeHtml(pl.author),
        count: pl.videoCount,
      }),
      parse_mode: 'HTML',
      reply_markup: kb,
    })
    return
  }

  // 6. YouTube Playlist: Download batch
  if (tag === 'ytplq') {
    const raw = await store.get(`ytpl:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const pl = JSON.parse(raw) as YouTubePlaylistResult
    const modeCode = p2 || 'v'
    const mode: Mode = modeCode === 'a' ? 'audio' : 'video'
    const quality = (p3 || (mode === 'audio' ? '192' : '720')) as Quality
    const startIndex = parseInt(p4 || '0', 10)
    const batchSize = 3
    const batch = pl.items.slice(startIndex, startIndex + batchSize)

    await answer(tg, query?.id, '')
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'ytPlaylistDownloading', {
        done: startIndex,
        total: pl.items.length,
      }),
      parse_mode: 'HTML',
    })

    for (const videoItem of batch) {
      try {
        const vUrl = `https://www.youtube.com/watch?v=${videoItem.videoId}`
        const result = await resolveMedia({ url: vUrl, mode, quality }, env, store)
        const item = result.items[0]
        if (item) {
          await sendMedia(tg, chatId, item, {
            caption: summary(result, lang),
            filename: itemFilename(result, item),
            maxBytes: maxUploadBytes(env),
          })
        }
      } catch (err) {
        console.error('Failed to download playlist item:', videoItem.videoId, err)
      }
    }

    const nextIndex = startIndex + batch.length
    if (nextIndex < pl.items.length) {
      const kb = {
        inline_keyboard: [
          [
            {
              text: t(lang, 'ytPlaylistNextBatch', {
                next: nextIndex,
                total: pl.items.length,
              }),
              callback_data: `ytplq|${key}|${modeCode}|${quality}|${nextIndex}`,
            },
          ],
          [
            { text: t(lang, 'ytBackBtn'), callback_data: `ytplb|${key}|0` },
          ],
        ],
      }
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'ytPlaylistDownloading', {
          done: nextIndex,
          total: pl.items.length,
        }),
        parse_mode: 'HTML',
        reply_markup: kb,
      })
    } else {
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'ytPlaylistDone'),
        parse_mode: 'HTML',
      })
    }
    return
  }

  // 7. YouTube Playlist: Browse videos (paginated)
  if (tag === 'ytpli') {
    const raw = await store.get(`ytpl:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const pl = JSON.parse(raw) as YouTubePlaylistResult
    const page = parseInt(p2 || '0', 10)
    const pageSize = 5
    const totalPages = Math.ceil(pl.items.length / pageSize) || 1
    const pageItems = pl.items.slice(page * pageSize, (page + 1) * pageSize)

    await answer(tg, query?.id, '')

    let listText =
      t(lang, 'ytPlaylistBrowseTitle', {
        title: escapeHtml(pl.title),
        page: page + 1,
        totalPages,
      }) + '\n'

    const numButtons: Array<{ text: string; callback_data: string }> = []
    pageItems.forEach((it, idx) => {
      const overallIdx = page * pageSize + idx
      const num = overallIdx + 1
      listText += `\n<b>${num}.</b> ${escapeHtml(it.title)}`
      numButtons.push({
        text: `${num}`,
        callback_data: `ytpls|${key}|${overallIdx}`,
      })
    })

    const navButtons: Array<{ text: string; callback_data: string }> = []
    if (page > 0) {
      navButtons.push({ text: '⬅️ السابق', callback_data: `ytpli|${key}|${page - 1}` })
    }
    if (page + 1 < totalPages) {
      navButtons.push({ text: 'التالي ➡️', callback_data: `ytpli|${key}|${page + 1}` })
    }

    const kbRows = [numButtons]
    if (navButtons.length) kbRows.push(navButtons)
    kbRows.push([{ text: t(lang, 'ytBackBtn'), callback_data: `ytplb|${key}|0` }])

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: listText,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: kbRows },
    })
    return
  }

  // 8. YouTube Playlist: Specific video picked from browse list
  if (tag === 'ytpls') {
    const raw = await store.get(`ytpl:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const pl = JSON.parse(raw) as YouTubePlaylistResult
    const itemIdx = parseInt(p2 || '0', 10)
    const videoItem = pl.items[itemIdx]
    if (!videoItem) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    await answer(tg, query?.id, '')

    const vKey = shortKey()
    const vUrl = `https://www.youtube.com/watch?v=${videoItem.videoId}`
    const storedVideo: StoredYouTubeVideo = {
      videoId: videoItem.videoId,
      title: videoItem.title,
      author: videoItem.author || pl.author,
      duration: videoItem.duration,
      thumbnail: videoItem.thumbnail,
      url: vUrl,
    }
    await store.put(`ytv:${vKey}`, JSON.stringify(storedVideo), 3600)

    const kb = {
      inline_keyboard: [
        [
          { text: t(lang, 'ytVideoFormatBtn'), callback_data: `ytf|${vKey}|video` },
          { text: t(lang, 'ytAudioFormatBtn'), callback_data: `ytf|${vKey}|audio` },
        ],
        [
          { text: t(lang, 'ytBackBtn'), callback_data: `ytpli|${key}|${Math.floor(itemIdx / 5)}` },
        ],
      ],
    }
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'ytChooseFormat', {
        title: escapeHtml(storedVideo.title),
        author: escapeHtml(storedVideo.author),
        duration: formatDuration(storedVideo.duration),
      }),
      parse_mode: 'HTML',
      reply_markup: kb,
    })
    return
  }
}

async function handleCallback(
  tg: TelegramApi,
  query: any,
  env: Env,
  store: Store,
  origin: string,
): Promise<void> {
  const lang = pickLang(query?.from?.language_code, env)
  const chatId = query?.message?.chat?.id
  const messageId = query?.message?.message_id
  const parts = String(query?.data ?? '').split('|')
  const tag = parts[0]
  const key = parts[1]
  const indexRaw = parts[2]

  if (!chatId || !messageId) {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  if (tag === 'n') {
    await answer(tg, query?.id, t(lang, 'mp3Unavailable'), true)
    return
  }

  if (!(await withinLimit(tg, store, query?.from?.id ?? chatId, chatId, lang, env))) {
    await answer(tg, query?.id, t(lang, 'rateLimited', { limit: rateLimitPerMin(env) }), true)
    return
  }

  if (tag.startsWith('yt')) {
    await handleYouTubeCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag.startsWith('cmr')) {
    await handleCoomerCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag.startsWith('erm')) {
    await handleEromeCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag.startsWith('bkr')) {
    await handleBunkrCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag.startsWith('rec')) {
    await handleRecordCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag === 'arch') {
    await handleRecordingsArchiveCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag.startsWith('menu')) {
    await handleMenuCallback(tg, query, chatId, messageId, parts, lang)
    return
  }

  if (tag.startsWith('mov')) {
    await handleMovieCallback(tg, query, chatId, messageId, parts, lang, env, store, origin)
    return
  }

  if (tag === 'ai') {
    const raw = await store.get(`m:${key}`)
    if (!raw) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    const stored: StoredMedia = JSON.parse(raw)
    const mediaItem = stored.items.find((i) => i.kind === 'audio') || stored.items.find((i) => i.kind === 'video')
    if (!mediaItem) {
      await answer(tg, query?.id, t(lang, 'aiNoMediaFound'), true)
      return
    }

    const apiKey = await resolveGeminiApiKey(env, store, chatId)
    if (!apiKey) {
      await answer(tg, query?.id, 'مفتاح Gemini مطلوب', true)
      await tg.call('sendMessage', {
        chat_id: chatId,
        text: t(lang, 'aiKeyNeeded'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      })
      return
    }

    await answer(tg, query?.id, t(lang, 'aiTranscribing'))
    const statusMsg = await tg.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text: t(lang, 'aiTranscribing'),
      parse_mode: 'HTML',
      reply_to_message_id: messageId,
    })

    try {
      const headers: Record<string, string> = {}
      if (mediaItem.referer) headers.Referer = mediaItem.referer
      headers.Range = 'bytes=0-15728640'

      const mediaRes = await fetch(mediaItem.url, {
        headers,
        signal: AbortSignal.timeout(25000),
      })
      if (!mediaRes.ok && mediaRes.status !== 206) {
        throw new Error(`Media fetch failed: HTTP ${mediaRes.status}`)
      }
      const audioBytes = await mediaRes.arrayBuffer()
      const effectiveEnv = { ...env, GEMINI_API_KEY: apiKey }
      const res = await transcribeAndSummarizeAudio(audioBytes, mediaItem.mime || 'audio/mp4', effectiveEnv)

      const formatted = t(lang, 'aiResult', {
        transcript: escapeHtml(res.transcript || '—'),
        summary: escapeHtml(res.summary || '—'),
      })

      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: formatted,
        parse_mode: 'HTML',
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        text: `❌ ${escapeHtml(msg)}`,
        parse_mode: 'HTML',
      })
    }
    return
  }

  const raw = await store.get(`m:${key}`)
  if (!raw) {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  let stored: StoredMedia
  try {
    stored = JSON.parse(raw) as StoredMedia
  } catch {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  const item = stored.items[Number(indexRaw)]

  if (tag === 'A') {
    await handleArchive(tg, query, chatId, messageId, key, stored, lang, env, store, origin)
    return
  }

  if (tag === 'fbs' || tag === 'fbh') {
    if (!env.FB_COOKIE) {
      await answer(tg, query?.id, t(lang, 'fbStoriesNeedCookie'), true)
      return
    }
    const back = async () => await storedKeyboard(stored, key, lang, env, origin)

    if (tag === 'fbs') {
      const targetId =
        stored.fbProfile?.storyBucketId || stored.fbProfile?.userId || stored.fbProfile?.username
      if (!targetId) {
        await answer(tg, query?.id, t(lang, 'expired'), true)
        return
      }
      await answer(tg, query?.id, t(lang, 'storiesSending'))
      await showFacebookStories(tg, chatId, messageId, targetId, lang, env, back, { dtsg: stored.fbProfile?.dtsg })
      return
    }

    if (tag === 'fbh') {
      const highlightIds = stored.fbProfile?.highlightIds?.length
        ? stored.fbProfile.highlightIds
        : stored.fbProfile?.highlightId
          ? [stored.fbProfile.highlightId]
          : []
      if (!highlightIds.length) {
        await answer(tg, query?.id, t(lang, 'fbHighlightsEmpty'), true)
        await tg.safeEdit('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: t(lang, 'fbHighlightsEmpty'),
          reply_markup: back ? await back() : undefined,
          parse_mode: 'HTML',
        })
        return
      }
      await answer(tg, query?.id, t(lang, 'highlightsSending'))
      await showFacebookHighlights(tg, chatId, messageId, highlightIds, lang, env, back, { dtsg: stored.fbProfile?.dtsg })
      return
    }
  }

  if (tag === 's' || tag === 'h') {
    const username = stored.profile?.username
    if (!username) {
      await answer(tg, query?.id, t(lang, 'expired'), true)
      return
    }
    if (!hasInstagramStoriesSource(env)) {
      await answer(tg, query?.id, t(lang, 'storiesNeedCookie'), true)
      return
    }
    await answer(tg, query?.id, tag === 's' ? t(lang, 'storiesSending') : t(lang, 'highlightsSending'))
    const back = async () => await storedKeyboard(stored, key, lang, env, origin)
    if (tag === 's') {
      await showStories(tg, chatId, messageId, username, lang, env, back)
    } else {
      await showHighlights(tg, chatId, messageId, username, lang, env, store, key, stored, back)
    }
    return
  }

  if (tag === 'H') {
    await sendHighlight(tg, query, chatId, messageId, key, indexRaw, stored, lang, env)
    return
  }

  if (tag === 'a') {
    const media = (stored.album?.length ? stored.album : stored.items.slice(1)).slice(
      0,
      profileMaxItems(env),
    )
    if (!media.length) {
      await answer(tg, query?.id, stored.fbProfile ? t(lang, 'fbNoPhotos') : t(lang, 'profileNoPhotos'), true)
      return
    }

    await answer(tg, query?.id, t(lang, 'photosSending', { n: media.length }))
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'photosSending', { n: media.length }),
      parse_mode: 'HTML',
    })

    try {
      const sent = await sendAlbum(tg, chatId, media, {
        caption: summary(stored.result, lang),
        filename: itemFilename(stored.result, media[0]),
        maxBytes: maxUploadBytes(env),
      })
      const extra =
        stored.profile?.truncated
          ? `\n\n${t(lang, 'photosPartial', {
              n: sent,
              limit: profileMaxItems(env),
              posts: stored.profile.posts ?? sent,
            })}`
          : ''
      const sentText = stored.fbProfile
        ? t(lang, 'fbPhotosSent', { n: sent })
        : t(lang, 'photosSent', { n: sent }) + extra
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: sentText,
        parse_mode: 'HTML',
        reply_markup: await storedKeyboard(stored, key, lang, env, origin),
      })
    } catch (error) {
      await reportFailure(tg, chatId, messageId, error, lang, env)
    }
    return
  }

  if (!item) {
    await answer(tg, query?.id, t(lang, 'expired'), true)
    return
  }

  const label = qualityLabel(item)
  await answer(tg, query?.id, t(lang, 'sending', { label }))
  await tg.safeEdit('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: t(lang, 'sending', { label }),
    parse_mode: 'HTML',
  })

  try {
    await sendMedia(tg, chatId, item, {
      caption: summary(stored.result, lang),
      filename: itemFilename(stored.result, item),
      maxBytes: maxUploadBytes(env),
    })

    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'sent', { label }),
      parse_mode: 'HTML',
      reply_markup: await storedKeyboard(stored, key, lang, env, origin),
    })
  } catch (error) {
    if (error instanceof UploadTooLarge) {
      const direct = await signFileUrl(item, itemFilename(stored.result, item), env, origin, 86400)
      await tg.safeEdit('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: t(lang, 'tooLarge', { size: humanSize(error.bytes), limit: humanSize(error.limit) }),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: t(lang, 'directDownloadBtn', { size: humanSize(error.bytes) }), url: direct }],
          ],
        },
      })
      return
    }
    await reportFailure(tg, chatId, messageId, error, lang, env)
  }
}

async function reportFailure(
  tg: TelegramApi,
  chatId: number | string,
  messageId: number,
  error: unknown,
  lang: Lang,
  env: Env,
  directUrl?: string,
): Promise<void> {
  if (error instanceof UploadTooLarge) {
    const kb = directUrl
      ? {
          inline_keyboard: [
            [
              {
                text: t(lang, 'directDownloadBtn', { size: humanSize(error.bytes) }),
                url: directUrl,
              },
            ],
          ],
        }
      : undefined
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: t(lang, 'tooLarge', { size: humanSize(error.bytes), limit: humanSize(error.limit) }),
      parse_mode: 'HTML',
      reply_markup: kb,
    })
    return
  }
  const reason = escapeHtml(errorMessage(error).slice(0, 320))
  await tg.safeEdit('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: t(lang, 'downloadFailed', { reason }),
    parse_mode: 'HTML',
  })
  console.error('savelink send failure', errorMessage(error), 'maxUploadMb', maxUploadBytes(env) / 1024 / 1024)
}

async function withinLimit(
  tg: TelegramApi,
  store: Store,
  userId: number | string,
  chatId: number | string,
  lang: Lang,
  env: Env,
): Promise<boolean> {
  const limit = rateLimitPerMin(env)
  const status = await checkRateLimit(store, userId, limit)
  if (status.ok) return true
  await tg.call('sendMessage', {
    chat_id: chatId,
    text: t(lang, 'rateLimited', { limit }),
    parse_mode: 'HTML',
  })
  return false
}

async function answer(tg: TelegramApi, id: string | undefined, text: string, alert = false): Promise<void> {
  if (!id) return
  try {
    await tg.call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 200), show_alert: alert })
  } catch {
    /* callback queries expire quickly; safe to ignore */
  }
}

function summary(result: MediaResult, lang: Lang): string {
  const title = escapeHtml((result.title ?? '').slice(0, 200) || 'Media')
  const meta = [
    result.author ? escapeHtml(result.author) : undefined,
    durationLabel(result.duration),
    platformName(result.platform, lang),
  ]
    .filter(Boolean)
    .join(' · ')
  return `🎬 <b>${title}</b>${meta ? `\n<i>${meta}</i>` : ''}`
}

async function storedKeyboard(
  stored: StoredMedia,
  key: string,
  lang: Lang,
  env: Env,
  origin: string,
): Promise<InlineKeyboard> {
  if (stored.fbProfile) {
    return await buildFacebookProfileKeyboard(
      {
        username: stored.fbProfile.username,
        name: stored.fbProfile.name,
        hd: stored.fbProfile.hd,
        photoCount: stored.album?.length ?? stored.fbProfile.photoCount,
        items: stored.items,
      },
      key,
      lang,
      env,
      origin,
    )
  }
  if (stored.profile) {
    return await buildProfileKeyboard(
      {
        username: stored.profile.username,
        fullName: stored.profile.fullName,
        hd: stored.profile.hd,
        photoCount: stored.album?.length ?? 0,
        archiveTotal:
          env.IG_COOKIE && stored.profile.posts && stored.profile.posts > (stored.album?.length ?? 0)
            ? stored.profile.posts
            : undefined,
        items: stored.items,
      },
      key,
      lang,
      env,
      origin,
    )
  }
  return await buildKeyboard(stored.result, stored.items, key, lang, env, origin)
}

async function buildKeyboard(
  result: MediaResult,
  items: MediaItem[],
  key: string,
  lang: Lang,
  env: Env,
  origin: string,
): Promise<InlineKeyboard> {
  const rows: InlineButton[][] = []
  const videos = items.filter((item) => item.kind === 'video')
  const audio = items.find((item) => item.kind === 'audio')
  const images = items.filter((item) => item.kind === 'image')

  for (let index = 0; index < videos.length; index += 2) {
    rows.push(
      videos.slice(index, index + 2).map((video) => ({
        text: t(lang, 'videoBtn', {
          quality: qualityLabel(video),
          size: video.size ? ` · ${humanSize(video.size)}` : '',
        }),
        callback_data: `d|${key}|${items.indexOf(video)}`,
      })),
    )
  }

  if (audio) {
    rows.push([
      {
        text: t(lang, 'audioBtn', {
          label: qualityLabel(audio),
          size: audio.size ? ` · ${humanSize(audio.size)}` : '',
        }),
        callback_data: `d|${key}|${items.indexOf(audio)}`,
      },
    ])
  } else {
    rows.push([{ text: t(lang, 'mp3Hint'), callback_data: `n|${key}|0` }])
  }

  if (images.length) {
    rows.push([
      {
        text: t(lang, 'imagesBtn', { n: images.length }),
        callback_data: `a|${key}|0`,
      },
    ])
  }

  const best = videos[0] ?? audio ?? images[0]
  if (best) {
    rows.push([
      {
        text: t(lang, 'directLink'),
        url: await signFileUrl(best, itemFilename(result, best), env, origin),
      },
    ])
  }

  if (videos.length || audio) {
    rows.push([
      {
        text: t(lang, 'aiBtn'),
        callback_data: `ai|${key}|0`,
      },
    ])
  }

  return { inline_keyboard: rows }
}

async function buildProfileKeyboard(
  view: ProfileView,
  key: string,
  lang: Lang,
  env: Env,
  origin: string,
): Promise<InlineKeyboard> {
  const avatar = view.items[0]
  const rows: InlineButton[][] = []

  if (avatar) {
    const size = view.hd ? ' · HD' : avatar.width && avatar.height ? ` · ${avatar.width}×${avatar.height}` : ''
    rows.push([
      {
        text: t(lang, 'profileDpBtn', { size }),
        callback_data: `d|${key}|0`,
      },
    ])
  }

  if (view.photoCount) {
    rows.push([
      {
        text: t(lang, 'profilePhotosBtn', { n: view.photoCount }),
        callback_data: `a|${key}|0`,
      },
    ])
  }

  if (view.archiveTotal) {
    const totalDisplay =
      typeof view.archiveTotal === 'number' && view.archiveTotal > 1
        ? view.archiveTotal
        : lang === 'ar'
          ? 'كامل الحساب'
          : 'all'
    rows.push([
      {
        text: t(lang, 'profileArchiveBtn', { n: totalDisplay }),
        callback_data: `A|${key}|0`,
      },
    ])
  }

  if (env.IG_COOKIE) {
    rows.push([
      { text: t(lang, 'profileStoryBtn'), callback_data: `s|${key}|0` },
      { text: t(lang, 'profileHighlightsBtn'), callback_data: `h|${key}|0` },
    ])
  }

  if (avatar) {
    rows.push([
      {
        text: t(lang, 'directLink'),
        url: await signFileUrl(avatar, itemFilename(profileResultFor(view), avatar), env, origin),
      },
    ])
  }

  return { inline_keyboard: rows }
}

function profileResultFor(view: ProfileView): MediaResult {
  return {
    platform: 'instagram',
    sourceUrl: `https://www.instagram.com/${view.username}/`,
    title: view.fullName ? `${view.fullName} (@${view.username})` : `@${view.username}`,
    author: `@${view.username}`,
    items: view.items,
    engine: 'instagram-profile',
  }
}

interface FacebookProfileView {
  username: string
  name: string
  hd: boolean
  photoCount: number
  items: MediaItem[]
}

async function buildFacebookProfileKeyboard(
  view: FacebookProfileView,
  key: string,
  lang: Lang,
  env: Env,
  origin: string,
): Promise<InlineKeyboard> {
  const avatar = view.items[0]
  const rows: InlineButton[][] = []

  if (avatar) {
    const size = view.hd ? ' · HD' : avatar.width && avatar.height ? ` · ${avatar.width}×${avatar.height}` : ''
    rows.push([
      {
        text: t(lang, 'profileDpBtn', { size }),
        callback_data: `d|${key}|0`,
      },
    ])
  }

  if (view.photoCount) {
    rows.push([
      {
        text: t(lang, 'fbPhotosBtn', { n: view.photoCount }),
        callback_data: `a|${key}|0`,
      },
    ])
  }

  // Facebook Stories and Highlights buttons
  rows.push([
    { text: t(lang, 'profileStoryBtn'), callback_data: `fbs|${key}|0` },
    { text: t(lang, 'profileHighlightsBtn'), callback_data: `fbh|${key}|0` },
  ])

  if (avatar) {
    rows.push([
      {
        text: t(lang, 'directLink'),
        url: await signFileUrl(avatar, itemFilename(facebookProfileResultFor(view), avatar), env, origin),
      },
    ])
  }

  return { inline_keyboard: rows }
}

function facebookProfileResultFor(view: FacebookProfileView): MediaResult {
  return {
    platform: 'facebook',
    sourceUrl: `https://www.facebook.com/${view.username}`,
    title: view.name,
    author: view.name,
    items: view.items,
    engine: 'facebook-profile',
  }
}


function renderMainMenu(lang: Lang): { text: string; reply_markup: InlineKeyboard } {
  const text = lang === 'ar'
    ? `📱 <b>مرحباً بك في بوت التحميل والتسجيل السحابي المتكامل!</b>\n\n` +
      `اختر المنصة التي تريد استعراض ميزاتها وكيفية استخدامها بالتفصيل:`
    : `📱 <b>Welcome to SaveLink All-in-One Downloader & Recorder!</b>\n\n` +
      `Select a platform below to view its features and how to use it:`

  const kb: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: '📸 Instagram', callback_data: 'menu|ig' },
        { text: '🎵 TikTok & Live', callback_data: 'menu|tt' },
      ],
      [
        { text: '📘 Facebook', callback_data: 'menu|fb' },
        { text: '🔞 Coomer', callback_data: 'menu|cmr' },
      ],
      [
        { text: '🔴 Chaturbate', callback_data: 'menu|cb' },
        { text: '📁 Bunkr & Erome', callback_data: 'menu|bkr_erm' },
      ],
      [
        { text: '🗄️ أرشيف التسجيلات', callback_data: 'arch|p|0|' },
        { text: '📊 التسجيلات النشطة', callback_data: 'rec|list' },
      ],
      [
        { text: '✂️ أدوات الميديا (قص / تحويل)', callback_data: 'menu|tools' },
      ],
    ],
  }

  return { text, reply_markup: kb }
}

async function handleMenuCallback(
  tg: TelegramApi,
  query: any,
  chatId: number,
  messageId: number,
  parts: string[],
  lang: Lang,
): Promise<void> {
  const target = parts[1] || 'main'
  await answer(tg, query?.id, '')

  if (target === 'main') {
    const { text, reply_markup } = renderMainMenu(lang)
    await tg.safeEdit('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup,
    })
    return
  }

  let text = ''
  if (target === 'ig') {
    text = lang === 'ar'
      ? `📸 <b>ميزات انستغرام (Instagram):</b>\n\n` +
        `• <b>تحميل الريلز والمنشورات:</b> أرسل رابط أي بوست أو ريل لتحميله مباشرة بأعلى دقة وبدون ضغط.\n` +
        `• <b>تحميل الستوريات:</b> أرسل <code>/story @username</code> لمشاهدة وتحميل جميع ستوريات الحساب النشطة بنقرة واحدة.\n` +
        `• <b>تحميل الهايلايتس:</b> أرسل <code>/highlights @username</code> لتصفح وتنزيل كل مجلدات الهايلايتس.\n` +
        `• <b>تحميل البروفايل والصورة الشخصية HD:</b> أرسل <code>/profile @username</code> لتحميل البايو والصورة بأعلى جودة أصلية.`
      : `📸 <b>Instagram Features:</b>\n\n` +
        `• <b>Reels & Posts:</b> Send any link to download directly in highest quality.\n` +
        `• <b>Stories:</b> Use <code>/story @username</code> to browse and download active stories.\n` +
        `• <b>Highlights:</b> Use <code>/highlights @username</code> to download saved highlights.\n` +
        `• <b>HD Profile & Avatar:</b> Use <code>/profile @username</code> for full avatar and details.`
  } else if (target === 'tt') {
    text = lang === 'ar'
      ? `🎵 <b>ميزات تيك توك وبثوث اللايف (TikTok):</b>\n\n` +
        `• <b>تحميل الفيديوهات والسلايدات:</b> بدون علامة مائية وبأعلى وضوح مع خيار استخراج الصوت MP3.\n` +
        `• <b>تسجيل البث المباشر سحابياً (TikTok Live):</b> أرسل رابط البث (مثل <code>vt.tiktok.com</code>) أو اكتب <code>/record @username</code> ليبدأ التسجيل فوراً على سيرفر سحابي خارجي.\n` +
        `• <b>المراقبة التلقائية الذكية:</b> <code>/watch @username</code> – يراقب الحساب كل ${WATCH_CHECK_INTERVAL_MINUTES} دقائق في الخلفية، وفور فتح اللايف يسجله تلقائياً ويرسله لك!\n` +
        `• <b>أرشيف التسجيلات:</b> <code>/archive</code> – يعرض كل روابط البثوث المسجلة أو المتوقفة.`
      : `🎵 <b>TikTok & Live Features:</b>\n\n` +
        `• <b>Watermark-free Downloads:</b> Videos and image sliders in full original quality.\n` +
        `• <b>Audio Extraction:</b> Download audio track as MP3 with one click.\n` +
        `• <b>Cloud Live Recorder:</b> Send a live stream link or <code>/record @username</code> to record in background.\n` +
        `• <b>Auto-Record Watcher:</b> <code>/watch @username</code> to monitor and automatically record whenever creator goes live.`
  } else if (target === 'fb') {
    text = lang === 'ar'
      ? `📘 <b>ميزات فيسبوك (Facebook):</b>\n\n` +
        `• <b>الفيديوهات والريلز:</b> تحميل الفيديوهات العامة ومقاطع Watch والريلز بدقة HD و SD.\n` +
        `• <b>الستوريات والهايلايتس:</b> استخراج الستوريات المتاحة عبر إرسال رابط الستوري.\n` +
        `• <b>الصفحات والبروفايلات:</b> تحميل معلومات وألبومات الصفحات عبر <code>/profile <رابط_البروفايل></code>.`
      : `📘 <b>Facebook Features:</b>\n\n` +
        `• <b>Reels & Videos:</b> Download public Facebook videos and reels in high resolution.\n` +
        `• <b>Stories:</b> Download available stories by sending story link.\n` +
        `• <b>Profiles:</b> View and download page media with <code>/profile <url></code>.`
  } else if (target === 'cmr') {
    text = lang === 'ar'
      ? `🔞 <b>ميزات كومر (Coomer & Fansly):</b>\n\n` +
        `• <b>استخراج الوسائط:</b> أرسل رابط أي صانع محتوى على Coomer لتصفح منشوراته.\n` +
        `• <b>روابط تنزيل فائقة السرعة:</b> تجاوز بطء سيرفرات Coomer عبر شبكة سيرفرات البوت المباشرة (Cloudflare CDN).\n` +
        `• <b>تحميل الكل:</b> أزرار لتحميل كل الفيديوهات دفعة واحدة أو كملف ZIP مجمع.`
      : `🔞 <b>Coomer Features:</b>\n\n` +
        `• <b>Media Extraction:</b> Send creator page link to extract posts.\n` +
        `• <b>High-Speed CDN:</b> Bypass Coomer slow speeds through direct bot stream proxy.\n` +
        `• <b>Batch Download:</b> Download all videos directly or as a ZIP archive.`
  } else if (target === 'cb') {
    text = lang === 'ar'
      ? `🔴 <b>ميزات شاتوربيت (Chaturbate Recorder):</b>\n\n` +
        `• <b>تسجيل سحابي غير محدود:</b> بدون استهلاك باقتك أو بطارية هاتفك، التسجيل يتم على خوادم مايكروسوفت السريعة (GitHub Actions).\n` +
        `• <b>أمر التسجيل الفوري:</b> <code>/record <model></code> لبدء تسجيل البث فوراً.\n` +
        `• <b>المراقبة التلقائية (Auto-Record):</b> <code>/watch <model></code> لتسجيل الموديل تلقائياً أول ما تفتح لايف.\n` +
        `• <b>أرشيف الروابط المحفوظة:</b> <code>/archive</code> لعرض كل روابط التسجيلات حتى لو توقف البث يدوياً بـ <code>/stop</code>.\n` +
        `• <b>رفع مباشر وسريع:</b> إرسال المقطع مباشرة بالبوت (حتى 50MB) أو رابط Pixeldrain حتى 10GB + كليب معاينة 30 ثانية.`
      : `🔴 <b>Chaturbate Features:</b>\n\n` +
        `• <b>Cloud Recording:</b> Unlimited recording without using your battery or data.\n` +
        `• <b>Direct Record:</b> <code>/record <model></code> to record live stream immediately.\n` +
        `• <b>Auto-Record Watcher:</b> <code>/watch <model></code> monitors creator and records automatically.\n` +
        `• <b>Links Archive:</b> <code>/archive</code> lists every saved recording link even after manual <code>/stop</code>.\n` +
        `• <b>Fast Uploads:</b> Direct Telegram video upload (up to 50MB) + 10GB Pixeldrain link + 30s preview clip.`
  } else if (target === 'bkr_erm') {
    text = lang === 'ar'
      ? `📁 <b>ميزات بانكر وإيروم (Bunkr & Erome):</b>\n\n` +
        `• <b>البحث في البوت:</b> اكتب <code>/bunkr <بحث></code> أو <code>/erome <بحث></code> للبحث في الألبومات مباشرة.\n` +
        `• <b>تصفح الألبومات:</b> إرسال رابط أي ألبوم لاستعراض محتوياته بأزرار ترقيم وتنزيل سهل.\n` +
        `• <b>تحميل مباشر نظيف:</b> تخطي كل إعلانات النوافذ المنبثقة وسيرفرات التحويل المزعجة.`
      : `📁 <b>Bunkr & Erome Features:</b>\n\n` +
        `• <b>Search in Bot:</b> Use <code>/bunkr <query></code> or <code>/erome <query></code> to find albums.\n` +
        `• <b>Album Viewer:</b> Send any album link to paginate and download media.\n` +
        `• <b>Clean Direct Links:</b> Skip all popups and annoying redirects.`
  } else if (target === 'tools') {
    text = lang === 'ar'
      ? `✂️ <b>أدوات الميديا الإضافية (Media Tools):</b>\n\n` +
        `• <b>استخراج جميع فريمات الفيديو الحرفية:</b>\n` +
        `<code>/frame <بداية>-<نهاية> [رابط]</code>\n` +
        `مثال: <code>/frame 00:01-0:20 https://...</code>\n` +
        `أو رد على أي فيديو مرسل في الشات بـ <code>/frame 00:00-00:15</code> لاستخراج كل فريم وإرسال ألبوم معاينة + ملف ZIP كامل بكل الصور بدقتها الأصلية!\n\n` +
        `• <b>قص الفيديو السحابي:</b>\n` +
        `<code>/trim <بداية> <نهاية> [رابط]</code>\n` +
        `مثال: <code>/trim 00:01:00 00:02:30 https://...</code>\n` +
        `أو رد على أي فيديو مرسل في البوت بـ <code>/trim 00:00:10 00:01:00</code> ليتم قصه سحابياً وإرسال الجزء المحدد فوراً!\n\n` +
        `• <b>استخراج الصوت:</b> <code>/mp3 [رابط]</code> لتحويل أي فيديو لصوت.\n` +
        `• <b>قائمة المراقبة:</b> <code>/watchlist</code> لمراجعة الحسابات المسجلة بالمراقبة التلقائية، و <code>/unwatch <حساب></code> لإلغاء المراقبة.`
      : `✂️ <b>Media Tools:</b>\n\n` +
        `• <b>Literal Video Frame Extractor:</b>\n` +
        `<code>/frame <start>-<end> [url]</code>\n` +
        `Or reply to any video with <code>/frame 00:01-0:20</code> to extract all frames into ZIP + preview album.\n\n` +
        `• <b>Cloud Video Trimmer:</b>\n` +
        `<code>/trim <start> <end> [url]</code>\n` +
        `Or reply to any video with <code>/trim 00:00:10 00:01:00</code> to cut that segment.\n\n` +
        `• <b>Audio Extraction:</b> <code>/mp3 [url]</code> to convert video to audio.\n` +
        `• <b>Watch List:</b> <code>/watchlist</code> to review watched creators, and <code>/unwatch <target></code> to remove.`
  }

  const backKb: InlineKeyboard = {
    inline_keyboard: [
      [{ text: lang === 'ar' ? '🔙 رجوع للقائمة الرئيسية' : '🔙 Back to Main Menu', callback_data: 'menu|main' }],
    ],
  }

  await tg.safeEdit('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: backKb,
  })
}

// ==========================================
// GLOBAL KILL SWITCH (/stopall, /resumeall)
// ==========================================

function pauseCommandOf(text: string): string {
  const m = text.trim().match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?/)
  return (m?.[1] ?? '').toLowerCase()
}

async function handlePausedUpdate(tg: TelegramApi, update: any, env: Env): Promise<void> {
  if (update?.callback_query) {
    await tg
      .call('answerCallbackQuery', {
        callback_query_id: update.callback_query.id,
        text: '⏸ البوت متوقف مؤقتًا',
        show_alert: false,
      })
      .catch(() => {})
    return
  }
  const message = (update?.message ?? update?.channel_post) as TgMessage | undefined
  if (!message?.chat || message.from?.is_bot) return
  const command = pauseCommandOf(String(message.text ?? ''))
  if (command === 'resumeall' || command === 'startall') {
    await handleResumeAll(tg, message, env)
    return
  }
  if (command === 'stopall' || command === 'pauseall') {
    await handleStopAll(tg, message, env)
    return
  }
  if (!canControlPause(env, message.from?.id)) return
  await tg.call('sendMessage', {
    chat_id: message.chat.id,
    text: '⏸ البوت متوقف بالكامل حاليًا.\nلتشغيله مرة أخرى أرسل /resumeall',
    reply_to_message_id: message.message_id,
  })
}

async function handleStopAll(tg: TelegramApi, message: TgMessage, env: Env): Promise<void> {
  const chatId = message.chat.id
  if (!isPauseConfigured(env)) {
    await tg.call('sendMessage', {
      chat_id: chatId,
      text:
        '⛔ <b>أمر الإيقاف الكامل معطّل.</b>\n\n' +
        'لم يتم تظبيط <code>OWNER_ID</code> في إعدادات الووركر، فلا أحد يستطيع إيقاف البوت أو تشغيله — وهذا مقصود للأمان.\n' +
        'أضف رقم تيليجرام الخاص بك إلى <code>OWNER_ID</code> ثم أعد النشر.\n\n' +
        '⛔ <b>The global kill-switch is disabled.</b>\n' +
        'OWNER_ID is not configured in the Worker, so nobody can pause or resume the bot — by design. Add your Telegram user id to OWNER_ID and redeploy.',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }
  if (!canControlPause(env, message.from?.id)) return
  await setPaused(env, true, message.from?.id)
  let cancelled = 0
  try {
    cancelled = await cancelAllGitHubRuns(env)
  } catch (error) {
    console.error('stopall cancel error', errorMessage(error))
  }
  await tg.call('sendMessage', {
    chat_id: chatId,
    text:
      '⛔ <b>تم إيقاف كل شيء</b>\n\n' +
      '• البوت لن يرد على أي أمر أو رابط\n' +
      '• المراقبة التلقائية متوقفة\n' +
      '• التسجيلات الشغالة تلقت أمر الإيقاف\n' +
      `• تم إلغاء ${cancelled} عملية على GitHub Actions\n\n` +
      'لتشغيله مرة أخرى أرسل /resumeall',
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}

async function handleResumeAll(tg: TelegramApi, message: TgMessage, env: Env): Promise<void> {
  if (!isPauseConfigured(env)) {
    await tg.call('sendMessage', {
      chat_id: message.chat.id,
      text:
        '⛔ <b>أمر التشغيل الكامل معطّل.</b>\n\n' +
        'لم يتم تظبيط <code>OWNER_ID</code> في إعدادات الووركر، فلا أحد يستطيع إيقاف البوت أو تشغيله — وهذا مقصود للأمان.\n' +
        'أضف رقم تيليجرام الخاص بك إلى <code>OWNER_ID</code> ثم أعد النشر.\n\n' +
        '⛔ <b>The global kill-switch is disabled.</b>\n' +
        'OWNER_ID is not configured in the Worker, so nobody can pause or resume the bot — by design. Add your Telegram user id to OWNER_ID and redeploy.',
      parse_mode: 'HTML',
      reply_to_message_id: message.message_id,
    })
    return
  }
  if (!canControlPause(env, message.from?.id)) return
  await setPaused(env, false)
  await tg.call('sendMessage', {
    chat_id: message.chat.id,
    text: '▶️ <b>البوت رجع يشتغل</b>\nكل الأوامر والمراقبة التلقائية شغالة تاني.',
    parse_mode: 'HTML',
    reply_to_message_id: message.message_id,
  })
}
