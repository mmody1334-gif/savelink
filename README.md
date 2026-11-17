# SaveLink — Telegram media bot

بوت تيليجرام يحوّل روابط **TikTok · Instagram · Facebook · Pinterest** إلى **MP4** أو **MP3**.
مبني على Cloudflare Workers + Hono، مع سلسلة محركات احتياطية حتى لا يتوقف البوت إذا فشل محرك.

A Telegram bot that turns TikTok / Instagram / Facebook / Pinterest links into MP4 or MP3.
Runs on Cloudflare Workers, with a fallback engine chain (native extractors → yt-dlp sidecar → cobalt).

---

## How it works

```
Telegram ──webhook──▶ Cloudflare Worker (Hono)
                        │
                        ├─ resolveMedia()  ── engine chain, first success wins
                        │     ├─ native   : TikTok (tikwm), Instagram (embed), Facebook (plugin), Pinterest (pin JSON)
                        │     ├─ ytdlp    : optional self-hosted sidecar (ffmpeg → real MP3, private posts)
                        │     └─ cobalt   : optional self-hosted cobalt API
                        │
                        ├─ signed /api/file?t=…  (1h HMAC URL, so raw CDN links never leak)
                        └─ Telegram sendVideo / sendAudio / sendPhoto (multipart upload)
```

Every engine is isolated: a timeout or a 403 only advances the chain. `ENGINE_ORDER` controls the order.

### Platform reality check

| Platform | Native (no setup) | Notes |
| --- | --- | --- |
| TikTok | ✅ works | tikwm returns watermark-free MP4 + the original MP3 track |
| Instagram post/reel | ⚠️ public reels/posts | anonymous API is 403; the embed page usually works. Private/age-gated posts need `IG_COOKIE` or the sidecar |
| Instagram profile (DP + photos) | ✅ works | avatar from the public embed; recent photos from each post's signed `display_url` (original resolution). HD avatar + full archive need `IG_COOKIE` — see [docs/instagram-profile.md](docs/instagram-profile.md) |
| Facebook | ✅ public videos/reels | public video plugin page; private posts need `FB_COOKIE` or the sidecar |
| Pinterest | ✅ video pins | parses the pin's `video_list` (720p/1080p MP4) |
| MP3 anywhere | ⚠️ | native MP3 only when the platform exposes an audio track (TikTok). Real MP3 from reels/facebook/pinterest needs the **yt-dlp sidecar** (ffmpeg) |

Cloudflare Workers cannot execute ffmpeg, which is why MP3 conversion is delegated to the sidecar. The sidecar is a ~90 MB Docker image you can host free on Render/Koyeb/Fly or on any VPS.

---

## Quick start

**One command (Windows):**

```powershell
.\scripts\install.ps1 -BotToken "123456:ABC..."
```

It checks Node, writes `.dev.vars`, installs dependencies, runs the tests, deploys
the Worker, uploads the secrets, registers the webhook and prints the `t.me` link.
Full walkthrough (Arabic) incl. manual setup and troubleshooting: **[INSTALL.md](INSTALL.md)**.

### 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
2. `cp .dev.vars.example .dev.vars` and fill `BOT_TOKEN`, `WEBHOOK_SECRET`, `SIGNING_SECRET`.

Generate the secrets with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Install and run locally

```powershell
cd savelink
npm install
npm run typecheck
npm test
npm run dev
```

Local dev needs a public URL for Telegram to reach the webhook. Use a tunnel:

```powershell
cloudflared tunnel --url http://localhost:8787
# set PUBLIC_BASE_URL to the printed https URL, then:
npm run tg:setup
```

### 3. Deploy to Cloudflare

```powershell
npx wrangler login
npx wrangler deploy
```

Then push the secrets and register the webhook:

```powershell
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put SIGNING_SECRET

# add PUBLIC_BASE_URL to .dev.vars (your https://<worker>.<subdomain>.workers.dev)
npm run tg:setup
```

Optional KV (recommended: keeps button state + rate limits across restarts):

```powershell
npx wrangler kv namespace create CACHE
# paste the printed id into wrangler.toml, uncomment [[kv_namespaces]]
npx wrangler deploy
```

Check it:

```powershell
curl https://<worker>.workers.dev/api/health
```

---

## Bot UX

