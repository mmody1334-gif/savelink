"""Backup & Interruption Uploader for GitHub Actions.

Runs on workflow cancellation or completion to guarantee any recorded MP4
is uploaded to Pixeldrain/Gofile and delivered to Telegram.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
import urllib.error
import urllib.request
import urllib.parse

logger = logging.getLogger("uploader")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "./recordings_data"))
RECORDINGS_DIR = MEDIA_DIR / "recordings"


def ensure_faststart_streaming(file_path: Path) -> Path:
    """Remuxes MP4 with faststart so moov atom is at beginning for instant web player streaming."""
    if not file_path.exists() or file_path.stat().st_size < 50 * 1024:
        return file_path
    fast_tmp = file_path.with_name(f"fast_{file_path.name}")
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(file_path),
        "-c", "copy",
        "-movflags", "+faststart",
        str(fast_tmp),
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        if res.returncode == 0 and fast_tmp.exists() and fast_tmp.stat().st_size > 0:
            file_path.unlink(missing_ok=True)
            fast_tmp.rename(file_path)
            logger.info(f"Faststart streaming optimization applied to {file_path.name}")
    except Exception as e:
        logger.warning(f"Faststart optimization skipped: {e}")
    return file_path


def upload_to_pixeldrain(file_path: Path) -> Optional[str]:
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
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("success"):
                    return f"https://pixeldrain.com/u/{data.get('id')}"
    except Exception as e:
        logger.error(f"Pixeldrain upload failed: {e}")
    return None


def upload_to_gofile(file_path: Path) -> Optional[str]:
    try:
        srv_req = urllib.request.Request("https://api.gofile.io/servers", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(srv_req, timeout=15) as resp:
            srv_data = json.loads(resp.read().decode("utf-8"))
            server = srv_data.get("data", {}).get("servers", [{}])[0].get("name")
            if not server:
                return None

        import requests
        with open(file_path, "rb") as f:
            up_resp = requests.post(
                f"https://{server}.gofile.io/contents/uploadfile",
                files={"file": (file_path.name, f, "video/mp4")},
                timeout=600,
            )
            up_data = up_resp.json()
            if up_data.get("status") == "ok":
                return up_data.get("data", {}).get("downloadPage")
    except Exception as e:
        logger.error(f"Gofile upload failed: {e}")
    return None


def send_telegram_video(bot_token: str, chat_id: int | str, video_path: Path, caption: str) -> bool:
    if not bot_token or not chat_id or str(chat_id) == "0" or not video_path.exists():
        return False
    size = video_path.stat().st_size
    if size > 50 * 1024 * 1024:
        return False
    try:
        import requests
        url = f"https://api.telegram.org/bot{bot_token}/sendVideo"
        with open(video_path, "rb") as f:
            files = {"video": (video_path.name, f, "video/mp4")}
            data = {
                "chat_id": chat_id,
                "caption": caption,
                "parse_mode": "HTML",
                "supports_streaming": "true",
            }
            resp = requests.post(url, data=data, files=files, timeout=300)
            res_data = resp.json()
            if res_data.get("ok"):
                logger.info(f"Direct video uploaded to Telegram chat {chat_id}")
                return True
    except Exception as e:
        logger.error(f"Failed to send direct Telegram video: {e}")
    return False


def _recorder_headers(bot_token: str = "") -> Dict[str, str]:
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) savelink-recorder/1.0"}
    token = (bot_token or os.getenv("BOT_TOKEN", "")).strip()
    if token:
        digest = hashlib.sha256(f"savelink-recorder-v1:{token}".encode("utf-8")).hexdigest()
        headers["X-Recorder-Token"] = digest
    return headers


def save_to_worker_archive(
    bot_token: str,
    chat_id: int | str,
    platform: str,
    model: str,
    download_url: str,
    size_str: str = "",
    duration_str: str = "",
    source: str = "uploader",
) -> bool:
    """Persists uploaded recording URL to Worker KV archive so /archive always has it."""
    if not download_url or not chat_id or str(chat_id) == "0":
        return False
    worker_base = os.getenv("WORKER_URL", "https://savelink.hudhaifa-bio.workers.dev").rstrip("/")
    chat_val: int | str = int(chat_id) if str(chat_id).lstrip("-").isdigit() else chat_id
    payload = {
        "chatId": chat_val,
        "platform": platform or "universal",
        "model": model,
        "url": download_url,
        "size": size_str,
        "duration": duration_str,
        "source": source,
    }
    headers = {**_recorder_headers(bot_token), "Content-Type": "application/json"}
    body = json.dumps(payload).encode("utf-8")
    for attempt in range(3):
        try:
            req = urllib.request.Request(f"{worker_base}/api/archive/add", headers=headers, data=body, method="POST")
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            logger.info(f"Saved backup URL to Worker archive for {model}")
            return True
        except Exception as e:
            logger.warning(f"Backup archive save attempt {attempt + 1} failed for {model}: {e}")
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))
    return False


def _clear_worker_signal(bot_token: str, platform: str, model: str) -> None:
    try:
        worker_base = os.getenv("WORKER_URL", "https://savelink.hudhaifa-bio.workers.dev").rstrip("/")
        clear_url = f"{worker_base}/api/record/signal/clear?target={urllib.parse.quote(model)}&platform={urllib.parse.quote(platform)}"
        req = urllib.request.Request(clear_url, headers=_recorder_headers(bot_token))
        with urllib.request.urlopen(req, timeout=5) as resp:
            resp.read()
    except Exception:
        pass


def _extract_target_from_filename(filename: str, fallback_target: str) -> Tuple[str, str]:
    m = re.match(r"^(chaturbate|tiktok|stripchat|universal)_(.+)_\d{8}_\d{6}\.mp4$", filename, re.I)
    if m:
        return m.group(1).lower(), m.group(2)
    clean = re.sub(r"[^a-zA-Z0-9_.-]", "_", fallback_target.strip().rstrip("/").split("/")[-1])
    return "universal", clean or fallback_target


def notify_telegram(bot_token: str, chat_id: int | str, text: str, download_url: Optional[str] = None) -> None:
    if not bot_token or not chat_id or str(chat_id) == "0":
        return
    base_payload: Dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
    }
    if download_url:
        base_payload["reply_markup"] = {
            "inline_keyboard": [
                [{"text": "🚀 تحميل ومشاهدة البث المسجل", "url": download_url}],
            ]
        }
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                f"https://api.telegram.org/bot{bot_token}/sendMessage",
                headers={"Content-Type": "application/json"},
                data=json.dumps(base_payload).encode("utf-8"),
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
            return
        except urllib.error.HTTPError as e:
            logger.error(f"Telegram notification HTTP {e.code} (attempt {attempt + 1}): {e}")
            if e.code == 400 and "parse_mode" in base_payload:
                base_payload.pop("parse_mode", None)
                continue
        except Exception as e:
            logger.error(f"Failed to send Telegram notification (attempt {attempt + 1}): {e}")
        if attempt < 2:
            time.sleep(1.5 * (attempt + 1))


def main():
    if len(sys.argv) < 3:
        sys.exit(0)

    target = sys.argv[1]
    chat_id = sys.argv[2]
    arg3 = sys.argv[3] if len(sys.argv) > 3 else ""
    bot_token = os.getenv("BOT_TOKEN", "").strip() or (arg3 if ":" in arg3 else "")

    if not RECORDINGS_DIR.exists():
        RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)

    upload_completed_marker = RECORDINGS_DIR / ".upload_completed"
    if upload_completed_marker.exists():
        logger.info("Upload already completed by recorder.py. Skipping duplicate uploader.")
        try:
            upload_completed_marker.unlink()
        except Exception:
            pass
        sys.exit(0)

    notified_files = list(RECORDINGS_DIR.glob(".notified_*"))
    if notified_files:
        logger.info("Notification was already sent by recorder.py. Skipping duplicate notification.")
        for nf in notified_files:
            try:
                nf.unlink()
            except Exception:
                pass
        sys.exit(0)

    # Recover any partial MP4 capture left by a cancelled yt-dlp process before scanning.
    for part_file in RECORDINGS_DIR.glob("*.mp4.part"):
        try:
            if part_file.stat().st_size > 50 * 1024:
                recovered = part_file.with_suffix("")
                part_file.replace(recovered)
                logger.info(f"Recovered partial MP4 file: {recovered.name}")
        except Exception as e:
            logger.warning(f"Failed to recover {part_file.name}: {e}")

    mp4_files = list(RECORDINGS_DIR.glob("*.mp4"))
    if not mp4_files:
        logger.info("No un-uploaded MP4 files found.")
        notify_telegram(
            bot_token,
            chat_id,
            f"⚠️ <b>لم يتم التقاط أي فيديو للبث:</b> <code>{target}</code>\n\n"
            f"💡 <b>السبب المحتمل:</b>\n"
            f"• البث كان مغلقاً (Offline) أو في غرفة خاصة (Private).\n"
            f"• أو تم إيقاف التسجيل فوراً قبل استلام أول مقطع فيديو.\n\n"
            f"للمراقبة والتسجيل التلقائي فور بدء البث: <code>/watch {target}</code>"
        )
        sys.exit(0)

    # Sort newest first
    mp4_files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for mp4 in mp4_files:
        size_bytes = mp4.stat().st_size
        if size_bytes < 50 * 1024:
            continue

        size_mb = size_bytes / (1024 * 1024)
        size_str = f"{size_mb:.1f} MB" if size_mb < 1024 else f"{(size_mb / 1024):.2f} GB"

        logger.info(f"Uploading remaining file: {mp4.name} ({size_str})...")
        mp4 = ensure_faststart_streaming(mp4)
        # 1. Try Pixeldrain (supports direct in-browser streaming, fast, up to 10GB)
        download_url = upload_to_pixeldrain(mp4)
        # 2. Try Gofile as fallback
        if not download_url:
            download_url = upload_to_gofile(mp4)

        if download_url:
            platform, model = _extract_target_from_filename(mp4.name, target)
            save_to_worker_archive(bot_token, chat_id, platform, model, download_url, size_str, "backup", "uploader")
            _clear_worker_signal(bot_token, platform, model)
            msg = (
                f"✅ <b>تم حفظ ورفع البث المسجل بنجاح!</b>\n\n"
                f"👤 <b>الهدف:</b> <code>{target}</code>\n"
                f"📦 <b>الحجم:</b> {size_str}\n"
                f"🔗 <b>الرابط المباشر للتحميل:</b>\n{download_url}\n"
                f"🗄️ <i>تم حفظ الرابط تلقائياً في /archive</i>"
            )
            uploaded_direct = False
            if size_bytes <= 50 * 1024 * 1024:
                uploaded_direct = send_telegram_video(bot_token, chat_id, mp4, msg)

            if not uploaded_direct:
                notify_telegram(bot_token, chat_id, msg, download_url)

            try:
                mp4.unlink()
            except Exception:
                pass


if __name__ == "__main__":
    main()
