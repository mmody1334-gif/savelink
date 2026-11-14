# savelink yt-dlp sidecar

Small FastAPI service that runs `yt-dlp` + `ffmpeg` and returns finished files.
The Worker uses it when `YTDLP_ENDPOINT` is set.

## Endpoints

```
GET  /health
POST /resolve   Authorization: Bearer $YTDLP_TOKEN
     { "url": "...", "mode": "video"|"audio", "quality": "720" }
GET  /media/{job}/{file}?t=$YTDLP_TOKEN
```

`mode: "audio"` always produces a 192 kbps MP3. `mode: "video"` merges the best
MP4 ≤ `quality` and falls back down the ladder.

## Run

```bash
docker build -t savelink-sidecar .
docker run --rm -p 8000:8000 \
  -e YTDLP_TOKEN=change-me \
  -e PUBLIC_URL=http://localhost:8000 \
  -v savelink-media:/data \
  savelink-sidecar
```

or from the repository root: `docker compose up --build`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `YTDLP_TOKEN` | empty | Bearer token; empty disables auth (not recommended) |
| `PUBLIC_URL` | empty | Prefix for returned media URLs |
| `MEDIA_DIR` | `/data` | Temporary download directory |
| `MEDIA_TTL_SECONDS` | `3600` | Files older than this are deleted |
| `MAX_FILESIZE_MB` | `400` | Hard cap passed to yt-dlp |
| `COOKIES_FILE` | empty | Netscape `cookies.txt` for private posts |
| `PROXY` | empty | Outbound proxy for yt-dlp |

## Instagram stories & highlights (`/ig/*`)

Instagram answers story data only to a logged-in web session and rejects plain
HTTP clients from datacenter IPs. Cloudflare Workers have neither a browser
TLS fingerprint nor a movable IP, so these endpoints do the request here with
`curl_cffi` (real Chrome fingerprint) behind an optional proxy.

```
GET /ig/whoami                             Authorization: Bearer $YTDLP_TOKEN
GET /ig/stories?username=natgeo
GET /ig/highlights?username=natgeo
GET /ig/highlight-items?id=highlight:17912345678901234
```

Responses are JSON: `{ items: [{kind,url,ext,mime,width,height,referer}] }` for
stories/highlight items and `{ highlights: [{id,title,count}] }` for the tray.
The Worker uses them automatically once `IG_ENDPOINT` (or `YTDLP_ENDPOINT`)
points at this service; `IG_TOKEN` falls back to `YTDLP_TOKEN`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `IG_COOKIE` | empty | full cookie header from a logged-in instagram.com tab (required) |
| `IG_PROXY` | empty | http(s) proxy for Instagram requests only |
| `IG_IMPERSONATE` | `chrome` | curl_cffi browser profile |
| `IG_STORIES_DOC_ID` | built-in | override the web GraphQL doc id when Instagram rotates it |
| `IG_HIGHLIGHTS_DOC_ID` | built-in | same, for the highlights tray |

Check the session before wiring it up:

```bash
curl -s -H "Authorization: Bearer $YTDLP_TOKEN" http://localhost:8000/ig/whoami
# {"ok":true,"username":"your_account","pk":123}
```

## Notes

- The free tiers of Render/Koyeb sleep; the first request after sleep is slow.
  The Worker's engine timeout falls back to the native extractors, so the bot
  keeps answering while the sidecar wakes up.
- Keep the service private if you can (Cloudflare Tunnel, Tailscale, or an
  allow-list for the Worker's egress) because a public `/resolve` is a free
  download API for anyone who finds it. `YTDLP_TOKEN` is the minimum.