- Send a link → the bot resolves it and replies with a summary + inline buttons:
  `📹 1080p · 6.1MB` `📹 720p · 15.5MB` `🎵 MP3 · 2.1MB` `🔗 تنزيل مباشر`
- Send an **Instagram profile link** (or `@username`) → profile picture + an album of the latest photos:
  `🖼 صورة الحساب · 150×150` `📥 صور الحساب (8)` `🔗 تنزيل مباشر`
- One-shot commands: `/mp3 <link>`, `/mp4 <link>`, `/dp @user`, `/photos @user`, `/story @user`, `/highlights @user`, `/help`, `/id`
- Arabic/English UI: picked from the user's Telegram language, or force it with `BOT_LOCALE=ar|en`
- Per-user rate limit, per-update dedupe (Telegram retries are ignored), 1-hour button TTL
- Files larger than `MAX_UPLOAD_MB` (default 45) are not uploaded; the bot replies with a signed direct-download link instead
- Albums are sent as Telegram media groups (≤10 photos per request; `PROFILE_MAX_ITEMS` caps the total at 30)

### Instagram profile downloader (DP + photos)

How it works, why the avatar is 150×150 without a session, and how the three
referenced sites are built — with real response codes from live tests:
**[docs/instagram-profile.md](docs/instagram-profile.md)** (Arabic).

Summary:

