export class ResolveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message)
    this.name = 'ResolveError'
  }
}

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly engine: string,
    public readonly retryable = true,
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}
