import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramApi } from '../src/telegram/api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function mockTelegram(result: unknown = { message_id: 1 }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return calls
}

describe('TelegramApi', () => {
  it('sends JSON bodies for plain calls', async () => {
    const calls = mockTelegram()
    const tg = new TelegramApi('123:abc')
    await tg.call('sendMessage', { chat_id: 42, text: 'hi' })

    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
    expect(calls[0].init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ chat_id: 42, text: 'hi' })
  })

  it('builds a shorthand multipart body when a Blob is present', async () => {
    const calls = mockTelegram()
    const tg = new TelegramApi('123:abc')
    await tg.call(
      'sendPhoto',
      { chat_id: 42, photo: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), caption: 'hi' },
      { filename: 'a.jpg' },
    )

    const body = calls[0].init.body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('chat_id')).toBe('42')
    expect(body.get('caption')).toBe('hi')
    expect(body.get('photo')).toBeInstanceOf(Blob)
  })

  it('serialises media groups with named file parts', async () => {
    const calls = mockTelegram()
    const tg = new TelegramApi('123:abc')
    const media = [
      { type: 'photo', media: 'attach://p0', caption: 'album' },
      { type: 'photo', media: 'attach://p1' },
    ]
    await tg.multipart(
      'sendMediaGroup',
      { chat_id: 42, media },
      [
        { field: 'p0', blob: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }), filename: '0.jpg' },
        { field: 'p1', blob: new Blob([new Uint8Array([2])], { type: 'image/jpeg' }), filename: '1.jpg' },
      ],
    )

    expect(calls[0].url).toBe('https://api.telegram.org/bot123:abc/sendMediaGroup')
    const body = calls[0].init.body as FormData
    expect(body.get('chat_id')).toBe('42')
    expect(JSON.parse(String(body.get('media')))).toEqual(media)
    expect(body.get('p0')).toBeInstanceOf(Blob)
    expect(body.get('p1')).toBeInstanceOf(Blob)
  })

  it('surfaces Telegram error descriptions', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const tg = new TelegramApi('123:abc')
    await expect(tg.call('sendMessage', { chat_id: 1, text: 'x' })).rejects.toMatchObject({
      code: 400,
      message: 'Bad Request: chat not found',
    })
  })

  it('ignores no-op edits', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    const tg = new TelegramApi('123:abc')
    await expect(tg.safeEdit('editMessageText', { chat_id: 1, message_id: 2, text: 'x' })).resolves.toBeUndefined()
  })
})
