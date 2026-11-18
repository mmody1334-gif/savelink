import { Hono } from 'hono'
import { apiRoute } from './routes/api'
import { archivePageRoute } from './routes/archive-page'
import { fileRoute } from './routes/file'
import { telegramWebhook } from './telegram/webhook'
import { getStore } from './store'
import { runWatchCycle } from './watch'
import { isPaused, isRecorderPaused } from './pause'
import type { Env } from './types'

const app = new Hono<{ Bindings: Env }>()

app.route('/api', apiRoute)
app.route('/api', fileRoute)
app.route('/archive', archivePageRoute)

app.post('/telegram/webhook/:secret', telegramWebhook)
app.get('/telegram/webhook/:secret', (c) => c.text('ok'))

app.get('/', (c) =>
  c.text(
    'SaveLink is running.\n\n' +
      'Telegram webhook: POST /telegram/webhook/<WEBHOOK_SECRET>\n' +
      'Health: /api/health\n' +
      'Run `npm run tg:setup` to register the webhook.',
  ),
)

app.notFound((c) => c.json({ ok: false, error: 'not_found' }, 404))
app.onError((error, c) => {
  console.error('unhandled error', error)
  return c.json({ ok: false, error: 'internal_error' }, 500)
})

export default {
  fetch: app.fetch,
  async scheduled(_event: any, env: Env, ctx: any) {
    if ((await isPaused(env)) || (await isRecorderPaused(env))) return
    const store = getStore(env)
    ctx.waitUntil(runWatchCycle(env, store))
  },
}
