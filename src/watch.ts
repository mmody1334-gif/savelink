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

/**
 * Watch entries must outlive the default store TTL (1h). Without this the whole
 * watchlist silently expires an hour after /watch and the cron stops seeing it.
 */
const WATCH_TTL_SECONDS = 60 * 60 * 24 * 365

/** Cron invocation budget. Workers cut waitUntil off ~30s after the response. */
const CYCLE_BUDGET_MS = 20_000
const CHECK_TIMEOUT_MS = 8_000
const MAX_PARALLEL = 6
const SESSION_LOCK_SECONDS = 7200

/**
 * How often watch targets are checked. Single source of truth: this MUST
 * match the cron trigger in wrangler.toml (every 2 minutes). The user-facing
 * messages in webhook.ts use this value — never hard-code another interval.
 */
export const WATCH_CHECK_INTERVAL_MINUTES = 2

/** Consecutive "unknown" cycles before a cloud watcher is dispatched. */
export const WATCH_UNKNOWN_STREAK_TO_DISPATCH = 3

/** How long an unknown streak is remembered. */
const UNKNOWN_STREAK_TTL_SECONDS = 60 * 60 * 24

export function watchUnknownStreakKey(platform: string, identifier: string): string {
  return `watch:unknown:${platform.toLowerCase()}:${identifier.toLowerCase().replace(/^@/, '')}`
}

export function watchLockKey(platform: string, identifier: string): string {
  return `watch:lock:${platform.toLowerCase()}:${identifier.toLowerCase().replace(/^@/, '')}`
}

export async function clearWatchLock(store: Store, platform: string, identifier: string): Promise<void> {
  await store.delete(watchLockKey(platform, identifier))
}

export async function clearAllWatchLocksForTarget(store: Store, target: string): Promise<void> {
  const clean = target.toLowerCase().trim().replace(/^@/, '')
  await Promise.all([
    store.delete(`watch:lock:chaturbate:${clean}`),
    store.delete(`watch:lock:stripchat:${clean}`),
    store.delete(`watch:lock:tiktok:${clean}`),
  ])
}

export type LiveState = 'live' | 'offline' | 'unknown'

export interface LiveCheck {
  state: LiveState
  /** machine-readable reason, e.g. 'public', 'private', 'http_404', 'not_json' */
  detail: string
  hls?: string
  viewers?: number
  /** true only when a public stream URL exists, i.e. the recorder can pull it */
  recordable?: boolean
}

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
  const cb =
    clean.match(/chaturbate\.com\/(?:b\/)?([a-zA-Z0-9_.-]+)/i) ||
    clean.match(/^(?:cb|chaturbate)[:_]([a-zA-Z0-9_.-]+)$/i) ||
    clean.match(/^([a-zA-Z0-9_.-]{3,60})$/)
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
  await store.put(userKey, JSON.stringify(userList), WATCH_TTL_SECONDS)

  // 2. Global index
  const indexRaw = await store.get(WATCH_INDEX_KEY)
  const globalList: WatchTarget[] = (indexRaw ? JSON.parse(indexRaw) : []).filter(
    (t: WatchTarget) => !(String(t.chatId) === String(chatId) && t.identifier === target.identifier && t.platform === target.platform),
  )
  globalList.push(target)
  await store.put(WATCH_INDEX_KEY, JSON.stringify(globalList), WATCH_TTL_SECONDS)

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
  await store.put(userKey, JSON.stringify(filtered), WATCH_TTL_SECONDS)

  // Update global index
  const indexRaw = await store.get(WATCH_INDEX_KEY)
  if (indexRaw) {
    const globalList: WatchTarget[] = JSON.parse(indexRaw)
    const newGlobal = globalList.filter(
      (t) => !(String(t.chatId) === String(chatId) && (t.identifier.toLowerCase() === targetStr || t.target.toLowerCase() === targetStr)),
    )
    await store.put(WATCH_INDEX_KEY, JSON.stringify(newGlobal), WATCH_TTL_SECONDS)
  }

  // Clear locks for this target so future watches or recordings start fresh
  if (parsed) {
    await clearWatchLock(store, parsed.platform, parsed.identifier)
  } else {
    await clearAllWatchLocksForTarget(store, targetStr)
  }

  return { ok: true, count: removed }
}

export async function listUserWatchTargets(chatId: number | string, store: Store): Promise<WatchTarget[]> {
  const userKey = `watch:user:${chatId}`
  const userListRaw = await store.get(userKey)
  return userListRaw ? JSON.parse(userListRaw) : []
}

/** Chaturbate statuses where the room is on air (public is the only recordable one). */
const CB_ON_AIR = new Set(['public', 'private', 'group', 'hidden', 'away', 'password protected'])

