import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleBypassCommand } from '../src/telegram/bypass-handlers'
import { TelegramApi } from '../src/telegram/api'
import type { TgMessage } from '../src/telegram/types'
import type { Store } from '../src/store'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function createMockStore(): Store {
  const map = new Map<string, string>()
  return {
    async get(k: string) {
      return map.get(k) ?? null
    },
    async put(k: string, v: string) {
      map.set(k, v)
    },
    async delete(k: string) {
      map.delete(k)
    },
    async incr(k: string) {
      const cur = parseInt(map.get(k) ?? '0', 10) || 0
      map.set(k, String(cur + 1))
      return cur + 1
    },
  }
}

describe('handleBypassCommand', () => {
  it('sends prompt when no URL is provided', async () => {
    const tgCalls: any[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      tgCalls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(JSON.stringify({ ok: true, result: { message_id: 10 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const tg = new TelegramApi('123:test')
    const message: TgMessage = {
      message_id: 1,
      chat: { id: 100, type: 'private' },
    }
    const store = createMockStore()
    const handleLinkMock = vi.fn()

    await handleBypassCommand(tg, message, '', 'ar', {}, store, 'https://bot', handleLinkMock)

    expect(tgCalls.length).toBe(1)
    expect(tgCalls[0].body.text).toContain('فك وتخطي روابط الاختصار')
    expect(handleLinkMock).not.toHaveBeenCalled()
  })

  it('unshortens URL and shows direct link button', async () => {
    const tgCalls: any[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = String(url)
      if (urlStr.includes('api.telegram.org')) {
        tgCalls.push({ url: urlStr, body: init?.body ? JSON.parse(init.body) : undefined })
        return new Response(JSON.stringify({ ok: true, result: { message_id: 20 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('tinyurl.com')) {
        return new Response('', {
          status: 301,
          headers: { location: 'https://example.com/final-article' },
        })
      }
      return new Response('<html>ok</html>', { status: 200 })
    }) as typeof fetch

    const tg = new TelegramApi('123:test')
    const message: TgMessage = {
      message_id: 1,
      chat: { id: 100, type: 'private' },
    }
    const store = createMockStore()
    const handleLinkMock = vi.fn()

    await handleBypassCommand(
      tg,
      message,
      'https://tinyurl.com/abc',
      'ar',
      {},
      store,
      'https://bot',
      handleLinkMock,
    )

    expect(tgCalls.length).toBe(2)
    const editCall = tgCalls[1]
    expect(editCall.body.text).toContain('تم تخطي رابط الاختصار بنجاح')
    expect(editCall.body.text).toContain('https://example.com/final-article')
    expect(editCall.body.reply_markup.inline_keyboard[0][0].url).toBe('https://example.com/final-article')
  })

  it('hands off to handleLink when bypassed URL is a supported media platform', async () => {
    globalThis.fetch = (async (url: any, _init: any) => {
      const urlStr = String(url)
      if (urlStr.includes('api.telegram.org')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 30 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (urlStr.includes('bit.ly')) {
        return new Response('', {
          status: 301,
          headers: { location: 'https://www.tiktok.com/@user/video/123456789' },
        })
      }
      return new Response('<html>ok</html>', { status: 200 })
    }) as typeof fetch

    const tg = new TelegramApi('123:test')
    const message: TgMessage = {
      message_id: 1,
      chat: { id: 100, type: 'private' },
    }
    const store = createMockStore()
    const handleLinkMock = vi.fn()

    await handleBypassCommand(
      tg,
      message,
      'https://bit.ly/tiktokvid',
      'ar',
      {},
      store,
      'https://bot',
      handleLinkMock,
    )

    expect(handleLinkMock).toHaveBeenCalledWith(
      tg,
      message,
      'https://www.tiktok.com/@user/video/123456789',
      'ar',
      {},
      store,
      'https://bot',
    )
  })
})
