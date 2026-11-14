import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleAudioMessage,
  handleSetKeyCommand,
  resolveGeminiApiKey,
} from '../src/telegram/ai-handlers'
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

describe('AI Handlers', () => {
  describe('resolveGeminiApiKey', () => {
    it('prioritizes env key over store keys', async () => {
      const store = createMockStore()
      await store.put('cfg:gemini_key', 'store-key')
      const resolved = await resolveGeminiApiKey({ GEMINI_API_KEY: 'env-key' } as any, store)
      expect(resolved).toBe('env-key')
    })

    it('falls back to user key then global store key', async () => {
      const store = createMockStore()
      await store.put('cfg:gemini_key', 'global-key')
      await store.put('user:gemini_key:555', 'user-key')

      const userRes = await resolveGeminiApiKey({} as any, store, 555)
      expect(userRes).toBe('user-key')

      const otherRes = await resolveGeminiApiKey({} as any, store, 999)
      expect(otherRes).toBe('global-key')
    })
  })

  describe('handleSetKeyCommand', () => {
    it('prompts if key is empty', async () => {
      const tgCalls: any[] = []
      globalThis.fetch = (async (_url: any, init: any) => {
        tgCalls.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }) as typeof fetch

      const tg = new TelegramApi('123:test')
      const message: TgMessage = { message_id: 1, chat: { id: 100, type: 'private' } }
      const store = createMockStore()

      await handleSetKeyCommand(tg, message, '', 'ar', store)
      expect(tgCalls[0].text).toContain('تعيين مفتاح Google Gemini API')
    })

    it('saves valid key to user and global KV store', async () => {
      const tgCalls: any[] = []
      globalThis.fetch = (async (_url: any, init: any) => {
        tgCalls.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }) as typeof fetch

      const tg = new TelegramApi('123:test')
      const message: TgMessage = { message_id: 1, chat: { id: 100, type: 'private' } }
      const store = createMockStore()

      const validKey = 'AIzaSyDemoValidSecretKey123456789'
      await handleSetKeyCommand(tg, message, validKey, 'ar', store)

      expect(await store.get('cfg:gemini_key')).toBe(validKey)
      expect(await store.get('user:gemini_key:100')).toBe(validKey)
      expect(tgCalls[0].text).toContain('تم حفظ مفتاح Gemini بنجاح')
    })
  })

  describe('handleAudioMessage', () => {
    it('requests API key if none configured', async () => {
      const tgCalls: any[] = []
      globalThis.fetch = (async (_url: any, init: any) => {
        tgCalls.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })
      }) as typeof fetch

      const tg = new TelegramApi('123:test')
      const message: TgMessage = {
        message_id: 1,
        chat: { id: 100, type: 'private' },
        voice: { file_id: 'voice123', file_unique_id: 'u1' },
      }
      const store = createMockStore()

      await handleAudioMessage(tg, message, 'ar', {}, store)
      expect(tgCalls[0].text).toContain('Google AI Studio')
    })

    it('downloads audio and transcribes with Gemini', async () => {
      const tgCalls: any[] = []
      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url)
        if (urlStr.includes('getFile')) {
          return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/sample.oga' } }))
        }
        if (urlStr.includes('sample.oga')) {
          return new Response(new Uint8Array([1, 2, 3, 4]))
        }
        if (urlStr.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: '📝 التفريغ النصي:\nصباح الخير جميعاً هذا اختبار تسجيل.\n\n💡 أهم النقاط:\n• تحية صباحية\n• فحص تقني',
                      },
                    ],
                  },
                },
              ],
            }),
          )
        }
        if (urlStr.includes('api.telegram.org')) {
          tgCalls.push({ url: urlStr, body: init?.body ? JSON.parse(init.body) : undefined })
          return new Response(JSON.stringify({ ok: true, result: { message_id: 99 } }))
        }
        return new Response('ok')
      }) as typeof fetch

      const tg = new TelegramApi('123:test')
      const message: TgMessage = {
        message_id: 1,
        chat: { id: 100, type: 'private' },
        voice: { file_id: 'voice123', file_unique_id: 'u1', mime_type: 'audio/ogg' },
      }
      const store = createMockStore()
      await store.put('cfg:gemini_key', 'test-api-key')

      await handleAudioMessage(tg, message, 'ar', { BOT_TOKEN: '123:test' }, store)

      expect(tgCalls.length).toBe(2)
      const finalMsg = tgCalls[1].body.text
      expect(finalMsg).toContain('التفريغ الصوتي:')
      expect(finalMsg).toContain('صباح الخير جميعاً')
      expect(finalMsg).toContain('أهم النقاط:')
      expect(finalMsg).toContain('تحية صباحية')
    })
  })
})
