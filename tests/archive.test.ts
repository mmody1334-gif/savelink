import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import {
  ARCHIVE_ALL_KEY,
  ARCHIVE_TTL_SECONDS,
  MAX_ARCHIVE_ITEMS,
  addArchiveEntry,
  archiveUserKey,
  deleteArchiveEntry,
  listArchiveEntries,
  signArchivePageUrl,
} from '../src/archive'
import { setPaused } from '../src/pause'
import { apiRoute } from '../src/routes/api'
import { archivePageRoute } from '../src/routes/archive-page'
import { sha256Hex } from '../src/sign'
import { getStore } from '../src/store'
import type { Env } from '../src/types'

const BOT_TOKEN = '999:test-bot-token'
const WEBHOOK_SECRET = 'test-webhook-secret'
const SIGNING_SECRET = 'test-signing-secret'

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  const store = getStore({} as Env)
  await store.delete(archiveUserKey(736161596))
  await store.delete(archiveUserKey(888))
  await store.delete(ARCHIVE_ALL_KEY)
  await setPaused({} as Env, false)
})

describe('recordings archive store', () => {
  it('saves, deduplicates by URL, searches and deletes entries', async () => {
    const store = getStore({} as Env)
    const puts: Array<{ key: string; ttl?: number }> = []
    const wrapped = {
      get: (k: string) => store.get(k),
      put: async (k: string, v: string, ttl?: number) => {
        puts.push({ key: k, ttl })
        return store.put(k, v, ttl)
      },
      delete: (k: string) => store.delete(k),
      incr: (k: string, ttl: number) => store.incr(k, ttl),
    }

    const first = await addArchiveEntry(wrapped, {
      chatId: 736161596,
      platform: 'chaturbate',
      model: '@Test_Model',
      url: 'https://pixeldrain.com/u/abc123',
      size: '120 MB',
      duration: '12m 10s',
      source: 'recorder',
      createdAt: 1000,
    })

    expect(first.model).toBe('test_model')
    expect(puts.every((p) => p.ttl === ARCHIVE_TTL_SECONDS)).toBe(true)

    // Duplicate URL updates metadata without creating a second entry.
    await addArchiveEntry(wrapped, {
      chatId: 736161596,
      platform: 'chaturbate',
      model: 'test_model',
      url: 'https://pixeldrain.com/u/abc123',
      size: '121 MB',
      duration: '12m 11s',
      source: 'uploader',
      createdAt: 2000,
    })

    await addArchiveEntry(wrapped, {
      chatId: 736161596,
      platform: 'tiktok',
      model: 'creator_two',
      url: 'https://pixeldrain.com/u/xyz999',
      size: '50 MB',
      createdAt: 3000,
    })

    const all = await listArchiveEntries(wrapped, 736161596)
    expect(all).toHaveLength(2)
    expect(all[0].model).toBe('creator_two')
    expect(all[1].size).toBe('121 MB')

    const filtered = await listArchiveEntries(wrapped, 736161596, 'test_model')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].url).toBe('https://pixeldrain.com/u/abc123')

    const deleted = await deleteArchiveEntry(wrapped, 736161596, first.id)
    expect(deleted).toBe(true)
    expect(await listArchiveEntries(wrapped, 736161596)).toHaveLength(1)
  })

  it('caps stored entries at MAX_ARCHIVE_ITEMS', async () => {
    const store = getStore({} as Env)
    for (let i = 0; i < MAX_ARCHIVE_ITEMS + 5; i += 1) {
      await addArchiveEntry(store, {
        chatId: 888,
        platform: 'chaturbate',
        model: `model_${i}`,
        url: `https://pixeldrain.com/u/item${i}`,
        createdAt: 1000 + i,
      })
    }
    const items = await listArchiveEntries(store, 888)
    expect(items).toHaveLength(MAX_ARCHIVE_ITEMS)
    expect(items[0].model).toBe(`model_${MAX_ARCHIVE_ITEMS + 4}`)
  })
})

