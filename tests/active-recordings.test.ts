import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import {
  ACTIVE_REC_INDEX_KEY,
  clearAllActiveRecordings,
  listActiveRecordings,
  markRecordingStarted,
} from '../src/active-recordings'
import { setRecorderPaused } from '../src/pause'
import { apiRoute } from '../src/routes/api'
import { sha256Hex } from '../src/sign'
import { getStore } from '../src/store'
import type { Env } from '../src/types'
import { clearAllWatchLocksForTarget, watchLockKey } from '../src/watch'

const BOT_TOKEN = '999:test-bot-token'
const WEBHOOK_SECRET = 'test-webhook-secret'
const OWNER = '736161596'

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    BOT_TOKEN,
    WEBHOOK_SECRET,
    OWNER_ID: OWNER,
    GITHUB_TOKEN: 'gh-test',
    ...extra,
  }
}

async function sendWebhookUpdate(update: Record<string, unknown>, env: Env) {
  const req = new Request(`https://savelink.example.workers.dev/telegram/webhook/${WEBHOOK_SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  return await worker.fetch(req, env, { waitUntil: () => {} } as any)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const store = getStore({} as Env)
  await clearAllActiveRecordings(store)
  await clearAllWatchLocksForTarget(store, 'momgoeswild')
  await store.delete('stop:momgoeswild')
  await setRecorderPaused({} as Env, false)
})

describe('active recordings tracking, duplicate lock & /status', () => {
  it('blocks duplicate /record for an active model and allows /record force', async () => {
    const dispatches: any[] = []
    const tgCalls: Array<{ method: string; body: any }> = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('chatvideocontext')) {
          return new Response(
            JSON.stringify({ room_status: 'public', hls_source: 'https://edge.example.com/live.m3u8' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/actions/workflows/record.yml/runs')) {
          return new Response(
            JSON.stringify({ workflow_runs: [{ id: 501, status: 'in_progress' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/dispatches')) {
          dispatches.push(init?.body ? JSON.parse(String(init.body)) : {})
          return new Response(null, { status: 204 })
        }
        if (url.includes('api.telegram.org')) {
          const method = url.split('/').pop() || ''
          tgCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} })
          return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const env = makeEnv()

    await sendWebhookUpdate(
      {
        update_id: 601,
        message: {
          message_id: 1,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record momgoeswild',
        },
      },
      env,
    )
    expect(dispatches).toHaveLength(1)

    await sendWebhookUpdate(
      {
        update_id: 602,
        message: {
          message_id: 2,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record momgoeswild',
        },
      },
      env,
    )
    expect(dispatches).toHaveLength(1)

    const dupMsg = tgCalls.find((c) => c.method === 'sendMessage' && String(c.body.text).includes('قيد التسجيل بالفعل'))
    expect(dupMsg).toBeDefined()
    const markupStr = JSON.stringify(dupMsg?.body.reply_markup)
    expect(markupStr).toContain('rec|stop|momgoeswild')
    expect(markupStr).toContain('rec|list')
    expect(markupStr).toContain('rec|force|momgoeswild')

    await sendWebhookUpdate(
      {
        update_id: 603,
        message: {
          message_id: 3,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record force momgoeswild',
        },
      },
      env,
    )
    expect(dispatches).toHaveLength(2)

    await sendWebhookUpdate(
      {
        update_id: 6031,
        callback_query: {
          id: 'cb-force-1',
          from: { id: 736161596, language_code: 'ar' },
          message: { message_id: 77, chat: { id: 736161596, type: 'private' } },
          data: 'rec|force|momgoeswild',
        },
      },
      env,
    )
    expect(dispatches).toHaveLength(3)
  })

  it('auto-heals stale locks older than 90s when GitHub reports zero active or queued runs', async () => {
    const dispatches: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('chatvideocontext')) {
          return new Response(
            JSON.stringify({ room_status: 'public', hls_source: 'https://edge.example.com/live.m3u8' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/actions/workflows/record.yml/runs')) {
          return new Response(JSON.stringify({ workflow_runs: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url.includes('/dispatches')) {
          dispatches.push(init?.body ? JSON.parse(String(init.body)) : {})
          return new Response(null, { status: 204 })
        }
        if (url.includes('api.telegram.org')) {
          return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const env = makeEnv()
    const store = getStore(env)
    await markRecordingStarted(store, {
      platform: 'chaturbate',
      model: 'momgoeswild',
      target: 'momgoeswild',
      chatId: 736161596,
      source: 'manual',
      startedAt: Date.now() - 120_000,
    })

    await sendWebhookUpdate(
      {
        update_id: 604,
        message: {
          message_id: 4,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record momgoeswild',
        },
      },
      env,
    )
    expect(dispatches).toHaveLength(1)
  })

  it('lists active recordings with /status, /active, and rec|list callback', async () => {
    const tgCalls: Array<{ method: string; body: any }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/actions/workflows/record.yml/runs')) {
          return new Response(
            JSON.stringify({ workflow_runs: [{ id: 505, status: 'in_progress' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('api.telegram.org')) {
          const method = url.split('/').pop() || ''
          tgCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} })
          return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const env = makeEnv()
    const store = getStore(env)
    await markRecordingStarted(store, {
      platform: 'chaturbate',
      model: 'momgoeswild',
      target: 'momgoeswild',
      chatId: 736161596,
      source: 'manual',
      startedAt: Date.now() - 5 * 60_000,
    })

    await sendWebhookUpdate(
      {
        update_id: 605,
        message: {
          message_id: 5,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/status',
        },
      },
      env,
    )

    const statusMsg = tgCalls.find((c) => c.method === 'sendMessage')
    expect(statusMsg?.body.text).toContain('momgoeswild')
    expect(statusMsg?.body.text).toContain('5 د')
    expect(JSON.stringify(statusMsg?.body.reply_markup)).toContain('rec|stop|momgoeswild')

    await sendWebhookUpdate(
      {
        update_id: 606,
        callback_query: {
          id: 'cb-list-1',
          from: { id: 736161596, language_code: 'ar' },
          message: { message_id: 99, chat: { id: 736161596, type: 'private' } },
          data: 'rec|list',
        },
      },
      env,
    )
    const editCall = tgCalls.find((c) => c.method === 'editMessageText')
    expect(editCall?.body.text).toContain('momgoeswild')
  })

  it('clears active recording lock and watch lock on /api/record/signal/clear with zero extra writes when empty', async () => {
    const env = makeEnv()
    const store = getStore(env)
    const recToken = await sha256Hex(`savelink-recorder-v1:${BOT_TOKEN}`)

    await markRecordingStarted(store, {
      platform: 'chaturbate',
      model: 'momgoeswild',
      target: 'momgoeswild',
      chatId: 736161596,
    })
    expect(await store.get(ACTIVE_REC_INDEX_KEY)).toBeTruthy()
    expect(await store.get(watchLockKey('chaturbate', 'momgoeswild'))).toBeTruthy()

    const clearRes = await apiRoute.request(
      '/record/signal/clear?target=momgoeswild&platform=chaturbate',
      { method: 'GET', headers: { 'x-recorder-token': recToken } },
      env,
    )
    expect(clearRes.status).toBe(200)
    expect(await store.get(ACTIVE_REC_INDEX_KEY)).toBeNull()
    expect(await store.get(watchLockKey('chaturbate', 'momgoeswild'))).toBeNull()

    // Second clear when already empty should still succeed cleanly.
    const secondRes = await apiRoute.request(
      '/record/signal/clear?target=momgoeswild&platform=chaturbate',
      { method: 'GET', headers: { 'x-recorder-token': recToken } },
      env,
    )
    expect(secondRes.status).toBe(200)
  })

  it('handles POST /api/record/continue auth, stop/pause refusal, and part-2 re-dispatch', async () => {
    const dispatches: any[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/dispatches')) {
          dispatches.push(init?.body ? JSON.parse(String(init.body)) : {})
          return new Response(null, { status: 204 })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const env = makeEnv()
    const store = getStore(env)
    const recToken = await sha256Hex(`savelink-recorder-v1:${BOT_TOKEN}`)

    // 1. Unauthorized call -> 401
    const unauth = await apiRoute.request(
      '/record/continue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 736161596, platform: 'chaturbate', model: 'momgoeswild' }),
      },
      env,
    )
    expect(unauth.status).toBe(401)

    // 2. When stopped via stop:<model>, returns continued:false and clears lock
    await store.put('stop:momgoeswild', '1', 3600)
    const stoppedRes = await apiRoute.request(
      '/record/continue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-recorder-token': recToken },
        body: JSON.stringify({ chatId: 736161596, platform: 'chaturbate', model: 'momgoeswild' }),
      },
      env,
    )
    expect(stoppedRes.status).toBe(200)
    expect(await stoppedRes.json()).toMatchObject({ ok: true, continued: false, reason: 'stopped' })
    expect(dispatches).toHaveLength(0)

    await store.delete('stop:momgoeswild')

    // 3. When recorder paused globally, refuses continuation
    await setRecorderPaused(env, true, 736161596)
    const pausedRes = await apiRoute.request(
      '/record/continue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-recorder-token': recToken },
        body: JSON.stringify({ chatId: 736161596, platform: 'chaturbate', model: 'momgoeswild' }),
      },
      env,
    )
    expect(pausedRes.status).toBe(200)
    expect(await pausedRes.json()).toMatchObject({ ok: true, continued: false, reason: 'stopped' })
    await setRecorderPaused(env, false)

    // 4. Normal auto-split -> dispatches continuation and refreshes active recording lock
    const okRes = await apiRoute.request(
      '/record/continue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-recorder-token': recToken },
        body: JSON.stringify({
          chatId: 736161596,
          platform: 'chaturbate',
          model: 'momgoeswild',
          target: 'https://chaturbate.com/momgoeswild/',
        }),
      },
      env,
    )
    expect(okRes.status).toBe(200)
    expect(await okRes.json()).toMatchObject({ ok: true, continued: true })
    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].inputs.watch_mode).toBe('0')

    const active = await listActiveRecordings(store, 736161596)
    expect(active).toHaveLength(1)
    expect(active[0].source).toBe('continuation')
  })

  it('completes /record and sends confirmation even when KV put() limit is exceeded for the day', async () => {
    const dispatches: any[] = []
    const tgCalls: Array<{ method: string; body: any }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('chatvideocontext')) {
          return new Response(
            JSON.stringify({ room_status: 'public', hls_source: 'https://edge.example.com/live.m3u8' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/dispatches')) {
          dispatches.push(init?.body ? JSON.parse(String(init.body)) : {})
          return new Response(null, { status: 204 })
        }
        if (url.includes('api.telegram.org')) {
          const method = url.split('/').pop() || ''
          tgCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} })
          return new Response(JSON.stringify({ ok: true, result: { message_id: 95 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const exhaustedKv = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => {
        throw new Error('KV put() limit exceeded for the day.')
      }),
      delete: vi.fn(async () => {
        throw new Error('KV put() limit exceeded for the day.')
      }),
    } as unknown as KVNamespace

    const env = makeEnv({ CACHE: exhaustedKv })
    const res = await sendWebhookUpdate(
      {
        update_id: 699,
        message: {
          message_id: 9,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record momgoeswild',
        },
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(dispatches).toHaveLength(1)

    const editMsg = tgCalls.find((c) => c.method === 'editMessageText')
    expect(editMsg?.body.text).toContain('جاري الاتصال وتسجيل بث')
    expect(editMsg?.body.text).not.toContain('KV put() limit exceeded')
  })
})
