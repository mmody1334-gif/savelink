"""Backup & Interruption Uploader for GitHub Actions.

Runs on workflow cancellation or completion to guarantee any recorded MP4
is uploaded to Pixeldrain/Gofile and delivered to Telegram.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
import urllib.request
import urllib.parse

logger = logging.getLogger("uploader")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "./recordings_data"))
RECORDINGS_DIR = MEDIA_DIR / "recordings"


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
                files={"file": (file_path.name, f)},
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


def notify_telegram(bot_token: str, chat_id: int | str, text: str, download_url: Optional[str] = None) -> None:
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


def main():
    if len(sys.argv) < 3:
        sys.exit(0)

    target = sys.argv[1]
    chat_id = sys.argv[2]
    bot_token = sys.argv[3] if len(sys.argv) > 3 else os.getenv("BOT_TOKEN", "")

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
        download_url = upload_to_gofile(mp4)
        if not download_url:
            download_url = upload_to_pixeldrain(mp4)

        if download_url:
            msg = (
                f"✅ <b>تم حفظ ورفع البث المسجل بنجاح!</b>\n\n"
                f"👤 <b>الهدف:</b> <code>{target}</code>\n"
                f"📦 <b>الحجم:</b> {size_str}\n"
                f"🔗 <b>الرابط المباشر للتحميل:</b>\n{download_url}"
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
