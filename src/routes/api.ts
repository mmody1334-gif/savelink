import { Hono, type Context } from 'hono'
import { ENGINES } from '../engines'
import { getStore } from '../store'
import type { Env } from '../types'
import { isPaused } from '../pause'
import {
  parseWatchTarget,
  checkTargetLive,
  watchLockKey,
  clearWatchLock,
  clearAllWatchLocksForTarget,
  runWatchCycle,
  type WatchTarget,
} from '../watch'

export const apiRoute = new Hono<{ Bindings: Env }>()

/**
 * The watch endpoints expose the full watchlist (targets + chat ids) and can
 * trigger GitHub Actions runners, so they are not public. They accept the same
 * shared secret as the Telegram webhook (WEBHOOK_SECRET) via the
 * `x-telegram-bot-api-secret-token` header or `Authorization: Bearer <secret>`.
 * Fail closed: without a configured secret, every call is refused.
 */
export function watchAuthOk(c: Context<{ Bindings: Env }>): boolean {
  const secret = (c.env.WEBHOOK_SECRET || '').trim()
  if (!secret) return false
  const header = c.req.header('x-telegram-bot-api-secret-token') || ''
  const bearer = c.req.header('authorization') || ''
  return header === secret || bearer === `Bearer ${secret}`
}

function requireWatchAuth(c: Context<{ Bindings: Env }>): Response | null {
  return watchAuthOk(c) ? null : c.json({ ok: false, error: 'unauthorized' }, 401)
}

// Global kill switch: while paused, every API route is refused except health,
// and recorders polling /record/signal are told to stop.
apiRoute.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  if (path.endsWith('/health')) return next()
  if (!(await isPaused(c.env))) return next()
  if (path.endsWith('/record/signal')) return c.json({ stop: true, paused: true })
  return c.json({ ok: false, error: 'paused' }, 503)
})

apiRoute.get('/health', (c) => {
  const engines = Object.values(ENGINES)
    .filter((engine) => engine.available(c.env))
    .map((engine) => engine.name)

  return c.json({
    ok: true,
    service: 'savelink',
    bot: Boolean(c.env.BOT_TOKEN),
    store: c.env.CACHE ? 'kv' : 'memory',
    engines,
  })
})

apiRoute.get('/record/signal', async (c) => {
  const target = (c.req.query('target') || '').toLowerCase().trim().replace(/^@/, '')
  if (!target) return c.json({ stop: false })
  const store = getStore(c.env)
  const stopped = await store.get(`stop:${target}`)
  return c.json({ stop: Boolean(stopped) })
})

apiRoute.get('/record/signal/clear', async (c) => {
  const target = (c.req.query('target') || '').toLowerCase().trim().replace(/^@/, '')
  const platform = (c.req.query('platform') || '').toLowerCase().trim()
  if (target) {
    const store = getStore(c.env)
    await store.delete(`stop:${target}`)
    if (platform) {
      await clearWatchLock(store, platform, target)
    } else {
      await clearAllWatchLocksForTarget(store, target)
    }
  }
  return c.json({ ok: true })
})

apiRoute.post('/record/stop', async (c) => {
  const body: any = await c.req.json().catch(() => ({}))
  const target = (body.target || body.url || c.req.query('target') || '').toLowerCase().trim().replace(/^@/, '')
  if (!target) return c.json({ ok: false, error: 'Target required' }, 400)
  const store = getStore(c.env)
  await store.put(`stop:${target}`, '1', 3600)
  return c.json({ ok: true, message: 'Stop signal sent' })
})

apiRoute.get('/watch/check', async (c) => {
  const denied = requireWatchAuth(c)
  if (denied) return denied
  const raw = c.req.query('target') || c.req.query('model') || ''
  const plat = c.req.query('platform') || ''
  if (!raw) return c.json({ ok: false, error: 'Target query param required' }, 400)

  const parsed = parseWatchTarget(raw)
  const platform = (plat || parsed?.platform || 'chaturbate') as any
  const identifier = parsed?.identifier || raw.toLowerCase().trim().replace(/^@/, '')

  const target: WatchTarget = {
    chatId: 0,
    target: raw,
    platform,
    identifier,
    addedAt: 0,
  }

  const store = getStore(c.env)
  const check = await checkTargetLive(target)
  const lockKey = watchLockKey(platform, identifier)
  const locked = Boolean(await store.get(lockKey))

  return c.json({
    ok: true,
    platform,
    identifier,
    state: check.state,
    detail: check.detail,
    recordable: check.recordable ?? false,
    viewers: check.viewers,
    hls: check.hls,
    locked,
  })
})

apiRoute.get('/watch/status', async (c) => {
  const denied = requireWatchAuth(c)
  if (denied) return denied
  const store = getStore(c.env)
  const indexRaw = await store.get('watch:index:all')
  const targets: WatchTarget[] = indexRaw ? JSON.parse(indexRaw) : []
  const enriched = await Promise.all(
    targets.map(async (t) => {
      const lockKey = watchLockKey(t.platform, t.identifier)
      const lockVal = await store.get(lockKey)
      return {
        ...t,
        locked: Boolean(lockVal),
        lockTime: lockVal ? Number(lockVal) : null,
      }
    }),
  )
  return c.json({ ok: true, count: enriched.length, targets: enriched })
})

apiRoute.all('/watch/cycle', async (c) => {
  const denied = requireWatchAuth(c)
  if (denied) return denied
  const store = getStore(c.env)
  const result = await runWatchCycle(c.env, store)
  return c.json({ ok: true, cycle: result })
})
