export type Platform =
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'pinterest'
  | 'youtube'
  | 'coomer'
  | 'erome'
  | 'bunkr'
  | 'unknown'

export type Mode = 'video' | 'audio'

export type Quality = 'max' | '1080' | '720' | '480' | '360' | '240' | '320' | '192' | '128'

export type MediaKind = 'video' | 'audio' | 'image'

export interface MediaItem {
  kind: MediaKind
  /** Direct upstream URL (CDN). Never exposed to end users unsigned. */
  url: string
  ext: string
  mime: string
  width?: number
  height?: number
  size?: number
  label?: string
  referer?: string
  note?: string
}

export interface MediaResult {
  platform: Platform
  sourceUrl: string
  title?: string
  author?: string
  thumbnail?: string
  /** seconds */
  duration?: number
  items: MediaItem[]
  engine: string
  warnings?: string[]
}

export interface ResolveInput {
  url: string
  mode: Mode
  quality: Quality
}

export interface Engine {
  name: string
  available(env: Env): boolean
  supports(platform: Platform): boolean
  resolve(input: ResolveInput, env: Env): Promise<MediaResult>
}

export interface Env {
  BOT_TOKEN?: string
  WEBHOOK_SECRET?: string
  SIGNING_SECRET?: string
  PUBLIC_BASE_URL?: string
  BOT_USERNAME?: string
  BOT_LOCALE?: string
  ENGINE_ORDER?: string
  MAX_UPLOAD_MB?: string
  MAX_PROXY_MB?: string
  PROFILE_MAX_ITEMS?: string
  RATE_LIMIT_PER_MIN?: string
  YTDLP_ENDPOINT?: string
  IG_ENDPOINT?: string
  IG_TOKEN?: string
  IG_API_KEY?: string
  IG_API_BASE?: string
  IG_PROVIDER?: string
  IG_APIFY_ACTOR?: string
  IG_APIFY_POSTS_ACTOR?: string
  PROFILE_SOURCE?: string
  RECORDER_ENDPOINT?: string
  GITHUB_TOKEN?: string
  GITHUB_RECORDER_REPO?: string
  YTDLP_TOKEN?: string
  COBALT_INSTANCES?: string
  COBALT_API_KEY?: string
  IG_COOKIE?: string
  FB_COOKIE?: string
  PINTEREST_COOKIE?: string
  ASSETS?: Fetcher
  CACHE?: KVNamespace
}
