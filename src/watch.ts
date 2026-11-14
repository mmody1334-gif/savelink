import type { Env } from './types'
import type { Store } from './store'
import { TelegramApi } from './telegram/api'

export interface WatchTarget {
  chatId: number | string
  target: string // '@username' (tiktok) or 'model' (chaturbate) or 'https://stripchat.com/model' (stripchat)
  platform: 'tiktok' | 'chaturbate' | 'stripchat'
  identifier: string
  addedAt: number
}

const WATCH_INDEX_KEY = 'watch:index:all'

export function parseWatchTarget(input: string): { platform: 'tiktok' | 'chaturbate' | 'stripchat'; identifier: string; clean: string } | null {
  const clean = input.trim()
  if (!clean) return null

  // Stripchat
  const sc = clean.match(/stripchat\.(?:com|org|me|cc)\/(?:[a-z]{2}\/)?([a-zA-Z0-9_.-]+)/i) || clean.match(/^stripchat_([a-zA-Z0-9_.-]+)$/i)
  if (sc) {
    const id = sc[1].toLowerCase().replace(/\/(?:videos?|vod|clips?|archive)\/?$/i, '')
    return { platform: 'stripchat', identifier: id, clean: `https://stripchat.com/${id}` }
  }

  // TikTok
  if (clean.includes('tiktok.com') || clean.startsWith('@')) {
    const m = clean.match(/@([a-zA-Z0-9_.-]+)/)
    const id = m ? m[1] : clean.replace(/^@/, '')
    return { platform: 'tiktok', identifier: id, clean: `@${id}` }
  }

  // Chaturbate
  const cb = clean.match(/chaturbate\.com\/(?:b\/)?([a-zA-Z0-9_.-]+)/i) || clean.match(/^([a-zA-Z0-9_.-]{3,60})$/)
  if (cb) {
    const id = cb[1].toLowerCase()
    return { platform: 'chaturbate', identifier: id, clean: id }
  }

  return null
}

export async function addWatchTarget(
  chatId: number | string,
  rawTarget: string,
  store: Store,
): Promise<{ ok: boolean; target?: WatchTarget; error?: string }> {
  const parsed = parseWatchTarget(rawTarget)
  if (!parsed) {
    return { ok: false, error: 'invalid_target' }
  }

  const target: WatchTarget = {
    chatId,
    target: parsed.clean,
    platform: parsed.platform,
    identifier: parsed.identifier,
    addedAt: Date.now(),
  }

  // 1. User watch list
  const userKey = `watch:user:${chatId}`
  const userListRaw = await store.get(userKey)
  const userList: WatchTarget[] = userListRaw ? JSON.parse(userListRaw) : []

  if (userList.some((t) => t.identifier.toLowerCase() === parsed.identifier.toLowerCase() && t.platform === parsed.platform)) {
    return { ok: false, error: 'already_watched', target }
  }

  userList.push(target)
  await store.put(userKey, JSON.stringify(userList))

  // 2. Global index
  const indexRaw = await store.get(WATCH_INDEX_KEY)
  const globalList: WatchTarget[] = indexRaw ? JSON.parse(indexRaw) : []
  globalList.push(target)
  await store.put(WATCH_INDEX_KEY, JSON.stringify(globalList))

  return { ok: true, target }
}

export async function removeWatchTarget(
  chatId: number | string,
  rawTarget: string,
  store: Store,
): Promise<{ ok: boolean; count: number }> {
  const parsed = parseWatchTarget(rawTarget)
  const targetStr = parsed ? parsed.identifier.toLowerCase() : rawTarget.trim().toLowerCase().replace(/^@/, '')

  const userKey = `watch:user:${chatId}`
  const userListRaw = await store.get(userKey)
  const userList: WatchTarget[] = userListRaw ? JSON.parse(userListRaw) : []

  const beforeLen = userList.length
  const filtered = userList.filter(
    (t) => t.identifier.toLowerCase() !== targetStr && t.target.toLowerCase() !== targetStr,
  )
  const removed = beforeLen - filtered.length
  await store.put(userKey, JSON.stringify(filtered))

  // Update global index
  const indexRaw = await store.get(WATCH_INDEX_KEY)
  if (indexRaw) {
    const globalList: WatchTarget[] = JSON.parse(indexRaw)
    const newGlobal = globalList.filter(
      (t) => !(String(t.chatId) === String(chatId) && (t.identifier.toLowerCase() === targetStr || t.target.toLowerCase() === targetStr)),
    )
    await store.put(WATCH_INDEX_KEY, JSON.stringify(newGlobal))
  }

  return { ok: true, count: removed }
}

