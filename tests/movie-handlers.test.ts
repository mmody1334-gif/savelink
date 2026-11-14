import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMovieCallback } from '../src/telegram/movie-handlers'
import { TelegramApi } from '../src/telegram/api'
import type { TgCallbackQuery } from '../src/telegram/types'
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

describe('handleMovieCallback', () => {
  it('handles movie selection when message has photo (uses editMessageCaption/Media without crashing)', async () => {
    const tgCalls: Array<{ url: string; body?: any }> = []

    globalThis.fetch = (async (url: any, init: any) => {
      const urlStr = String(url)
      if (urlStr.includes('api.telegram.org')) {
        const body = init?.body ? JSON.parse(init.body) : undefined
        tgCalls.push({ url: urlStr, body })

        // If editMessageText is wrongly called on a photo message, Telegram returns error:
        if (urlStr.includes('editMessageText')) {
          return new Response(
            JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: there is no text in the message to edit' }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          )
        }

        return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      // Akwam details page mock
      if (urlStr.includes('akwam.ss/movie/')) {
        const mockHtml = `
          <h1 class="entry-title">Avengers: Endgame</h1>
          <span class="text-white">السنة : 2019</span>
          <div class="download-item">
            <span>1080p</span>
            <a href="https://akwam.ss/watch/6779/569/avengers" class="link-btn">مشاهدة</a>
            <a href="https://akwam.ss/download/6779/569/avengers" class="link-btn">تحميل</a>
          </div>
        `
        return new Response(mockHtml, { status: 200 })
      }

      return new Response('ok', { status: 200 })
    }) as typeof fetch

    const tg = new TelegramApi('123:test')
    const store = createMockStore()

    // Store search results
    await store.put(
      'mov_s:testKey',
      JSON.stringify({
        query: 'endgame',
        results: [
          {
            id: 'movie:569',
            title: 'Avengers: Endgame',
            url: 'https://akwam.ss/movie/569/avengers',
            kind: 'movie',
            poster: 'https://img.downet.net/thumb/poster.jpg',
          },
        ],
        lang: 'ar',
      }),
    )

    // Simulate clicking result 0 on a message with a photo
    const query: TgCallbackQuery = {
      id: 'cb_123',
      message: {
        message_id: 123,
        chat: { id: 100, type: 'private' },
        photo: [{ file_id: 'p1', file_unique_id: 'pu1', width: 100, height: 100 }],
      },
      data: 'mov|s|testKey|0',
    }

    await handleMovieCallback(tg, query, 100, 123, ['mov', 's', 'testKey', '0'], 'ar', {}, store, 'https://bot')

    // Expect callback answered
    expect(tgCalls.some((c) => c.url.includes('answerCallbackQuery'))).toBe(true)

    // Expect editMessageMedia or editMessageCaption was called, NOT failing with unhandled editMessageText
    const mediaOrCaptionCall = tgCalls.find(
      (c) => c.url.includes('editMessageMedia') || c.url.includes('editMessageCaption'),
    )
    expect(mediaOrCaptionCall).toBeDefined()
    expect(mediaOrCaptionCall?.body.caption).toContain('Avengers: Endgame')
  })
})
