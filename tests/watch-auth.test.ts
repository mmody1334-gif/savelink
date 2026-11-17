import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiRoute, watchAuthOk } from '../src/routes/api'
import { canControlPause, isPauseConfigured } from '../src/pause'
import type { Env } from '../src/types'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('kill-switch ownership', () => {
  it('is disabled for everyone when OWNER_ID is unset', () => {
    expect(isPauseConfigured({} as Env)).toBe(false)
    expect(canControlPause({} as Env, 123)).toBe(false)
    expect(canControlPause({ OWNER_ID: '' } as Env, 123)).toBe(false)
  })

  it('allows only the listed owners when OWNER_ID is set', () => {
    const env = { OWNER_ID: '111, 222' } as Env
    expect(isPauseConfigured(env)).toBe(true)
    expect(canControlPause(env, 111)).toBe(true)
    expect(canControlPause(env, 222)).toBe(true)
    expect(canControlPause(env, 333)).toBe(false)
    expect(canControlPause(env)).toBe(false)
  })
})

describe('watch endpoint auth', () => {
  const SECRET = 'test-webhook-secret'

  it('refuses /watch/status without the shared secret', async () => {
    const res = await apiRoute.request('/watch/status', { method: 'GET' }, { WEBHOOK_SECRET: SECRET } as Env)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('refuses /watch/status with a wrong secret', async () => {
    const res = await apiRoute.request(
      '/watch/status',
      { method: 'GET', headers: { 'x-telegram-bot-api-secret-token': 'nope' } },
      { WEBHOOK_SECRET: SECRET } as Env,
    )
    expect(res.status).toBe(401)
  })

  it('refuses /watch/status when no secret is configured at all', async () => {
    const res = await apiRoute.request(
      '/watch/status',
      { method: 'GET', headers: { 'x-telegram-bot-api-secret-token': SECRET } },
      {} as Env,
    )
    expect(res.status).toBe(401)
  })

  it('accepts /watch/status with the header secret', async () => {
    const res = await apiRoute.request(
      '/watch/status',
      { method: 'GET', headers: { 'x-telegram-bot-api-secret-token': SECRET } },
      { WEBHOOK_SECRET: SECRET } as Env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, count: 0, targets: [] })
  })

  it('accepts /watch/status with a bearer token', async () => {
    const res = await apiRoute.request(
      '/watch/status',
      { method: 'GET', headers: { authorization: `Bearer ${SECRET}` } },
      { WEBHOOK_SECRET: SECRET } as Env,
    )
    expect(res.status).toBe(200)
  })

  it('refuses /watch/cycle without the shared secret', async () => {
    const res = await apiRoute.request('/watch/cycle', { method: 'GET' }, { WEBHOOK_SECRET: SECRET } as Env)
    expect(res.status).toBe(401)
  })

  it('refuses /watch/check without the shared secret', async () => {
    const res = await apiRoute.request(
      '/watch/check?target=@someone&platform=tiktok',
      { method: 'GET' },
      { WEBHOOK_SECRET: SECRET } as Env,
    )
    expect(res.status).toBe(401)
  })

  it('runs /watch/check with the secret and reports the live check', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })))
    const res = await apiRoute.request(
      '/watch/check?target=@someone&platform=tiktok',
      { method: 'GET', headers: { 'x-telegram-bot-api-secret-token': SECRET } },
      { WEBHOOK_SECRET: SECRET } as Env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { state: string }
    expect(body.state).toBe('unknown')
  })

  it('leaves /api/health public', async () => {
    const res = await apiRoute.request('/health', { method: 'GET' }, {} as Env)
    expect(res.status).toBe(200)
    expect((await res.json()) as { ok: boolean }).toEqual(
      expect.objectContaining({ ok: true, service: 'savelink' }),
    )
  })

  it('leaves /record/signal behaviour unchanged', async () => {
    const res = await apiRoute.request('/record/signal?target=someone', { method: 'GET' }, {} as Env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ stop: false })
  })

  it('watchAuthOk matches the header and bearer forms only', () => {
    const fake = (headers: Record<string, string>) =>
      ({
        req: { header: (name: string) => headers[name.toLowerCase()] },
        env: { WEBHOOK_SECRET: SECRET } as Env,
      }) as unknown as Parameters<typeof watchAuthOk>[0]
    expect(watchAuthOk(fake({ 'x-telegram-bot-api-secret-token': SECRET }))).toBe(true)
    expect(watchAuthOk(fake({ authorization: `Bearer ${SECRET}` }))).toBe(true)
    expect(watchAuthOk(fake({ authorization: 'Bearer wrong' }))).toBe(false)
    expect(watchAuthOk(fake({}))).toBe(false)
  })
})