| What | Without `IG_COOKIE` | With `IG_COOKIE` |
| --- | --- | --- |
| Profile picture | 150×150 (Instagram's public embed) | `profile_pic_url_hd` |
| Photos | 6–17 latest public posts, original size (up to 1080 px wide) | same list, plus private accounts |
| Full archive | not possible | 📚 “All posts” button, 17 photos per tap until the account ends |
| Stories | not possible | `/story @user` or the 🟣 button on the profile card |
| Highlights | not possible | `/highlights @user`, then pick one from the list |

## Environment

| Secret / var | Required | Purpose |
| --- | --- | --- |
| `BOT_TOKEN` | yes | From @BotFather |
| `WEBHOOK_SECRET` | yes | Path segment + `X-Telegram-Bot-Api-Secret-Token` |
| `SIGNING_SECRET` | yes | HMAC key for `/api/file` download links |
| `PUBLIC_BASE_URL` | yes in prod | `https://<worker>.workers.dev` (used for signed links + webhook) |
| `YTDLP_ENDPOINT` | optional | Sidecar base URL, e.g. `https://savelink-sidecar.onrender.com` |
| `YTDLP_TOKEN` | optional | Shared bearer secret between Worker and sidecar |
| `IG_ENDPOINT` | optional | Sidecar base URL used for stories/highlights with a browser fingerprint (falls back to `YTDLP_ENDPOINT`) |
| `IG_TOKEN` | optional | Bearer secret for those calls (falls back to `YTDLP_TOKEN`) |
| `IG_API_KEY` | optional | Hosted Instagram API key (HikerAPI-style, `x-access-key`). When set it serves stories/highlights first — the only path that works without a cookie |
| `IG_API_BASE` | no | Provider base URL, default `https://api.hikerapi.com` (or `https://api.apify.com`) |
| `IG_PROVIDER` | no | `hikerapi` (default) or `apify` — Apify's free plan includes $5 of usage every month |
| `IG_APIFY_ACTOR` | no | Actor used for `apify`, default `lance_api~instagram-stories-highlights-scraper-api` |
| `COBALT_INSTANCES` | optional | Comma-separated self-hosted cobalt URLs (do not use `api.cobalt.tools`) |
| `COBALT_API_KEY` | optional | `Api-Key` for those instances |
| `IG_COOKIE` / `FB_COOKIE` / `PINTEREST_COOKIE` | optional | Session cookies for private/blocked posts, the Instagram HD avatar, the full archive, stories and highlights |
| `OWNER_ID` | required for kill-switch | Telegram user id of the owner. `/stopall` and `/resumeall` only work for this id; when unset nobody can use them (fail closed) |
| `GITHUB_TOKEN` | optional | Dispatches GitHub Actions cloud watchers/recorders; without it `/watch` only reports and never records |

> **Security:** the bot token never travels as a workflow input. The GitHub Actions workflows (`record.yml`, `trim.yml`, `frame.yml`) read `BOT_TOKEN` from the repository secret — set it in both `mmody1334-gif/savelink` and `mmody1334-gif/cb-recorder` (the dispatch target). The `/api/watch/status`, `/api/watch/check` and `/api/watch/cycle` endpoints require the `WEBHOOK_SECRET` (`X-Telegram-Bot-Api-Secret-Token` header or `Authorization: Bearer <secret>`). The sidecar `/record/*` endpoints require the `YTDLP_TOKEN` bearer from the Worker.
| `PROFILE_MAX_ITEMS` | no | Default `30`; max photos per Instagram profile request (clamped to 30) |
| `ENGINE_ORDER` | no | Default `ytdlp,native,cobalt` |
| `MAX_UPLOAD_MB` | no | Default `45` (Telegram Bot API limit) |
| `MAX_PROXY_MB` | no | Default `200` (signed download proxy cap) |
| `RATE_LIMIT_PER_MIN` | no | Default `12` requests/user/minute |
| `BOT_USERNAME`, `BOT_LOCALE` | no | Branding + language override |

---

## yt-dlp sidecar (the MP3 + private-posts engine)

```powershell
# local
$env:YTDLP_TOKEN="change-me"
docker compose up --build
# -> http://localhost:8000
```

Deploy options:

- **Render**: New → Web Service → Docker → repo root, Dockerfile path `sidecar/Dockerfile`, env `YTDLP_TOKEN`, `PUBLIC_URL=https://<service>.onrender.com`. Free instance sleeps after 15 min; the first request after sleep takes ~30 s.
- **Koyeb / Fly.io**: same Dockerfile, expose port 8000, set `PUBLIC_URL` to the public HTTPS URL.
- **Own VPS**: `docker compose up -d --build`, put it behind Caddy/nginx with HTTPS.

Then:

```powershell
npx wrangler secret put YTDLP_ENDPOINT   # https://<sidecar>
npx wrangler secret put YTDLP_TOKEN      # same value as the sidecar
```

Optional environment for the sidecar: `COOKIES_FILE` (Netscape cookies.txt for private posts), `PROXY`, `MEDIA_TTL_SECONDS` (default 3600), `MAX_FILESIZE_MB`.

> If the sidecar sleeps or times out, the Worker simply falls through to the native engine — that is the "backup" behaviour you asked for.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `BOT_TOKEN is not configured` | `wrangler secret put BOT_TOKEN`, redeploy |
| Bot never answers | `npm run tg:setup` again; check `curl https://<worker>/api/health`; check `wrangler tail` |
| "Instagram extraction failed" | add `IG_COOKIE` (`sessionid=…; ds_user_id=…`) or deploy the sidecar |
| "Instagram profile: private or not found" | the account is private, renamed, or the embed is blocked for your Worker's IP — retry, or use `IG_COOKIE` for private accounts |
| Profile picture is only 150×150 | that is Instagram's anonymous limit; set `IG_COOKIE` to unlock `profile_pic_url_hd` |
| Only 6–17 profile photos arrive | that is everything Instagram shows anonymous visitors; older posts are not public |
| "Facebook … no video sources" | private/region-locked video: `FB_COOKIE` or sidecar |
| MP3 button says "not available here" | TikTok-only for native MP3; deploy the sidecar for real MP3 everywhere |
| Telegram says file is too big | raise `MAX_UPLOAD_MB` only on Workers Paid, or use the direct-download button (Telegram Bot API caps uploads at 50 MB / 2000 MB with a local Bot API server) |
| `429` / rate limit messages | raise `RATE_LIMIT_PER_MIN`, add the KV namespace |

## Limits & good practice

- The Worker proxies files it uploads to Telegram. Cloudflare Workers Free has a small CPU budget; large uploads may need Workers Paid or a larger `MAX_UPLOAD_MB` on a paid plan.
- Public CDN URLs are short-lived; buttons expire after 1 hour (`⌛` message tells the user to resend).
- `/api/file` only serves URLs we signed — it is not an open proxy.
- Native extractors depend on public pages and can break when a platform changes markup; the sidecar (yt-dlp) is the long-term reliable path.

## Legal

Use this only for content you own or have permission to download. Respect each platform's Terms of Service and local copyright law. The bot stores no media; files are streamed through the Worker and the sidecar deletes its temporary files after `MEDIA_TTL_SECONDS`.
