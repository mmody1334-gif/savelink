import { describe, expect, it } from 'vitest'
import {
  arrayBufferToBase64,
  parseAiResponse,
  transcribeAndSummarizeAudio,
} from '../src/ai'

describe('AI transcription and summarization', () => {
  it('converts array buffer to base64 correctly', () => {
    const text = 'Hello, world!'
    const buffer = new TextEncoder().encode(text).buffer
    const b64 = arrayBufferToBase64(buffer)
    expect(b64).toBe(btoa(text))
  })

  it('parses AI response splitting transcript and summary', () => {
    const raw = `📝 **التفريغ النصي:**
هذا نص تجريبي تم تسجيله في البث.

💡 **أهم النقاط:**
• النقطة الأولى
• النقطة الثانية
• النقطة الثالثة`

    const parsed = parseAiResponse(raw)
    expect(parsed.transcript).toContain('هذا نص تجريبي')
    expect(parsed.summary).toContain('النقطة الأولى')
  })

  it('throws GEMINI_API_KEY_REQUIRED when key is missing', async () => {
    const dummyBuffer = new ArrayBuffer(8)
    await expect(
      transcribeAndSummarizeAudio(dummyBuffer, 'audio/ogg', {} as any),
    ).rejects.toThrow('GEMINI_API_KEY_REQUIRED')
  })
})
