"""Live Stream Recorder Daemon & Multi-Host Uploader (Chaturbate & TikTok Live).

Records live streams in the background, finalizes the MP4 when stopped or
when the broadcast ends, uploads the result to high-capacity hosting (Gofile / Pixeldrain / Local),
and sends the download link directly to the user's Telegram chat.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
import urllib.request
import urllib.parse

logger = logging.getLogger("recorder")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "./recordings_data"))
RECORDINGS_DIR = MEDIA_DIR / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

# Active recording jobs: identifier -> RecordingJob
active_jobs: Dict[str, "RecordingJob"] = {}
jobs_lock = threading.Lock()

CB_IMPERSONATE_TARGETS = [
    "safari17_0",
    "safari15_5",
    "safari15_3",
    "chrome110",
    "chrome116",
    "edge101",
    "chrome120",
]


def resolve_chaturbate_stream(model: str) -> Dict[str, Any]:
    """
    Directly resolves Chaturbate live stream HLS/LL-HLS endpoints using curl_cffi
    with proven browser TLS fingerprints and Origin/Referer headers.
    """
    try:
        import curl_cffi.requests as creq
    except ImportError:
        return {"ok": False, "room_status": "unknown", "error": "curl_cffi not installed"}

    last_status = "unknown"
    for tld in ["com", "eu", "global"]:
        for imp in CB_IMPERSONATE_TARGETS:
            try:
                s = creq.Session(impersonate=imp)
                headers = {
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "application/json",
                    "Origin": f"https://chaturbate.{tld}",
                    "Referer": f"https://chaturbate.{tld}/{model}/",
                }
                r = s.post(
                    f"https://chaturbate.{tld}/get_edge_hls_url_ajax/",
                    data={"room_slug": model},
                    headers=headers,
                    timeout=10,
                )
                if r.status_code != 200 or not r.text.strip().startswith("{"):
                    continue

                data = r.json()
                room_status = (data.get("room_status") or "").strip().lower()
                m3u8_url = (data.get("url") or "").strip()

                if room_status:
                    last_status = room_status

                if not m3u8_url:
                    if room_status in ("offline", "private", "away", "hidden", "password protected"):
                        return {"ok": False, "room_status": room_status}
                    continue

                # Return the master m3u8 playlist URL directly!
                # Do NOT dissect it into sub-rendition chunklists with ephemeral session tokens,
                # as direct chunk requests cause 403 Forbidden on edge CDN.
                return {
                    "ok": True,
                    "room_status": "public",
                    "video_url": m3u8_url,
                    "audio_url": None,
                    "tld": tld,
                }
            except Exception as e:
                logger.debug(f"Chaturbate resolve attempt ({tld}/{imp}) error: {e}")
                continue

    # Fallback resolver: yt-dlp native extraction
    try:
        from yt_dlp import YoutubeDL
        ydl = YoutubeDL({"quiet": True, "no_warnings": True})
        info = ydl.extract_info(f"https://chaturbate.com/{model}/", download=False)
        if info and info.get("is_live") and info.get("url"):
            return {
                "ok": True,
                "room_status": "public",
                "video_url": info["url"],
                "audio_url": None,
                "tld": "com",
            }
    except Exception as e:
        err_msg = str(e).lower()
        if "offline" in err_msg:
            return {"ok": False, "room_status": "offline"}
        if "private" in err_msg:
            return {"ok": False, "room_status": "private"}
        if "away" in err_msg:
            return {"ok": False, "room_status": "away"}

    return {"ok": False, "room_status": last_status}


def resolve_tiktok_stream(target: str) -> Dict[str, Any]:
    """
    Directly resolves TikTok live stream high-bitrate continuous FLV stream URL
    using TikTok Webcast API and yt-dlp fallback.
    Prevents the 3-second HLS manifest cutoff bug.
    """
    clean = target.strip()
    if "tiktok.com" in clean:
        m = re.search(r"@([a-zA-Z0-9_.-]+)", clean)
        user = m.group(1) if m else clean
    else:
        user = clean.lstrip("@").strip()

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.tiktok.com/",
    }

    # Method 1: Webcast API via curl_cffi (Fastest & direct FLV pull URL)
    try:
        import curl_cffi.requests as creq
        s = creq.Session(impersonate="chrome120")
        page_url = f"https://www.tiktok.com/@{user}/live"
        r = s.get(page_url, headers=headers, timeout=12)
        room_id = None
        m_id = re.search(r'\"roomId\":\"(\d+)\"', r.text)
        if m_id:
            room_id = m_id.group(1)
        if not room_id:
            m_id = re.search(r'\"room_id\":(\d+)', r.text)
            if m_id:
                room_id = m_id.group(1)

        if room_id:
            api_url = f"https://webcast.tiktok.com/webcast/room/info/?aid=1988&room_id={room_id}"
            r_api = s.get(api_url, headers=headers, timeout=10)
            if r_api.status_code == 200:
                data = r_api.json().get("data", {})
                status = data.get("status")
                logger.info(f"TikTok Webcast status for {user}: {status} (room {room_id})")
                if status == 2:  # LIVE
                    st_data = data.get("stream_url", {})
                    flv_pull = st_data.get("flv_pull_url", {})
                    chosen = (
                        flv_pull.get("FULL_HD1")
                        or flv_pull.get("HD1")
                        or flv_pull.get("SD1")
                        or (next(iter(flv_pull.values())) if flv_pull else None)
                    )
                    if not chosen:
                        # Check live_core_sdk_data
                        try:
                            sdk_data = st_data.get("live_core_sdk_data", {}).get("pull_data", {}).get("stream_data")
                            if sdk_data:
                                parsed = json.loads(sdk_data)
                                s_dict = parsed.get("data", {})
                                for q in ["origin", "uhd", "hd", "sd", "ld"]:
                                    if q in s_dict and s_dict[q].get("main", {}).get("flv"):
                                        chosen = s_dict[q]["main"]["flv"]
                                        break
                        except Exception:
                            pass
                    if not chosen:
                        chosen = st_data.get("hls_pull_url")

                    if chosen:
                        return {
                            "ok": True,
                            "stream_url": chosen,
                            "room_status": "live",
                            "title": data.get("title", ""),
                            "user": user,
                        }
                elif status in (4, None):
                    return {"ok": False, "room_status": "offline", "user": user}
    except Exception as e:
        logger.warning(f"TikTok Webcast API attempt for {user} failed: {e}")

    # Method 2: yt-dlp -g with explicit FLV preference
    try:
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--impersonate", "chrome",
            "-g",
            "-f", "best[ext=flv]/best[protocol^=http]/best",
            f"https://www.tiktok.com/@{user}/live"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
        url = res.stdout.strip().split("\n")[0].strip()
        if res.returncode == 0 and url.startswith("http"):
            return {
                "ok": True,
                "stream_url": url,
                "room_status": "live",
                "user": user,
            }
        else:
            if "not currently live" in res.stderr.lower() or "room is offline" in res.stderr.lower():
                return {"ok": False, "room_status": "offline", "user": user}
    except Exception as e:
        logger.warning(f"TikTok yt-dlp -g attempt for {user} failed: {e}")

    return {"ok": False, "room_status": "offline", "user": user}


def resolve_stripchat_stream(target: str) -> Dict[str, Any]:
    """
    Direct native Stripchat resolver.
    Checks model live status, private/group show state, and verifies live HLS stream.
    """
    clean = target.strip()
    m = re.search(r"stripchat\.(?:com|org|me|cc)/(?:[a-z]{2}/)?([a-zA-Z0-9_.-]+)", clean, re.I)
    username = m.group(1) if m else clean
    username = re.sub(r"/(?:videos?|vod|clips?|archive)/?$", "", username, flags=re.I)

    try:
        from yt_dlp import YoutubeDL
        from yt_dlp.extractor.stripchat import StripchatIE, lowercase_escape
        from yt_dlp.utils import traverse_obj

        ydl = YoutubeDL({"quiet": True, "no_warnings": True})
        ie = StripchatIE(ydl)
        url = f"https://stripchat.com/{username}"
        webpage = ie._download_webpage(url, username, headers=ie.geo_verification_headers())
        data = ie._search_json(
            r'<script\b[^>]*>\s*window\.__PRELOADED_STATE__\s*=',
            webpage, 'data', username, transform_source=lowercase_escape)

        model_id = traverse_obj(data, ('viewCam', 'model', 'id'))
        is_live = traverse_obj(data, ('viewCam', 'model', 'isLive'))
        model_status = str(traverse_obj(data, ('viewCam', 'model', 'status')) or '').lower()
        show_obj = traverse_obj(data, ('viewCam', 'show', {dict}))

        # 1. Check if offline
        if not is_live or model_status in ("off", "offline"):
            return {
                "ok": False,
                "room_status": "offline",
                "model_id": model_id,
                "error": "البث مغلق حالياً (Offline)",
            }

        # 2. Check if model is in Private / GroupShow / Ticket show
        is_private_show = False
        show_mode = ""
        if model_status and model_status not in ("public", "idle", "off", "offline"):
            is_private_show = True
            show_mode = model_status

        if isinstance(show_obj, dict):
            sm = str(show_obj.get("mode", "")).lower()
            ended_at = show_obj.get("endedAt")
            if sm and not ended_at:
                is_private_show = True
                show_mode = sm

        if is_private_show:
            label = "عرض خاص / تذاكر (Private / Group Show)" if "group" in show_mode else "عرض خاص مشفر (Private Show / PVT)"
            logger.info(f"Stripchat model {username} is in private/ticket show: {show_mode}")
            return {
                "ok": False,
                "room_status": "private",
                "show_mode": show_mode,
                "model_id": model_id,
                "error": f"الموديل حالياً في {label} مشفر يتطلب توكنات للدخول",
            }

        # 3. Model is live and in public mode: resolve verified live HLS stream
        if model_id:
            candidates = [
                f"https://edge-hls.doppiocdn.com/hls/{model_id}/master/{model_id}_auto.m3u8",
                f"https://b-hls-11.doppiocdn.com/hls/{model_id}/master/{model_id}_auto.m3u8",
                f"https://b-hls-12.doppiocdn.com/hls/{model_id}/master/{model_id}_auto.m3u8",
                f"https://b-hls-1.doppiocdn.com/hls/{model_id}/master/{model_id}_auto.m3u8",
            ]
            for c_url in candidates:
                try:
                    req = urllib.request.Request(c_url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        if resp.status == 200:
                            body = resp.read().decode("utf-8", errors="replace")
                            # Verify if it's not a static advert loop
                            if "#EXT-X-MOUFLON-ADVERT" in body and "#EXT-X-ENDLIST" in body:
                                logger.warning(f"Stripchat master playlist for {username} returned advert preview only.")
                                continue
                            logger.info(f"Stripchat verified live master HLS: {c_url}")
                            return {
                                "ok": True,
                                "room_status": "public",
                                "stream_url": c_url,
                                "model_id": model_id,
                            }
                except Exception:
                    continue

            # Fallback if primary candidate was available
            if model_status == "public":
                return {
                    "ok": True,
                    "room_status": "public",
                    "stream_url": f"https://edge-hls.doppiocdn.com/hls/{model_id}/master/{model_id}_auto.m3u8",
                    "model_id": model_id,
                }
    except Exception as e:
        logger.warning(f"Stripchat direct resolve error for {username}: {e}")

    return {"ok": False, "room_status": "offline", "error": "تعذر الاتصال بسيرفر البث"}


def parse_stream_target(target: str) -> Tuple[str, str, str]:
    """
    Parses input and returns (platform, identifier, stream_url).
    platform: 'tiktok' | 'chaturbate' | 'universal'
    """
    clean = target.strip()
    if not clean:
        return "universal", "stream", ""

    # Check if target is a web URL without http(s) prefix (e.g. stripchat.com/user, kick.com/user, twitch.tv/user)
    if not clean.startswith("http://") and not clean.startswith("https://"):
        if any(clean.lower().startswith(p) for p in ("www.", "stripchat.", "twitch.tv", "kick.com", "youtube.com", "bongacams.", "cam4.", "camsoda.")):
            clean = f"https://{clean}"
        elif "/" in clean and "." in clean.split("/")[0]:
            clean = f"https://{clean}"

    # 1. TikTok short or live URL
    if "tiktok.com" in clean:
        if "vt.tiktok.com" in clean or "vm.tiktok.com" in clean or "/t/" in clean:
            try:
                req = urllib.request.Request(
                    clean,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                    },
                )
                with urllib.request.urlopen(req, timeout=10) as resp:
                    clean = resp.geturl()
            except Exception as e:
                logger.warning(f"Could not resolve short TikTok URL redirect: {e}")

        m = re.search(r"@([a-zA-Z0-9_.-]+)", clean)
        user = m.group(1) if m else "tiktok_live"
        live_url = clean if "/live" in clean else f"https://www.tiktok.com/@{user}/live"
        return "tiktok", user, live_url

    # 2. Starts with @ (e.g. @shad.208) -> TikTok live
    if clean.startswith("@"):
        user = clean.lstrip("@").strip()
        return "tiktok", user, f"https://www.tiktok.com/@{user}/live"

    # 3. Chaturbate URL
    cb_match = re.search(r"chaturbate\.(?:com|eu|global)/(?:b/)?([a-zA-Z0-9_.-]+)", clean, re.I)
    if cb_match:
        model = cb_match.group(1).lower()
        return "chaturbate", model, f"https://chaturbate.com/{model}/"

    # 4. Stripchat URL
    sc_match = re.search(r"stripchat\.(?:com|org|me|cc)/(?:[a-z]{2}/)?([a-zA-Z0-9_.-]+)", clean, re.I)
    if sc_match:
        model = sc_match.group(1).lower()
        model = re.sub(r"/(?:videos?|vod|clips?|archive)/?$", "", model, flags=re.I)
        return "stripchat", f"stripchat_{model}", f"https://stripchat.com/{model}"

    # 5. Universal Live Stream URL (Any HTTP/HTTPS URL on the web)
    if clean.startswith("http://") or clean.startswith("https://"):
        # Normalize: strip trailing /videos, /vod, /clips from profile stream URLs
        clean_url = re.sub(r"/(?:videos?|vod|clips?|archive)/?$", "", clean, flags=re.I)
        parsed = urllib.parse.urlparse(clean_url)
        domain = parsed.netloc.lower().replace("www.", "")
        domain_tag = domain.split(".")[0]

        # Extract meaningful channel name / path slug
        path_parts = [p for p in parsed.path.strip("/").split("/") if p and p.lower() not in ("live", "c", "channel", "u", "user", "p")]
        channel_name = path_parts[-1] if path_parts else domain_tag
        ident = f"{domain_tag}_{channel_name}"
        ident = re.sub(r"[^a-zA-Z0-9_-]", "_", ident)[:50]
        return "universal", ident, clean_url

    # 5. Default alphanumeric: assume Chaturbate model name
    if re.fullmatch(r"[a-zA-Z0-9_.-]{3,60}", clean):
        return "chaturbate", clean.lower(), f"https://chaturbate.com/{clean.lower()}/"

    # 6. Fallback safe slug
    safe_slug = re.sub(r"[^a-zA-Z0-9_-]", "_", clean)[:40] or "stream"
    return "universal", safe_slug, clean


def upload_to_gofile(file_path: Path) -> Optional[str]:
    """Uploads to Gofile (supports unlimited size, fast & reliable)."""
    try:
        server_req = urllib.request.Request(
            "https://api.gofile.io/servers",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"},
        )
        with urllib.request.urlopen(server_req, timeout=15) as resp:
            s_data = json.loads(resp.read().decode())
            servers = s_data.get("data", {}).get("servers", [])
            server = servers[0].get("name", "store1") if servers else "store1"

        upload_url = f"https://{server}.gofile.io/contents/uploadfile"
        curl_cmd = [
            "curl",
            "-s",
            "-X", "POST",
            "-F", f"file=@{str(file_path)}",
            upload_url,
        ]
        res = subprocess.run(curl_cmd, capture_output=True, text=True, timeout=600)
        if res.returncode == 0:
            up_data = json.loads(res.stdout)
            page_link = up_data.get("data", {}).get("downloadPage")
            if page_link:
                return page_link
    except Exception as e:
        logger.error(f"Failed to upload to Gofile: {e}")
    return None


def upload_to_pixeldrain(file_path: Path) -> Optional[str]:
    """Uploads file to Pixeldrain (supports up to 10GB per file)."""
    try:
        filename = file_path.name
        url = f"https://pixeldrain.com/api/file/{urllib.parse.quote(filename)}"
        req = urllib.request.Request(
            url,
            method="PUT",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) savelink-recorder/1.0"},
        )
        with open(file_path, "rb") as f:
            with urllib.request.urlopen(req, data=f, timeout=600) as resp:
                data = json.loads(resp.read().decode())
                file_id = data.get("id")
                if file_id:
                    return f"https://pixeldrain.com/u/{file_id}"
    except Exception as e:
        logger.error(f"Failed to upload to Pixeldrain: {e}")
    return None


def send_telegram_video(bot_token: str, chat_id: int | str, video_path: Path, caption: str) -> bool:
    """Sends video file directly to Telegram chat via multipart curl (works up to 50MB)."""
    if not bot_token or not chat_id or str(chat_id) == "0" or not video_path.exists():
        return False
    try:
        url = f"https://api.telegram.org/bot{bot_token}/sendVideo"
        curl_cmd = [
            "curl",
            "-s",
            "-X", "POST",
            url,
            "-F", f"chat_id={chat_id}",
            "-F", f"video=@{str(video_path)}",
            "-F", f"caption={caption}",
            "-F", "parse_mode=HTML",
            "-F", "supports_streaming=true",
        ]
        res = subprocess.run(curl_cmd, capture_output=True, text=True, timeout=180)
        if res.returncode == 0 and '"ok":true' in res.stdout:
            logger.info(f"Direct video successfully sent to Telegram chat {chat_id}")
            return True
        else:
            logger.warning(f"Direct video upload failed: {res.stdout[:200]}")
    except Exception as e:
        logger.error(f"Failed sending video to Telegram: {e}")
    return False


def create_preview_clip(input_path: Path, output_preview_path: Path, duration_sec: int = 30) -> bool:
    """Creates a fast 30-second low-bitrate preview clip using ffmpeg for Telegram preview."""
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-ss", "00:00:05",
            "-i", str(input_path),
            "-t", str(duration_sec),
            "-vf", "scale=-2:480",
            "-c:v", "libx264",
            "-b:v", "500k",
            "-preset", "veryfast",
            "-c:a", "aac",
            "-b:a", "64k",
            str(output_preview_path),
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        return res.returncode == 0 and output_preview_path.exists() and output_preview_path.stat().st_size > 10 * 1024
    except Exception as e:
        logger.error(f"Failed to create preview clip: {e}")
        return False


def notify_telegram(bot_token: str, chat_id: int | str, text: str, download_url: Optional[str] = None) -> None:
    """Send completion notification to user with direct download button."""
    if not bot_token or not chat_id or str(chat_id) == "0":
        return
    try:
        payload: Dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
        }
        if download_url:
            payload["reply_markup"] = {
                "inline_keyboard": [
                    [{"text": "🚀 تحميل ومشاهدة البث المسجل", "url": download_url}],
                ]
            }
        
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            headers={"Content-Type": "application/json"},
            data=json.dumps(payload).encode("utf-8"),
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as e:
        logger.error(f"Failed to send Telegram notification: {e}")


class RecordingJob:
    def __init__(self, platform: str, identifier: str, stream_url: str, chat_id: int | str, bot_token: str = ""):
        self.platform = platform
        self.identifier = identifier
        self.stream_url = stream_url
        self.chat_id = chat_id
        self.bot_token = bot_token
        self.start_time = time.time()
        self.stop_requested = False
        self.process: Optional[subprocess.Popen] = None
        
        now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.filename = f"{self.platform}_{self.identifier}_{now_str}.mp4"
        self.output_path = RECORDINGS_DIR / self.filename
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.final_url: Optional[str] = None
        self.error: Optional[str] = None

    def start(self):
        self.thread.start()

    def _poll_remote_stop(self):
        """Polls Cloudflare Worker signal to gracefully stop when user clicks Stop in Telegram."""
        worker_base = os.getenv("WORKER_URL", "https://savelink.hudhaifa-bio.workers.dev").rstrip("/")
        targets = [self.identifier]
        if "_" in self.identifier:
            targets.append(self.identifier.split("_")[-1])
        while not self.stop_requested and (self.process is None or self.process.poll() is None):
            for tgt in targets:
                try:
                    poll_url = f"{worker_base}/api/record/signal?target={urllib.parse.quote(tgt)}"
                    req = urllib.request.Request(poll_url, headers={"User-Agent": "SaveLink-Recorder/1.0"})
                    with urllib.request.urlopen(req, timeout=5) as resp:
                        data = json.loads(resp.read().decode())
                        if data.get("stop"):
                            logger.info(f"Stop signal received for {tgt}. Stopping recording gracefully...")
                            self.stop()
                            return
                except Exception:
                    pass
            time.sleep(3)

    def stop(self):
        self.stop_requested = True
        if self.process and self.process.poll() is None:
            try:
                logger.info(f"Gracefully stopping recording process for {self.identifier}...")
                if self.process.stdin:
                    try:
                        self.process.stdin.write(b"q\n")
                        self.process.stdin.flush()
                    except Exception:
                        pass
                self.process.wait(timeout=12)
            except Exception:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=5)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass

    def _run_with_watchdog(self, cmd: list, log_path: Path, startup_timeout: int = 35) -> int:
        """
        Runs a recording subprocess with a startup watchdog.
        If within startup_timeout seconds the process fails or produces 0 bytes while
        logging fatal errors (403, 404, Error opening), it aborts early so subsequent
        engines run immediately instead of hanging for hours in an infinite reconnect loop.
        Once the output file receives data (> 50KB), it waits normally until completion or stop.
        """
        try:
            mode = "a" if log_path.exists() else "w"
            with open(log_path, mode, encoding="utf-8", errors="replace") as log_file:
                self.process = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                )

            started_writing = False
            for sec in range(startup_timeout):
                if self.stop_requested:
                    self.stop()
                    return self.process.wait()

                ret = self.process.poll()
                if ret is not None:
                    return ret

                if self.output_path.exists() and self.output_path.stat().st_size > 50 * 1024:
                    started_writing = True
                    break

                if sec >= 8 and log_path.exists():
                    try:
                        tail = log_path.read_text(encoding="utf-8", errors="ignore")[-1500:].lower()
                        if "403 forbidden" in tail or "server returned 403" in tail or "access denied" in tail:
                            logger.warning(f"Watchdog detected fatal 403 Forbidden in log for {self.identifier}. Killing process early...")
                            self.process.terminate()
                            try:
                                self.process.wait(timeout=5)
                            except Exception:
                                self.process.kill()
                            return -1
                    except Exception:
                        pass

                time.sleep(1)

            if not started_writing:
                ret = self.process.poll()
                if ret is None and (not self.output_path.exists() or self.output_path.stat().st_size < 10 * 1024):
                    logger.warning(f"Watchdog: no data written within {startup_timeout}s for {self.identifier}. Killing for fallback...")
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=5)
                    except Exception:
                        self.process.kill()
                    return -1

            return self.process.wait()
        except Exception as e:
            self.error = str(e)
            logger.error(f"Recording process execution error: {e}")
            return -1

    def _run(self):
        logger.info(f"Starting recording for {self.identifier} on {self.platform} -> {self.output_path}")

        # Start remote stop poll thread
        poll_thread = threading.Thread(target=self._poll_remote_stop, daemon=True)
        poll_thread.start()

        log_path = RECORDINGS_DIR / f"{self.filename}.log"
        cb_room_status = "unknown"

        if self.platform == "chaturbate":
            info = resolve_chaturbate_stream(self.identifier)
            cb_room_status = info.get("room_status", "unknown")

            # If in Private Show or Away, wait up to 45 minutes for public stream to resume
            if not info.get("ok") and cb_room_status in ("private", "away", "hidden"):
                status_ar = "عرض خاص (Private Show)" if cb_room_status == "private" else "استراحة قصيرة (Away)"
                logger.info(f"{self.identifier} is currently in {cb_room_status}. Waiting automatically for public stream...")
                notify_telegram(
                    self.bot_token,
                    self.chat_id,
                    f"⏳ <b>الحساب <code>{self.identifier}</code> في {status_ar} حالياً!</b>\n\n"
                    f"🔄 السيرفر السحابي في <b>وضع الانتظار الذكي</b> الآن — سيبدأ تسجيل البث العام تلقائياً وبأعلى دقة (1080p) فور انتهاء العرض الخاص دون أي تدخل منك!",
                )
                for _ in range(180):  # 180 * 15s = 45 minutes
                    if self.stop_requested:
                        break
                    for _ in range(15):
                        if self.stop_requested:
                            break
                        time.sleep(1)
                    if self.stop_requested:
                        break
                    info = resolve_chaturbate_stream(self.identifier)
                    cb_room_status = info.get("room_status", cb_room_status)
                    if info.get("ok"):
                        logger.info(f"{self.identifier} is now PUBLIC! Starting recording...")
                        notify_telegram(
                            self.bot_token,
                            self.chat_id,
                            f"🟢 <b>انتهى العرض الخاص وعاد حساب <code>{self.identifier}</code> للبث العام! بدأ التسجيل السحابي الآن...</b>",
                        )
                        self.start_time = time.time()
                        break
                    if cb_room_status == "offline":
                        break

            cb_target_url = f"https://chaturbate.com/{self.identifier}/"

            # Engine 1: yt-dlp native recording (safest against edge CDN 403 & session quirks)
            logger.info(f"Starting Chaturbate recording via yt-dlp native for {self.identifier}...")
            ytdlp_cmd = [
                sys.executable,
                "-m", "yt_dlp",
                "--no-part",
                "--no-warnings",
                "--fixup", "never",
                "--retries", "10",
                "--fragment-retries", "10",
                "--retry-sleep", "2",
                "-o", str(self.output_path),
                cb_target_url,
            ]
            self._run_with_watchdog(ytdlp_cmd, log_path, startup_timeout=35)

            # Engine 2: ffmpeg with master m3u8 playlist if yt-dlp produced no file
            if not self.output_path.exists() or self.output_path.stat().st_size < 50 * 1024:
                info = resolve_chaturbate_stream(self.identifier)
                if info.get("ok") and info.get("video_url"):
                    logger.info(f"yt-dlp produced no file; trying ffmpeg with master m3u8 for {self.identifier}...")
                    tld = info.get("tld", "com")
                    ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                    hdrs = f"Referer: https://chaturbate.{tld}/{self.identifier}/\r\nOrigin: https://chaturbate.{tld}\r\n"
                    cmd = [
                        "ffmpeg",
                        "-y",
                        "-hide_banner",
                        "-loglevel", "info",
                        "-user_agent", ua,
                        "-headers", hdrs,
                        "-reconnect", "1",
                        "-reconnect_at_eof", "1",
                        "-reconnect_streamed", "1",
                        "-reconnect_delay_max", "3",
                        "-fflags", "+nobuffer+discardcorrupt",
                        "-i", info["video_url"],
                        "-c", "copy",
                        "-bsf:a", "aac_adtstoasc",
                        "-movflags", "+faststart",
                        str(self.output_path),
                    ]
                    self._run_with_watchdog(cmd, log_path, startup_timeout=35)

            # Engine 3: streamlink direct fallback
            if not self.output_path.exists() or self.output_path.stat().st_size < 50 * 1024:
                try:
                    logger.info(f"ffmpeg produced no file; trying streamlink fallback for {self.identifier}...")
                    sl_record_cmd = [
                        "streamlink",
                        "--force",
                        "--retry-streams", "5",
                        "--retry-max", "5",
                        cb_target_url,
                        "best",
                        "-o", str(self.output_path),
                    ]
                    self._run_with_watchdog(sl_record_cmd, log_path, startup_timeout=35)
                except Exception as e:
                    logger.warning(f"streamlink direct fallback error: {e}")

        elif self.platform == "tiktok":
            # TikTok Live via direct Webcast FLV continuous stream + ffmpeg
            tt_info = resolve_tiktok_stream(self.identifier)
            if tt_info.get("ok"):
                stream_url = tt_info["stream_url"]
                logger.info(f"TikTok live resolved for {self.identifier}: {stream_url}")
                ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                hdrs = "Referer: https://www.tiktok.com/\r\n"
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel", "info",
                    "-user_agent", ua,
                    "-headers", hdrs,
                    "-reconnect", "1",
                    "-reconnect_streamed", "1",
                    "-reconnect_delay_max", "5",
                    "-i", stream_url,
                    "-c", "copy",
                    "-movflags", "+faststart",
                    str(self.output_path),
                ]
                self._run_with_watchdog(cmd, log_path, startup_timeout=35)
            else:
                cb_room_status = "offline"

        elif self.platform == "stripchat":
            plugins_dir = Path(__file__).parent / "plugins"
            if not plugins_dir.exists():
                plugins_dir = Path("plugins")

            logger.info(f"Starting Mouflon-decrypted Stripchat recording for {self.identifier} with Streamlink...")
            cmd = [
                "streamlink",
                "--plugin-dirs", str(plugins_dir),
                "--loglevel", "info",
                "--retry-streams", "5",
                "--retry-max", "5",
                self.stream_url,
                "best",
                "-o", str(self.output_path),
            ]
            self._run_with_watchdog(cmd, log_path, startup_timeout=35)

            if not self.output_path.exists() or self.output_path.stat().st_size < 50 * 1024:
                info = resolve_stripchat_stream(self.stream_url)
                sc_status = info.get("room_status", "unknown")
                cb_room_status = "private" if sc_status == "private" else "offline"

        else:
            # Universal Live Stream Recording (Any web stream link on the internet)
            logger.info(f"Universal recording pipeline initiated for: {self.stream_url}")
            resolved_stream = None
            is_direct = any(self.stream_url.lower().endswith(ext) or ext in self.stream_url.lower() for ext in (".m3u8", ".mpd", ".flv", ".ts"))

            def _try_extract_stream(url: str) -> Tuple[Optional[str], str]:
                """Attempts to extract direct stream URL. Returns (stream_url, status_detail)."""
                # Check stripchat directly first
                if "stripchat." in url.lower():
                    sc = resolve_stripchat_stream(url)
                    if sc.get("ok"):
                        return sc["stream_url"], "live"
                    return None, sc.get("room_status", "unknown")
                # 1. yt-dlp extraction
                try:
                    ytdlp_cmd = [
                        sys.executable,
                        "-m", "yt_dlp",
                        "-g",
                        "--no-warnings",
                        "--no-playlist",
                        url,
                    ]
                    res = subprocess.run(ytdlp_cmd, capture_output=True, text=True, timeout=30)
                    if res.returncode == 0 and res.stdout.strip():
                        urls = [u.strip() for u in res.stdout.splitlines() if u.strip().startswith("http")]
                        if urls:
                            return urls[0], "live"
                    stderr = (res.stderr or "").lower()
                    if "private show" in stderr or "is in a private" in stderr or "private" in stderr:
                        return None, "private"
                    if "offline" in stderr or "not currently live" in stderr or "usernotlive" in stderr:
                        return None, "offline"
                except Exception as e:
                    logger.warning(f"yt-dlp extraction check error: {e}")

                # 2. streamlink extraction
                try:
                    sl_cmd = ["streamlink", "--stream-url", url, "best"]
                    res = subprocess.run(sl_cmd, capture_output=True, text=True, timeout=30)
                    if res.returncode == 0 and res.stdout.strip().startswith("http"):
                        return res.stdout.strip(), "live"
                except Exception:
                    pass

                return None, "unknown"

            # Step 1: Resolve stream or wait if currently in a Private Show
            if not is_direct:
                resolved_stream, status_detail = _try_extract_stream(self.stream_url)

                if not resolved_stream and status_detail == "private":
                    logger.info(f"{self.identifier} is in a Private Show. Entering smart wait loop (up to 60m)...")
                    notify_telegram(
                        self.bot_token,
                        self.chat_id,
                        f"🔒 <b>الحساب <code>{self.identifier}</code> في عرض خاص (Private Show / PVT) حالياً!</b>\n\n"
                        f"⏳ السيرفر السحابي في <b>وضع الانتظار الذكي</b> الآن — سيبدأ تسجيل البث العام تلقائياً فور انتهاء العرض الخاص وعودته للبث العام المجاني دون أي تدخل منك!",
                    )
                    # Wait up to 60 minutes (240 iterations * 15s)
                    for _ in range(240):
                        if self.stop_requested:
                            break
                        time.sleep(15)
                        resolved_stream, status_detail = _try_extract_stream(self.stream_url)
                        if resolved_stream:
                            notify_telegram(
                                self.bot_token,
                                self.chat_id,
                                f"🟢 <b>انتهى العرض الخاص وعاد حساب <code>{self.identifier}</code> للبث العام! بدأ التسجيل السحابي الآن...</b>",
                            )
                            self.start_time = time.time()
                            break
                        if status_detail == "offline":
                            break

            target_stream = resolved_stream or self.stream_url

            # Step 2: Record with ffmpeg if direct stream resolved or passed
            if resolved_stream or is_direct:
                ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
                cmd = [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel", "info",
                    "-user_agent", ua,
                    "-reconnect", "1",
                    "-reconnect_at_eof", "1",
                    "-reconnect_streamed", "1",
                    "-reconnect_delay_max", "5",
                    "-fflags", "+nobuffer+discardcorrupt",
                    "-i", target_stream,
                    "-c", "copy",
                    "-bsf:a", "aac_adtstoasc",
                    "-movflags", "+faststart",
                    str(self.output_path),
                ]
                self._run_with_watchdog(cmd, log_path, startup_timeout=35)

            # Step 3: If no valid file captured, record directly with yt-dlp
            if not self.output_path.exists() or self.output_path.stat().st_size < 50 * 1024:
                logger.info(f"Direct stream produced no file; trying direct yt-dlp recording for {self.stream_url}...")
                cmd = [
                    sys.executable,
                    "-m",
                    "yt_dlp",
                    "--no-part",
                    "--no-warnings",
                    "--retries", "infinite",
                    "--fragment-retries", "infinite",
                    "--retry-sleep", "2",
                    "-o",
                    str(self.output_path),
                    self.stream_url,
                ]
                self._run_with_watchdog(cmd, log_path, startup_timeout=35)

            # Step 4: If still no file and streamlink is available, fallback to direct streamlink
            if not self.output_path.exists() or self.output_path.stat().st_size < 50 * 1024:
                try:
                    logger.info(f"Trying direct streamlink recording for {self.stream_url}...")
                    sl_record_cmd = [
                        "streamlink",
                        "--force",
                        "-o", str(self.output_path),
                        self.stream_url,
                        "best",
                    ]
                    self._run_with_watchdog(sl_record_cmd, log_path, startup_timeout=35)
                except Exception as e:
                    logger.warning(f"streamlink direct recording error: {e}")

        # Clear stop signal in worker so future recordings are unaffected
        try:
            worker_base = os.getenv("WORKER_URL", "https://savelink.hudhaifa-bio.workers.dev").rstrip("/")
            clear_url = f"{worker_base}/api/record/signal/clear?target={urllib.parse.quote(self.identifier)}"
            req = urllib.request.Request(clear_url, headers={"User-Agent": "SaveLink-Recorder/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
        except Exception:
            pass

        # Job completed or stopped
        with jobs_lock:
            if self.identifier in active_jobs:
                del active_jobs[self.identifier]

        file_exists = self.output_path.exists() and self.output_path.stat().st_size > 50 * 1024
        platform_name = "TikTok Live" if self.platform == "tiktok" else ("Chaturbate" if self.platform == "chaturbate" else ("Stripchat" if self.platform == "stripchat" else "Live"))

        if not file_exists:
            log_tail = ""
            if log_path.exists():
                try:
                    log_tail = log_path.read_text(encoding="utf-8", errors="ignore")[-2000:].lower()
                    logger.info(f"Recorder log tail for {self.identifier}:\n{log_tail[-800:]}")
                except Exception:
                    pass

            if "403 forbidden" in log_tail or "access denied" in log_tail:
                err_reason = "تم حظر الاتصال بسيرفر البث (HTTP 403 CDN Block)"
            elif cb_room_status == "private" or "private show" in log_tail or "room is private" in log_tail:
                err_reason = "في عرض خاص مستمر (Private Show / PVT) ولم يعد للبث العام خلال فترة الانتظار"
            elif cb_room_status == "away" or "away" in log_tail:
                err_reason = "متوقف مؤقتاً (Away)"
            elif cb_room_status == "password protected" or "password protected" in log_tail:
                err_reason = "محمي بكلمة مرور (Password Protected)"
            elif cb_room_status == "offline" or "offline" in log_tail or "usernotlive" in log_tail:
                err_reason = "غير مباشر حالياً (Offline)"
            else:
                err_reason = "تعذر سحب البث أو انتهى سريعاً"

            logger.warning(f"Recording for {self.identifier} on {platform_name} ended without file: {err_reason}")
            notify_telegram(
                self.bot_token,
                self.chat_id,
                f"⚠️ <b>تنبيه التسجيل ({platform_name}):</b>\n\n👤 الحساب: <code>{self.identifier}</code>\n❌ <b>الحالة:</b> {err_reason}.\n\n💡 <b>الحل التلقائي:</b> استخدم أمر المراقبة <code>/watch {self.identifier}</code> وسيسجل البوت تلقائياً أول ما يبدأ البث العام المجاني!",
            )
            try:
                notified_file = RECORDINGS_DIR / f".notified_{self.identifier}"
                notified_file.write_text("1")
            except Exception:
                pass
            return

        size_bytes = self.output_path.stat().st_size
        size_mb = size_bytes / (1024 * 1024)
        size_str = f"{size_mb:.1f} MB" if size_mb < 1024 else f"{(size_mb / 1024):.2f} GB"
        duration_sec = max(1, int(time.time() - self.start_time))
        hours, rem = divmod(duration_sec, 3600)
        minutes, seconds = divmod(rem, 60)
        duration_str = f"{hours}h {minutes}m {seconds}s" if hours else f"{minutes}m {seconds}s"

        logger.info(f"Recording finished for {self.identifier} on {platform_name}: {size_str}, uploading...")

        # 1. Try Gofile (fast, reliable, no size limit)
        download_url = upload_to_gofile(self.output_path)
        # 2. Try Pixeldrain as fallback
        if not download_url:
            download_url = upload_to_pixeldrain(self.output_path)

        self.final_url = download_url
        logger.info(f"Uploaded URL for {self.identifier}: {download_url}")

        if download_url:
            msg = (
                f"✅ <b>تم اكتمال تسجيل بث {platform_name} بنجاح!</b>\n\n"
                f"👤 <b>الحساب:</b> <code>{self.identifier}</code>\n"
                f"⏱️ <b>المدة:</b> {duration_str}\n"
                f"📦 <b>الحجم:</b> {size_str}\n"
                f"🔗 <b>الرابط المباشر للمشاهدة والتحميل السريع:</b>\n{download_url}"
            )
        else:
            msg = (
                f"✅ <b>تم إنهاء تسجيل بث {platform_name} محلياً!</b>\n\n"
                f"👤 <b>الحساب:</b> <code>{self.identifier}</code>\n"
                f"⏱️ <b>المدة:</b> {duration_str}\n"
                f"📦 <b>الحجم:</b> {size_str}\n"
                f"📁 <b>اسم الملف:</b> <code>{self.filename}</code>"
            )

        uploaded_direct = False
        if size_bytes <= 50 * 1024 * 1024:
            uploaded_direct = send_telegram_video(self.bot_token, self.chat_id, self.output_path, msg)
        else:
            preview_path = RECORDINGS_DIR / f"preview_{self.filename}"
            if create_preview_clip(self.output_path, preview_path):
                preview_caption = (
                    f"🎬 <b>معاينة سريعة للبث (30 ثانية):</b>\n"
                    f"👤 <code>{self.identifier}</code> | {size_str}\n\n"
                    f"🔗 <b>تحميل البث كاملاً بأعلى دقة:</b>\n{download_url}"
                )
                send_telegram_video(self.bot_token, self.chat_id, preview_path, preview_caption)
                try:
                    preview_path.unlink()
                except Exception:
                    pass

        # If not sent directly as full video, send message with download button
        if not uploaded_direct:
            notify_telegram(self.bot_token, self.chat_id, msg, download_url)

        # Mark as notified and uploaded so backup uploader never sends duplicate failure
        try:
            (RECORDINGS_DIR / ".upload_completed").write_text("1")
            (RECORDINGS_DIR / f".notified_{self.identifier}").write_text("1")
        except Exception:
            pass

        if download_url:
            try:
                self.output_path.unlink()
            except Exception:
                pass


def start_recording(model_or_url: str, chat_id: int | str, bot_token: str = "") -> Dict[str, Any]:
    platform, identifier, stream_url = parse_stream_target(model_or_url)
    if platform == "unknown":
        return {"ok": False, "error": "الرابط أو اسم الحساب غير صالح"}

    with jobs_lock:
        if identifier in active_jobs:
            return {"ok": False, "error": f"التسجيل قيد العمل بالفعل لـ: {identifier}"}

        job = RecordingJob(platform, identifier, stream_url, chat_id, bot_token)
        active_jobs[identifier] = job
        job.start()

    return {"ok": True, "model": identifier, "platform": platform, "start_time": job.start_time}


def stop_recording(model_or_url: str) -> Dict[str, Any]:
    platform, identifier, _ = parse_stream_target(model_or_url)
    key = identifier if platform != "unknown" else model_or_url.strip()

    with jobs_lock:
        job = active_jobs.get(key)
        if not job:
            return {"ok": False, "error": f"لا يوجد تسجيل نشط حالياً لـ: {key}"}
        job.stop()

    return {"ok": True, "model": key, "message": "جاري إيقاف التسجيل وتجهيز الفيديو للرفع..."}


def list_active_recordings() -> Dict[str, Any]:
    with jobs_lock:
        items = []
        for key, job in active_jobs.items():
            elapsed = int(time.time() - job.start_time)
            size = job.output_path.stat().st_size if job.output_path.exists() else 0
            size_mb = size / (1024 * 1024)
            items.append({
                "model": job.identifier,
                "platform": job.platform,
                "elapsed_seconds": elapsed,
                "size_mb": round(size_mb, 2),
            })
    return {"ok": True, "recordings": items}


if __name__ == "__main__":
    import signal

    if len(sys.argv) < 3:
        print("Usage: python recorder.py <target_url_or_user> <chat_id> [bot_token]")
        sys.exit(1)

    cli_target = sys.argv[1]
    cli_chat = sys.argv[2]
    cli_token = sys.argv[3] if len(sys.argv) > 3 else os.getenv("BOT_TOKEN", "")

    platform, identifier, stream_url = parse_stream_target(cli_target)
    if platform == "unknown":
        platform = "universal"
        identifier = re.sub(r"[^a-zA-Z0-9_-]", "_", cli_target)[:40] or "stream"
        stream_url = cli_target

    print(f"Starting CLI recording for {identifier} on {platform} (chat_id: {cli_chat})...", flush=True)
    cli_job = RecordingJob(platform, identifier, stream_url, cli_chat, cli_token)

    def _sig_handler(sig, frame):
        print("\nInterrupt received, stopping recording and uploading...", flush=True)
        cli_job.stop()

    signal.signal(signal.SIGINT, _sig_handler)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _sig_handler)

    cli_job._run()