export async function listUserWatchTargets(chatId: number | string, store: Store): Promise<WatchTarget[]> {
  const userKey = `watch:user:${chatId}`
  const userListRaw = await store.get(userKey)
  return userListRaw ? JSON.parse(userListRaw) : []
}

export async function checkTargetIsLive(target: WatchTarget): Promise<boolean> {
  if (target.platform === 'tiktok') {
    try {
      const cleanUser = target.identifier.replace(/^@/, '')
      const res = await fetch(`https://www.tiktok.com/@${cleanUser}/live`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(8000),
      })
      const html = await res.text()
      return html.includes('"status":2') || (html.includes('"liveRoom":') && !html.includes('"status":4'))
    } catch {
      return false
    }
  }

  if (target.platform === 'stripchat') {
    try {
      const res = await fetch(`https://stripchat.com/api/front/v2/users/username/${target.identifier}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return false
      const data: any = await res.json()
      const u = data.user
      return !!(u && u.isLive && u.status === 'public')
    } catch {
      return false
    }
  }

  if (target.platform === 'chaturbate') {
    try {
      const res = await fetch(`https://chaturbate.com/api/chatvideocontext/${target.identifier}/`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) return false
      const data: any = await res.json()
      return data.room_status === 'public'
    } catch {
      return false
    }
  }

  return false
}

export async function runWatchCycle(env: Env, store: Store): Promise<{ checked: number; triggered: number }> {
  const token = env.GITHUB_TOKEN
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'
  if (!token) return { checked: 0, triggered: 0 }

  const indexRaw = await store.get(WATCH_INDEX_KEY)
  if (!indexRaw) return { checked: 0, triggered: 0 }

  const targets: WatchTarget[] = JSON.parse(indexRaw)
  if (!targets.length) return { checked: 0, triggered: 0 }

  let triggered = 0
  const now = Date.now()

  for (const t of targets) {
    // Prevent re-triggering for the same live session within 2 hours
    const activeLockKey = `watch:lock:${t.platform}:${t.identifier}`
    const isLocked = await store.get(activeLockKey)
    if (isLocked) continue

    const isLive = await checkTargetIsLive(t)
    if (isLive) {
      // Set lock for 2 hours (7200 seconds)
      await store.put(activeLockKey, String(now), 7200)

      // Trigger cloud recorder
      const targetParam = t.platform === 'tiktok' ? `@${t.identifier}` : (t.platform === 'stripchat' ? `https://stripchat.com/${t.identifier}` : t.identifier)
      try {
        const url = `https://api.github.com/repos/${repo}/actions/workflows/record.yml/dispatches`
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'SaveLink-Telegram-Bot',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: {
              model: targetParam,
              chat_id: String(t.chatId),
              bot_token: env.BOT_TOKEN || '',
            },
          }),
        })

        if (res.status === 204 || res.ok) {
          triggered++
          // Notify user
          if (env.BOT_TOKEN) {
            const tg = new TelegramApi(env.BOT_TOKEN)
            const plat = t.platform === 'tiktok' ? 'TikTok Live' : 'Chaturbate'
            const alertMsg =
              `🔔 <b>بدأ البث المباشر الآن!</b>\n\n` +
              `👤 <b>الحساب:</b> <code>${t.target}</code> (${plat})\n` +
              `🎥 تم تشغيل المسجل السحابي آلياً في الخلفية (Auto-Record).\n` +
              `📦 سيتم رفع الفيديو فوراً وإرساله لك عند انتهاء البث.`
            await tg.call('sendMessage', {
              chat_id: t.chatId,
              text: alertMsg,
              parse_mode: 'HTML',
            })
          }
        }
      } catch (e) {
        console.error('Failed to trigger watch recorder for', t.target, e)
      }
    }
  }

  return { checked: targets.length, triggered }
}
