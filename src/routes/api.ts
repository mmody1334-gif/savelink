import { Hono } from 'hono'
import { ENGINES } from '../engines'
import { getStore } from '../store'
import type { Env } from '../types'

export const apiRoute = new Hono<{ Bindings: Env }>()

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
  if (target) {
    const store = getStore(c.env)
    await store.delete(`stop:${target}`)
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
