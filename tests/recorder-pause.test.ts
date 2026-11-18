import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { isRecorderPaused, setRecorderPaused } from '../src/pause'
import { apiRoute } from '../src/routes/api'
import { getStore } from '../src/store'
import type { Env } from '../src/types'
import { addWatchTarget, removeWatchTarget, runWatchCycle } from '../src/watch'

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
  await setRecorderPaused({} as Env, false)
  const store = getStore({} as Env)
  await store.delete('stop:visceratio')
  await removeWatchTarget(736161596, 'visceratio', store)
})

describe('/stop recorder & auto-resume on /record', () => {
  it('pauses active recordings and watch without stopping other bot features, canceling only queued runs', async () => {
    const cancelledIds: number[] = []
    const tgCalls: Array<{ method: string; body: any }> = []

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/actions/workflows/record.yml/runs')) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                { id: 101, status: 'in_progress' },
                { id: 102, status: 'queued' },
                { id: 103, status: 'waiting' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (url.includes('/actions/runs/') && url.endsWith('/cancel')) {
          const id = Number(url.match(/\/actions\/runs\/(\d+)\/cancel/)?.[1])
          cancelledIds.push(id)
          return new Response(null, { status: 202 })
        }
        if (url.includes('api.telegram.org')) {
          const method = url.split('/').pop() || ''
          tgCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} })
          return new Response(JSON.stringify({ ok: true, result: { message_id: 22 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const env = makeEnv()

    // Non-owner cannot run /stop recorder
    await sendWebhookUpdate(
      {
        update_id: 500,
        message: {
          message_id: 1,
          chat: { id: 111111, type: 'private' },
          from: { id: 111111, language_code: 'ar' },
          text: '/stop recorder',
        },
      },
      env,
    )
    expect(await isRecorderPaused(env)).toBe(false)

    // Owner runs /stop recorder
    await sendWebhookUpdate(
      {
        update_id: 501,
        message: {
          message_id: 2,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/stop recorder',
        },
      },
      env,
    )

    expect(await isRecorderPaused(env)).toBe(true)
    expect(cancelledIds).toEqual([102, 103])
    expect(cancelledIds).not.toContain(101)

    // /api/record/signal immediately signals running recorders to stop gracefully
    const sigRes = await apiRoute.request('/record/signal?target=any_running_model', { method: 'GET' }, env)
    expect(sigRes.status).toBe(200)
    expect(await sigRes.json()).toEqual({ stop: true, recorderPaused: true })

    // /watch cycles skip checks and writes while recorder pause is active
    const store = getStore(env)
    await addWatchTarget(736161596, 'visceratio', store)
    const cycle = await runWatchCycle(env, store)
    expect(cycle).toEqual({ checked: 0, triggered: 0, unknown: 0 })

    // Non-recording routes (/api/health and /start) continue working normally
    const healthRes = await apiRoute.request('/health', { method: 'GET' }, env)
    expect(healthRes.status).toBe(200)

    await sendWebhookUpdate(
      {
        update_id: 502,
        message: {
          message_id: 3,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/start',
        },
      },
      env,
    )
    expect(tgCalls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('مرحباً'))).toBe(true)

    // Bare /record shows help and does NOT unpause
    await sendWebhookUpdate(
      {
        update_id: 503,
        message: {
          message_id: 4,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record',
        },
      },
      env,
    )
    expect(await isRecorderPaused(env)).toBe(true)
  })

  it('automatically resumes recorder and /watch on next valid /record <target> and clears stale stop key', async () => {
    const dispatches: any[] = []
    let cbChecks = 0

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('chatvideocontext')) {
          cbChecks += 1
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
          return new Response(JSON.stringify({ ok: true, result: { message_id: 33 } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response('not found', { status: 404 })
      }),
    )

    const env = makeEnv()
    const store = getStore(env)
    await setRecorderPaused(env, true, 736161596)
    await store.put('stop:visceratio', '1', 3600)
    await addWatchTarget(736161596, 'visceratio', store)

    await sendWebhookUpdate(
      {
        update_id: 510,
        message: {
          message_id: 10,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/record visceratio',
        },
      },
      env,
    )

    expect(await isRecorderPaused(env)).toBe(false)
    expect(await store.get('stop:visceratio')).toBeNull()
    expect(dispatches.length).toBeGreaterThanOrEqual(1)

    const sigRes = await apiRoute.request('/record/signal?target=visceratio', { method: 'GET' }, env)
    expect(sigRes.status).toBe(200)
    expect(await sigRes.json()).toEqual({ stop: false })

    // Watch cycle resumes checking targets again
    const beforeChecks = cbChecks
    await runWatchCycle(env, store)
    expect(cbChecks).toBeGreaterThan(beforeChecks)
  })
})