describe('archive & recorder API endpoints', () => {
  const env: Env = { BOT_TOKEN, WEBHOOK_SECRET, SIGNING_SECRET }

  it('rejects unauthenticated requests to archive and stop endpoints', async () => {
    const r1 = await apiRoute.request('/archive', { method: 'GET' }, env)
    const r2 = await apiRoute.request(
      '/archive/add',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: 736161596, platform: 'chaturbate', model: 'm1', url: 'https://pixeldrain.com/u/1' }),
      },
      env,
    )
    const r3 = await apiRoute.request('/record/stop', { method: 'POST', body: JSON.stringify({ target: 'm1' }) }, env)
    const r4 = await apiRoute.request('/record/signal/clear?target=m1', { method: 'GET' }, env)

    expect(r1.status).toBe(401)
    expect(r2.status).toBe(401)
    expect(r3.status).toBe(401)
    expect(r4.status).toBe(401)
  })

  it('accepts X-Recorder-Token even while global pause is enabled', async () => {
    const recToken = await sha256Hex(`savelink-recorder-v1:${BOT_TOKEN}`)
    await setPaused(env, true, 736161596)

    const pausedSignal = await apiRoute.request('/record/signal?target=m1', { method: 'GET' }, env)
    expect(pausedSignal.status).toBe(200)
    expect(await pausedSignal.json()).toEqual({ stop: true, paused: true })

    const addRes = await apiRoute.request(
      '/archive/add',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-recorder-token': recToken },
        body: JSON.stringify({
          chatId: 736161596,
          platform: 'chaturbate',
          model: 'pamy_assam',
          url: 'https://pixeldrain.com/u/test999',
          size: '420 MB',
        }),
      },
      env,
    )
    expect(addRes.status).toBe(200)
    expect((await addRes.json()) as { ok: boolean }).toMatchObject({ ok: true })

    const clearRes = await apiRoute.request(
      '/record/signal/clear?target=pamy_assam&platform=chaturbate',
      { method: 'GET', headers: { 'x-recorder-token': recToken } },
      env,
    )
    expect(clearRes.status).toBe(200)

    await setPaused(env, false)

    const listRes = await apiRoute.request(
      '/archive?chatId=736161596',
      { method: 'GET', headers: { authorization: `Bearer ${WEBHOOK_SECRET}` } },
      env,
    )
    expect(listRes.status).toBe(200)
    const listData = (await listRes.json()) as { count: number; entries: Array<{ url: string }> }
    expect(listData.count).toBe(1)
    expect(listData.entries[0].url).toBe('https://pixeldrain.com/u/test999')
  })

  it('serves signed /archive web page with escaped HTML and rejects invalid tokens', async () => {
    const store = getStore(env)
    await addArchiveEntry(store, {
      chatId: 736161596,
      platform: 'chaturbate',
      model: '<script>xss</script>',
      url: 'https://pixeldrain.com/u/safe123',
      size: '80 MB',
    })

    const bad = await archivePageRoute.request('/?t=invalid.token', { method: 'GET' }, env)
    expect(bad.status).toBe(401)

    const signedUrl = await signArchivePageUrl(736161596, env, 'https://example.workers.dev')
    const token = new URL(signedUrl).searchParams.get('t') || ''
    const okRes = await archivePageRoute.request(`/?t=${encodeURIComponent(token)}`, { method: 'GET' }, env)
    expect(okRes.status).toBe(200)
    const html = await okRes.text()
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('https://pixeldrain.com/u/safe123')
    expect(html).toContain('&lt;script&gt;xss&lt;/script&gt;')
    expect(html).not.toContain('<script>xss</script>')
  })
})

describe('Telegram /archive and /stop archive integration', () => {
  it('handles /archive command and adds archive button to /stop', async () => {
    const tgCalls: Array<{ method: string; body: any }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const method = url.split('/').pop() || ''
        const body = init?.body ? JSON.parse(String(init.body)) : {}
        tgCalls.push({ method, body })
        return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )

    const env: Env = {
      BOT_TOKEN,
      WEBHOOK_SECRET,
      SIGNING_SECRET,
      PUBLIC_BASE_URL: 'https://savelink.example.workers.dev',
      GITHUB_TOKEN: 'gh-test',
    }
    const store = getStore(env)
    await addArchiveEntry(store, {
      chatId: 736161596,
      platform: 'chaturbate',
      model: 'visceratio',
      url: 'https://pixeldrain.com/u/live123',
      size: '250 MB',
      duration: '18m 05s',
    })

    const archiveReq = new Request(`https://savelink.example.workers.dev/telegram/webhook/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 101,
        message: {
          message_id: 10,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/archive',
        },
      }),
    })
    const res1 = await worker.fetch(archiveReq, env, { waitUntil: () => {} } as any)
    expect(res1.status).toBe(200)

    const archiveSend = tgCalls.find((c) => c.method === 'sendMessage')
    expect(archiveSend).toBeDefined()
    expect(archiveSend?.body.text).toContain('visceratio')
    expect(archiveSend?.body.text).toContain('https://pixeldrain.com/u/live123')
    expect(JSON.stringify(archiveSend?.body.reply_markup)).toContain('/archive?t=')

    const stopReq = new Request(`https://savelink.example.workers.dev/telegram/webhook/${WEBHOOK_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 102,
        message: {
          message_id: 11,
          chat: { id: 736161596, type: 'private' },
          from: { id: 736161596, language_code: 'ar' },
          text: '/stop visceratio',
        },
      }),
    })
    const res2 = await worker.fetch(stopReq, env, { waitUntil: () => {} } as any)
    expect(res2.status).toBe(200)

    const stopEdit = tgCalls.find((c) => c.method === 'editMessageText')
    expect(stopEdit).toBeDefined()
    expect(JSON.stringify(stopEdit?.body.reply_markup)).toContain('arch|p|0|')
  })
})