/**
 * Tri-state live check. 'unknown' means the platform could not be read
 * (404, non-JSON, blocked, timeout) and must never be treated as offline.
 */
export async function checkTargetLive(target: WatchTarget): Promise<LiveCheck> {
  const id = target.identifier.replace(/^@/, '').toLowerCase()

  if (target.platform === 'chaturbate') {
    const desktopUa =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    let diag = ''

    // Method 1: chatvideocontext API
    try {
      const res = await fetch(`https://chaturbate.com/api/chatvideocontext/${encodeURIComponent(id)}/`, {
        headers: {
          'User-Agent': desktopUa,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      if (res.status === 404) return { state: 'unknown', detail: 'no_such_room' }
      if (res.ok) {
        const ct = res.headers.get('content-type') || ''
        if (ct.includes('json')) {
          const data: any = await res.json()
          const status = String(data?.room_status ?? '').toLowerCase()
          const hls = typeof data?.hls_source === 'string' ? data.hls_source : ''
          const viewers = typeof data?.num_viewers === 'number' ? data.num_viewers : undefined

          if (status) {
            const onAir = CB_ON_AIR.has(status) || Boolean(hls)
            return {
              state: onAir ? 'live' : 'offline',
              detail: status,
              hls: hls || undefined,
              viewers,
              recordable: Boolean(hls) && status === 'public',
            }
          }
        } else {
          diag += `m1_ct:${ct.slice(0, 30)};`
        }
      } else {
        diag += `m1_http:${res.status};`
      }
    } catch (e1: any) {
      diag += `m1_err:${e1?.name || e1?.message};`
    }

    // Method 2: get_edge_hls_url_ajax POST endpoint
    try {
      const res2 = await fetch(`https://chaturbate.com/get_edge_hls_url_ajax/`, {
        method: 'POST',
        headers: {
          'User-Agent': desktopUa,
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://chaturbate.com',
          Referer: `https://chaturbate.com/${encodeURIComponent(id)}/`,
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body: `room_slug=${encodeURIComponent(id)}`,
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      if (res2.ok) {
        const ct2 = res2.headers.get('content-type') || ''
        if (ct2.includes('json')) {
          const data2: any = await res2.json()
          const status2 = String(data2?.room_status ?? '').toLowerCase()
          const url2 = typeof data2?.url === 'string' ? data2.url : ''
          if (status2) {
            const onAir2 = CB_ON_AIR.has(status2) || Boolean(url2)
            return {
              state: onAir2 ? 'live' : 'offline',
              detail: status2,
              hls: url2 || undefined,
              recordable: Boolean(url2) && (status2 === 'public' || status2 === ''),
            }
          }
        } else {
          diag += `m2_ct:${ct2.slice(0, 30)};`
        }
      } else {
        diag += `m2_http:${res2.status};`
      }
    } catch (e2: any) {
      diag += `m2_err:${e2?.name || e2?.message};`
    }

    return { state: 'unknown', detail: diag || 'chaturbate_unreachable' }
  }

  if (target.platform === 'stripchat') {
    try {
      const res = await fetch(`https://stripchat.com/api/front/v2/users/username/${encodeURIComponent(id)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      if (res.status === 404) return { state: 'unknown', detail: 'no_such_room' }
      if (!res.ok) return { state: 'unknown', detail: `http_${res.status}` }
      const data: any = await res.json()
      const u = data?.user
      if (!u) return { state: 'unknown', detail: 'no_user' }
      const status = String(u.status ?? '').toLowerCase()
      const onAir = Boolean(u.isLive) && ['public', 'private', 'group', 'p2p'].includes(status)
      return {
        state: onAir ? 'live' : 'offline',
        detail: status || (u.isLive ? 'live' : 'offline'),
        recordable: Boolean(u.isLive) && status === 'public',
      }
    } catch (e) {
      return { state: 'unknown', detail: `error:${(e as Error).name}` }
    }
  }

  if (target.platform === 'tiktok') {
    try {
      const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(id)}/live`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      if (!res.ok) return { state: 'unknown', detail: `http_${res.status}` }
      const html = await res.text()
      if (!html.includes('__UNIVERSAL_DATA_FOR_REHYDRATION__') && !html.includes('roomId')) {
        return { state: 'unknown', detail: 'no_page_data' }
      }
      const live = html.includes('"status":2') || (html.includes('"liveRoom"') && !html.includes('"status":4'))
      return { state: live ? 'live' : 'offline', detail: live ? 'live' : 'offline', recordable: live }
    } catch (e) {
      return { state: 'unknown', detail: `error:${(e as Error).name}` }
    }
  }

  return { state: 'unknown', detail: 'unsupported_platform' }
}

/** Boolean wrapper kept for backward compatibility. */
export async function checkTargetIsLive(target: WatchTarget): Promise<boolean> {
  return (await checkTargetLive(target)).state === 'live'
}

function platformLabel(platform: WatchTarget['platform']): string {
  if (platform === 'tiktok') return 'TikTok Live'
  if (platform === 'stripchat') return 'Stripchat'
  return 'Chaturbate'
}

function recorderTargetParam(t: WatchTarget): string {
  if (t.platform === 'tiktok') return `@${t.identifier}`
  if (t.platform === 'stripchat') return `https://stripchat.com/${t.identifier}`
  return t.identifier
}

async function dispatchRecorder(env: Env, t: WatchTarget, watchMode = '1'): Promise<{ ok: boolean; status: number; body: string }> {
  const repo = env.GITHUB_RECORDER_REPO || 'mmody1334-gif/cb-recorder'
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/record.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'SaveLink-Telegram-Bot',
      'Content-Type': 'application/json',
    },
    // NOTE: the bot token is NOT sent here. Workflow inputs are visible in
    // the Actions UI of the public repo; the runner reads BOT_TOKEN from a
    // GitHub secret instead (see .github/workflows/record.yml).
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        model: recorderTargetParam(t),
        chat_id: String(t.chatId),
        watch_mode: watchMode,
      },
    }),
  })
  const body = res.status === 204 ? '' : await res.text().catch(() => '')
  return { ok: res.status === 204 || res.ok, status: res.status, body: body.slice(0, 300) }
}

export async function triggerWatchTargetIfLive(
  env: Env,
  store: Store,
  t: WatchTarget,
): Promise<{ live: boolean; triggered: boolean; detail: string }> {
  if (!env.GITHUB_TOKEN) return { live: false, triggered: false, detail: 'no_github_token' }

  const lockKey = watchLockKey(t.platform, t.identifier)
  if (await store.get(lockKey)) {
    return { live: true, triggered: false, detail: 'already_recording' }
  }

  const check = await checkTargetLive(t)
  if (check.state === 'live') {
    const dispatch = await dispatchRecorder(env, t, '1')
    if (dispatch.ok) {
      await store.put(lockKey, String(Date.now()), SESSION_LOCK_SECONDS)
      return { live: true, triggered: true, detail: check.detail }
    }
    return { live: true, triggered: false, detail: `dispatch_failed_${dispatch.status}` }
  }

  if (check.state === 'offline') {
    // Offline is normal: the cron re-checks every WATCH_CHECK_INTERVAL_MINUTES
    // and dispatches when the target goes live. Spawning a 6-hour
    // cloud-watcher runner for every offline target would burn GitHub
    // Actions minutes for nothing.
    return { live: false, triggered: false, detail: check.detail || 'offline' }
  }

  // Unknown: the Worker cannot read this platform at all (e.g. Chaturbate
  // answers 403 to Cloudflare IPs), so the cloud watcher is the only way
  // to know when it goes live.
  const dispatch = await dispatchRecorder(env, t, '1')
  if (dispatch.ok) {
    await store.put(lockKey, String(Date.now()), SESSION_LOCK_SECONDS)
    return { live: false, triggered: true, detail: check.detail || 'cloud_watcher_dispatched' }
  }

  return { live: false, triggered: false, detail: `dispatch_failed_${dispatch.status}` }
}

export async function runWatchCycle(env: Env, store: Store): Promise<{ checked: number; triggered: number; unknown: number }> {
  const started = Date.now()

  if (!env.GITHUB_TOKEN) {
    console.error('[watch] GITHUB_TOKEN is not set — auto-record cannot dispatch. Add it with: wrangler secret put GITHUB_TOKEN')
    return { checked: 0, triggered: 0, unknown: 0 }
  }

  const indexRaw = await store.get(WATCH_INDEX_KEY)
  if (!indexRaw) {
    console.log('[watch] watchlist key missing/expired — nothing to check')
    return { checked: 0, triggered: 0, unknown: 0 }
  }

  let targets: WatchTarget[] = []
  try {
    targets = JSON.parse(indexRaw)
  } catch {
    console.error('[watch] watchlist is corrupt JSON, resetting')
    await store.delete(WATCH_INDEX_KEY)
    return { checked: 0, triggered: 0, unknown: 0 }
  }
  if (!targets.length) return { checked: 0, triggered: 0, unknown: 0 }

  console.log(`[watch] cycle start: ${targets.length} target(s)`)

  let triggered = 0
  let unknown = 0
  let checked = 0

  for (let i = 0; i < targets.length; i += MAX_PARALLEL) {
    if (Date.now() - started > CYCLE_BUDGET_MS) {
      console.warn(`[watch] budget exhausted after ${checked}/${targets.length} targets — remaining run next cycle`)
      break
    }

    const batch = targets.slice(i, i + MAX_PARALLEL)
    const results = await Promise.all(
      batch.map(async (t) => ({ t, check: await checkTargetLive(t) })),
    )

    for (const { t, check } of results) {
      checked++
      console.log(
        `[watch] ${t.platform}/${t.identifier} -> ${check.state} (${check.detail})` +
          (check.viewers !== undefined ? ` viewers=${check.viewers}` : '') +
          (check.recordable ? ' recordable=yes' : ''),
      )

      if (check.state === 'unknown') {
        unknown++
        // A name that does not exist must never spawn a runner. TikTok reports
        // it as http_404, Chaturbate/Stripchat as no_such_room.
        if (check.detail === 'no_such_room' || check.detail === 'http_404') {
          const lockKey = watchLockKey(t.platform, t.identifier)
          if (await store.get(lockKey)) {
            await store.delete(lockKey)
            console.log(`[watch] ${t.platform}/${t.identifier} room not found - cleared lock`)
          }
          await store.delete(watchUnknownStreakKey(t.platform, t.identifier))
          continue
        }

        // "Unknown" also covers one-off network blips. Only a persistent
        // unknown earns a cloud-watcher runner: the streak must reach
        // WATCH_UNKNOWN_STREAK_TO_DISPATCH consecutive cycles, and the 2h
        // session lock still caps it at one runner per target per 2h. The
        // runner itself runs curl_cffi with full browser TLS impersonation,
        // which is what gets past the Chaturbate/Stripchat edge WAF (403)
        // that blocks the Worker.
        const streak = await store.incr(
          watchUnknownStreakKey(t.platform, t.identifier),
          UNKNOWN_STREAK_TTL_SECONDS,
        )
        if (streak < WATCH_UNKNOWN_STREAK_TO_DISPATCH) continue

        await store.delete(watchUnknownStreakKey(t.platform, t.identifier))
        const lockKey = watchLockKey(t.platform, t.identifier)
        if (await store.get(lockKey)) {
          continue
        }
        try {
          const dispatch = await dispatchRecorder(env, t, '1')
          if (dispatch.ok) {
            await store.put(lockKey, String(Date.now()), SESSION_LOCK_SECONDS)
            triggered++
            console.log(`[watch] dispatched cloud watcher for ${t.platform}/${t.identifier} (unknown x${streak})`)
          }
        } catch (e) {
          console.error(`[watch] cloud watcher dispatch error:`, e)
        }
        continue
      }
      if (check.state === 'offline') {
        await store.delete(watchUnknownStreakKey(t.platform, t.identifier))
        const lockKey = watchLockKey(t.platform, t.identifier)
        if (await store.get(lockKey)) {
          await store.delete(lockKey)
          console.log(`[watch] ${t.platform}/${t.identifier} is offline - auto-cleared lock`)
        }
        continue
      }

      await store.delete(watchUnknownStreakKey(t.platform, t.identifier))
      const lockKey = watchLockKey(t.platform, t.identifier)
      if (await store.get(lockKey)) continue

      try {
        const dispatch = await dispatchRecorder(env, t)
        if (!dispatch.ok) {
          console.error(`[watch] dispatch failed for ${t.identifier}: HTTP ${dispatch.status} ${dispatch.body}`)
          continue
        }

        // Lock only after a confirmed dispatch, so a failure is retried next cycle.
        await store.put(lockKey, String(Date.now()), SESSION_LOCK_SECONDS)
        triggered++

        if (env.BOT_TOKEN) {
          const tg = new TelegramApi(env.BOT_TOKEN)
          const alertMsg =
            `🔔 <b>بدأ البث المباشر الآن!</b>\n\n` +
            `👤 <b>الحساب:</b> <code>${t.target}</code> (${platformLabel(t.platform)})\n` +
            `🎥 تم تشغيل المسجل السحابي آلياً في الخلفية (Auto-Record).\n` +
            (check.recordable === false
              ? `⚠️ الحالة الآن: <b>${check.detail}</b> — ليس بثاً عاماً، التسجيل سيبدأ تلقائياً عند العودة للبث العام.\n`
              : '') +
            `📦 سيتم رفع الفيديو فوراً وإرساله لك عند انتهاء البث.`
          await tg.call('sendMessage', { chat_id: t.chatId, text: alertMsg, parse_mode: 'HTML' }).catch((e: unknown) => {
            console.error('[watch] telegram alert failed', e)
          })
        }
      } catch (e) {
        console.error('[watch] dispatch error for', t.target, e)
      }
    }
  }

  console.log(`[watch] cycle done: checked=${checked} triggered=${triggered} unknown=${unknown} in ${Date.now() - started}ms`)
  return { checked, triggered, unknown }
}
