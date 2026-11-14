import type { Env } from './types'

export interface AiSummaryResult {
  transcript: string
  summary: string
  rawText: string
}

export function arrayBufferToBase64(buffer: ArrayBufferLike | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  const CHUNK_SIZE = 0x8000
  let index = 0
  let result = ''
  while (index < bytes.length) {
    const slice = bytes.subarray(index, Math.min(index + CHUNK_SIZE, bytes.length))
    result += String.fromCharCode.apply(null, slice as unknown as number[])
    index += CHUNK_SIZE
  }
  return btoa(result)
}

export function parseAiResponse(text: string): AiSummaryResult {
  let transcript = ''
  let summary = ''

  const summaryIndex = text.search(/(?:💡\s*\*{0,2}أهم النقاط|أهم النقاط:|الملخص:)/i)
  if (summaryIndex !== -1) {
    transcript = text.slice(0, summaryIndex).replace(/📝\s*\*{0,2}التفريغ النصي:?\*{0,2}/gi, '').trim()
    summary = text.slice(summaryIndex).replace(/(?:💡\s*\*{0,2}أهم النقاط:?\*{0,2}|الملخص:?)/gi, '').trim()
  } else {
    transcript = text.trim()
  }

  return {
    transcript,
    summary,
    rawText: text,
  }
}

/**
 * Transcribes and summarizes an audio/video buffer using Google Gemini API.
 */
export async function transcribeAndSummarizeAudio(
  audioBytes: ArrayBufferLike | Uint8Array,
  mimeType: string,
  env: Env,
): Promise<AiSummaryResult> {
  const apiKey = (env as Record<string, unknown>).GEMINI_API_KEY as string | undefined
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY_REQUIRED')
  }

  const base64Data = arrayBufferToBase64(audioBytes)

  const prompt = `أنت مساعد ذكي متخصص في التفريغ الصوتي والتلخيص.
المهمة:
1. قم بتفريغ هذا المقطع الصوتي بدقة بالغة باللغة الأصلية المنطوقة (مع التشكيل الخفيف إن كان عربياً).
2. قدّم ملخصاً سريعاً ومكثفاً في 3 نقاط رئيسية.

التنسيق المطلوب تماماً:
📝 **التفريغ النصي:**
(اكتب النص المفرغ كاملاً هنا)

💡 **أهم النقاط:**
• نقطة 1
• نقطة 2
• نقطة 3`

  // Use gemini-2.0-flash with fallback to gemini-1.5-flash
  const models = ['gemini-2.0-flash', 'gemini-1.5-flash']
  let lastError: Error | null = null

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

    const payload = {
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Data,
              },
            },
            { text: prompt },
          ],
        },
      ],
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(35_000),
      })

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Gemini API error (HTTP ${res.status}): ${errText.slice(0, 150)}`)
      }

      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      }
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (text) {
        return parseAiResponse(text)
      }
    } catch (err) {
      lastError = err as Error
    }
  }

  throw lastError || new Error('Failed to process audio with Gemini API.')
}
