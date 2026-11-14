"""Video Trimmer CLI & Processor for Telegram Bot.

Cuts/trims any video range from Pixeldrain, direct URLs, or recordings,
uploads directly to Telegram if <= 50MB, and provides a permanent Pixeldrain download link.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
import urllib.request
import urllib.parse

logger = logging.getLogger("trimmer")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "./recordings_data"))
RECORDINGS_DIR = MEDIA_DIR / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)


def normalize_video_url(url: str) -> str:
    """Converts viewing URLs (like Pixeldrain viewer) to direct media stream URLs."""
    clean = url.strip()
    # Pixeldrain: https://pixeldrain.com/u/{id} -> https://pixeldrain.com/api/file/{id}
    pd_match = re.search(r"pixeldrain\.com/u/([a-zA-Z0-9_-]+)", clean)
    if pd_match:
        return f"https://pixeldrain.com/api/file/{pd_match.group(1)}"
    return clean


def upload_to_pixeldrain(file_path: Path) -> Optional[str]:
    try:
        filename = file_path.name
        url = f"https://pixeldrain.com/api/file/{urllib.parse.quote(filename)}"
        req = urllib.request.Request(
            url,
            method="PUT",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) savelink-trimmer/1.0"},
        )
        with open(file_path, "rb") as f:
            with urllib.request.urlopen(req, data=f, timeout=600) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("success"):
                    return f"https://pixeldrain.com/u/{data.get('id')}"
    except Exception as e:
        logger.error(f"Pixeldrain upload failed: {e}")
    return None


def send_telegram_video(bot_token: str, chat_id: int | str, video_path: Path, caption: str) -> bool:
    if not bot_token or not chat_id or not video_path.exists():
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
                logger.info(f"Trimmed video uploaded directly to Telegram chat {chat_id}")
                return True
    except Exception as e:
        logger.error(f"Failed to send direct Telegram video: {e}")
    return False


def notify_telegram(bot_token: str, chat_id: int | str, text: str, download_url: Optional[str] = None) -> None:
    if not bot_token or not chat_id:
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
                    [{"text": "🚀 تحميل الفيديو المقصوص", "url": download_url}],
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


def trim_video(url: str, start: str, end: str, chat_id: int | str, bot_token: str = "") -> bool:
    direct_url = normalize_video_url(url)
    timestamp = int(time.time())
    output_path = RECORDINGS_DIR / f"trimmed_{timestamp}.mp4"

    logger.info(f"Trimming {direct_url} from {start} to {end} -> {output_path}")

    # First attempt: Fast stream copy
    cmd_fast = [
        "ffmpeg",
        "-y",
        "-ss", str(start),
        "-to", str(end),
        "-i", direct_url,
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        str(output_path),
    ]

    success = False
    try:
        res = subprocess.run(cmd_fast, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
        if res.returncode == 0 and output_path.exists() and output_path.stat().st_size > 20 * 1024:
            success = True
    except Exception as e:
        logger.warning(f"Fast trim copy failed: {e}")

    # Second attempt: Transcode if copy failed or output was empty
    if not success:
        logger.info("Retrying with re-encode...")
        cmd_transcode = [
            "ffmpeg",
            "-y",
            "-ss", str(start),
            "-to", str(end),
            "-i", direct_url,
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "23",
            "-c:a", "aac",
            str(output_path),
        ]
        try:
            res = subprocess.run(cmd_transcode, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
            if res.returncode == 0 and output_path.exists() and output_path.stat().st_size > 20 * 1024:
                success = True
        except Exception as e:
            logger.error(f"Transcode trim failed: {e}")

    if not success:
        notify_telegram(
            bot_token,
            chat_id,
            f"❌ <b>تعذر قص الفيديو</b>\nتأكد من صحة الرابط والتوقيتات:\nالبداية: <code>{start}</code> | النهاية: <code>{end}</code>",
        )
        return False

    size_bytes = output_path.stat().st_size
    size_mb = size_bytes / (1024 * 1024)
    size_str = f"{size_mb:.1f} MB" if size_mb < 1024 else f"{(size_mb / 1024):.2f} GB"

    logger.info(f"Trim completed: {size_str}, uploading...")
    download_url = upload_to_pixeldrain(output_path)

    caption = (
        f"✂️ <b>تم قص الفيديو بنجاح!</b>\n\n"
        f"⏱️ <b>المقطع:</b> من <code>{start}</code> إلى <code>{end}</code>\n"
        f"📦 <b>الحجم:</b> {size_str}\n"
    )
    if download_url:
        caption += f"🔗 <b>الرابط المباشر:</b>\n{download_url}"

    # Try direct Telegram upload first if <= 50MB
    uploaded_direct = False
    if size_bytes <= 50 * 1024 * 1024:
        uploaded_direct = send_telegram_video(bot_token, chat_id, output_path, caption)

    # Fallback to message with download link if direct upload didn't happen
    if not uploaded_direct:
        notify_telegram(bot_token, chat_id, caption, download_url)

    try:
        output_path.unlink()
    except Exception:
        pass

    return True


if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python trim.py <url> <start> <end> <chat_id> [bot_token]")
        sys.exit(1)

    cli_url = sys.argv[1]
    cli_start = sys.argv[2]
    cli_end = sys.argv[3]
    cli_chat = sys.argv[4]
    cli_token = sys.argv[5] if len(sys.argv) > 5 else os.getenv("BOT_TOKEN", "")

    trim_video(cli_url, cli_start, cli_end, cli_chat, cli_token)
