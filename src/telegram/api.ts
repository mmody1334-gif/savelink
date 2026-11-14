export class TelegramError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message)
    this.name = 'TelegramError'
  }
}

interface TelegramResponse<T> {
  ok: boolean
  result: T
  description?: string
  error_code?: number
}

export interface MultipartFile {
  field: string
  blob: Blob
  filename: string
}

/**
 * Minimal Bot API client. Uses JSON for plain calls and multipart/form-data
 * whenever a Blob is present, so files stream straight from the CDN upload.
 */
export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly base = 'https://api.telegram.org',
  ) {}

  private async dispatch<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, init)
    let payload: TelegramResponse<T>
    try {
      payload = (await response.json()) as TelegramResponse<T>
    } catch {
      throw new TelegramError(`Telegram returned HTTP ${response.status}`, response.status)
    }
    if (!payload?.ok) {
      throw new TelegramError(
        payload?.description ?? `Telegram returned HTTP ${response.status}`,
        payload?.error_code ?? response.status,
      )
    }
    return payload.result
  }

  async call<T = unknown>(
    method: string,
    body: Record<string, unknown> = {},
    options: { filename?: string } = {},
  ): Promise<T> {
    const url = `${this.base}/bot${this.token}/${method}`
    const hasFile = Object.values(body).some((value) => value instanceof Blob)

    if (hasFile) {
      const form = new FormData()
      for (const [key, value] of Object.entries(body)) {
        if (value === undefined || value === null) continue
        if (value instanceof Blob) form.set(key, value, options.filename ?? 'file')
        else if (typeof value === 'object') form.set(key, JSON.stringify(value))
        else form.set(key, String(value))
      }
      return await this.dispatch<T>(url, { method: 'POST', body: form })
    }

    return await this.dispatch<T>(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** One request with several named file parts (used by sendMediaGroup). */
  async multipart<T = unknown>(
    method: string,
    fields: Record<string, unknown>,
    files: MultipartFile[],
  ): Promise<T> {
    const url = `${this.base}/bot${this.token}/${method}`
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue
      if (typeof value === 'object') form.set(key, JSON.stringify(value))
      else form.set(key, String(value))
    }
    for (const file of files) form.set(file.field, file.blob, file.filename)
    return await this.dispatch<T>(url, { method: 'POST', body: form })
  }

  /** Edits that would be no-ops are ignored instead of surfacing as failures. */
  async safeEdit(method: 'editMessageText' | 'editMessageCaption', body: Record<string, unknown>): Promise<void> {
    try {
      await this.call(method, body)
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : ''
      if (message.includes('not modified') || message.includes('message to edit not found')) return
      throw error
    }
  }
}
