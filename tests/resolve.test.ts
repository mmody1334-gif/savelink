import { describe, expect, it } from 'vitest'
import { resolveMedia } from '../src/resolve'
import type { Env } from '../src/types'

const env: Env = {}

describe('resolveMedia', () => {
  it('rejects unsupported hosts without calling an engine', async () => {
    await expect(resolveMedia({ url: 'https://example.com/video', mode: 'video', quality: '720' }, env)).rejects.toMatchObject({
      code: 'unsupported_url',
    })
  })

  it('rejects empty input', async () => {
    await expect(resolveMedia({ url: '', mode: 'video', quality: '720' }, env)).rejects.toMatchObject({
      code: 'unsupported_url',
    })
  })
})
