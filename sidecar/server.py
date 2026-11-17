"""savelink yt-dlp sidecar.

Cloudflare Workers cannot run ffmpeg, so this tiny service does the heavy
lifting when you need a real MP3 or a platform extractor that needs cookies.

Endpoints
  POST /resolve  { url, mode: "video"|"audio", quality: "720" }
  GET  /media/{job}/{name}
  GET  /health
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import quote

import yt_dlp
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel

from instagram import router as instagram_router
from recorder import start_recording, stop_recording, list_active_recordings

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "/data"))
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

TTL_SECONDS = int(os.getenv("MEDIA_TTL_SECONDS", "3600"))
MAX_FILESIZE = int(os.getenv("MAX_FILESIZE_MB", "400")) * 1024 * 1024
TOKEN = os.getenv("YTDLP_TOKEN", "")
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")

app = FastAPI(title="savelink-ytdlp")
app.include_router(instagram_router)


class ResolveRequest(BaseModel):
    url: str
    mode: Literal["video", "audio"] = "video"
    quality: str = "720"


class RecordRequest(BaseModel):
    url: str
    chat_id: int | str
    bot_token: Optional[str] = ""


class StopRequest(BaseModel):
    url: str


def _kind_and_mime(path: Path) -> Optional[tuple[str, str]]:
    ext = path.suffix.lower()
    if ext in (".mp4", ".mov"):
        return "video", "video/mp4"
    if ext in (".mkv",):
        return "video", "video/x-matroska"
    if ext in (".webm",):
        return "video", "video/webm"
    if ext in (".mp3",):
        return "audio", "audio/mpeg"
    if ext in (".m4a", ".aac"):
        return "audio", "audio/mp4"
    if ext in (".opus", ".ogg"):
        return "audio", "audio/ogg"
    if ext in (".wav",):
        return "audio", "audio/wav"
    if ext in (".jpg", ".jpeg"):
        return "image", "image/jpeg"
    if ext in (".webp",):
        return "image", "image/webp"
    if ext in (".png",):
        return "image", "image/png"
    return None


def _cleanup_loop() -> None:
    while True:
        now = time.time()
        for entry in MEDIA_DIR.iterdir():
            try:
                if entry.is_dir() and now - entry.stat().st_mtime > TTL_SECONDS:
                    shutil.rmtree(entry, ignore_errors=True)
            except OSError:
                pass
        time.sleep(300)


threading.Thread(target=_cleanup_loop, daemon=True).start()


def _authorize(authorization: str) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


@app.get("/health")
def health() -> dict:
    return {"ok": True, "service": "savelink-ytdlp", "version": yt_dlp.version.__version__}


@app.post("/record/start")
def api_record_start(req: RecordRequest, authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    # The bot token is no longer accepted over the wire: the sidecar reads
    # BOT_TOKEN from its own environment (Render env var).
    res = start_recording(req.url, req.chat_id, req.bot_token or os.getenv("BOT_TOKEN", ""))
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res


@app.post("/record/stop")
def api_record_stop(req: StopRequest, authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    res = stop_recording(req.url)
    if not res.get("ok"):
        raise HTTPException(status_code=400, detail=res.get("error"))
    return res


@app.get("/record/status")
def api_record_status(authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    return list_active_recordings()


@app.post("/resolve")
def resolve(request: ResolveRequest, authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    if not request.url.startswith(("http://", "https://")):
        raise HTTPException(status_code=422, detail="invalid url")

    job = uuid.uuid4().hex
    job_dir = MEDIA_DIR / job
    job_dir.mkdir(parents=True, exist_ok=True)

    quality = request.quality if request.quality.isdigit() else "720"
    options: dict = {
        "outtmpl": str(job_dir / "%(id)s.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": True,
        "max_filesize": MAX_FILESIZE,
        "retries": 2,
        "socket_timeout": 20,
        "nocheckcertificate": True,
    }

    if request.mode == "audio":
        options["format"] = "bestaudio/best"
        options["postprocessors"] = [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}
        ]
    else:
        options["format"] = (
            f"bv*[height<={quality}][ext=mp4]+ba[ext=m4a]/"
            f"b[height<={quality}][ext=mp4]/"
            f"bv*[height<={quality}]+ba/"
            f"b[height<={quality}]/b"
        )
        options["merge_output_format"] = "mp4"

    cookiefile = os.getenv("COOKIES_FILE")
    if cookiefile:
        options["cookiefile"] = cookiefile
    proxy = os.getenv("PROXY")
    if proxy:
        options["proxy"] = proxy

    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(request.url, download=True)
    except Exception as error:  # yt-dlp raises many exception types
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(error)[:500]) from error

    items = []
    for path in sorted(job_dir.iterdir()):
        if not path.is_file() or path.suffix in (".part", ".ytdl"):
            continue
        meta = _kind_and_mime(path)
        if not meta:
            continue
        kind, mime = meta
        if kind == "video" and request.mode == "audio":
            continue
        url = f"/media/{job}/{quote(path.name)}"
        if TOKEN:
            url = f"{url}?t={quote(TOKEN)}"
        if PUBLIC_URL:
            url = f"{PUBLIC_URL}{url}"
        items.append(
            {
                "kind": kind,
                "url": url,
                "ext": path.suffix.lstrip(".").lower(),
                "mime": mime,
                "size": path.stat().st_size,
                "label": f"{quality}p" if kind == "video" else None,
            }
        )

    if not items:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail="no media produced")

    return {
        "title": info.get("title"),
        "author": info.get("uploader") or info.get("channel"),
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "items": items,
    }


@app.get("/media/{job}/{name}")
def media(job: str, name: str, t: str = Query(default="")) -> FileResponse:
    if TOKEN and t != TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")
    if not re.fullmatch(r"[a-f0-9]{32}", job):
        raise HTTPException(status_code=400, detail="bad job id")
    if Path(name).name != name:
        raise HTTPException(status_code=400, detail="bad file name")

    path = MEDIA_DIR / job / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="not found")

    meta = _kind_and_mime(path)
    return FileResponse(path, media_type=meta[1] if meta else "application/octet-stream", filename=name)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)

