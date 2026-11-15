"""Video Frame Extractor CLI & Processor for Telegram Bot.

Extracts every single video frame in a specified time range,
compresses all frames into a high-quality ZIP archive,
sends a preview album of sample frames + the complete ZIP file directly to Telegram (or upload fallback).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional
import urllib.parse
import urllib.request

logger = logging.getLogger("frame_extractor")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "./recordings_data"))
RECORDINGS_DIR = MEDIA_DIR / "recordings"
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)


def get_ffmpeg_binary() -> str:
    """Finds available ffmpeg binary across system PATH and Python environment."""
    binary = shutil.which("ffmpeg")
    if binary:
        return binary
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    return "ffmpeg"


def normalize_video_url(url: str) -> str:
    """Converts viewing URLs (like Pixeldrain viewer) to direct media stream URLs."""
    clean = url.strip()
    pd_match = re.search(r"pixeldrain\.com/u/([a-zA-Z0-9_-]+)", clean)
    if pd_match:
        return f"https://pixeldrain.com/api/file/{pd_match.group(1)}"
    return clean


def parse_timestamp_to_seconds(ts: str) -> float:
    """Parses timestamps like '00:01:20', '01:20', '80', '1.5' into float seconds."""
    s = ts.strip().replace(",", ".")
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        elif len(parts) == 1:
            return float(parts[0])
    except ValueError:
        pass
    return 0.0


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


def upload_fallback(file_path: Path) -> Optional[str]:
    """Attempts Gofile then Pixeldrain for files exceeding Telegram limit."""
    link = upload_to_gofile(file_path)
    if link:
        return link
    try:
        filename = file_path.name
        url = f"https://pixeldrain.com/api/file/{urllib.parse.quote(filename)}"
        req = urllib.request.Request(
            url,
            method="PUT",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) savelink-frames/1.0"},
        )
        with open(file_path, "rb") as f:
            with urllib.request.urlopen(req, data=f, timeout=600) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("success"):
                    return f"https://pixeldrain.com/u/{data.get('id')}"
    except Exception as e:
        logger.error(f"Pixeldrain upload fallback failed: {e}")
    return None


def send_telegram_preview_album(
    bot_token: str,
    chat_id: int | str,
    frames: List[Path],
    start: str,
    end: str,
    total_frames: int,
) -> bool:
    """Sends a sample photo album of extracted frames for instant visual feedback."""
    if not bot_token or not chat_id or not frames:
        return False

    # Choose up to 5 representative frames
    if len(frames) <= 5:
        selected = frames
    else:
        indices = [
            0,
            len(frames) // 4,
            len(frames) // 2,
            (3 * len(frames)) // 4,
            len(frames) - 1,
        ]
        # Keep unique and in order
        seen = set()
        selected = []
        for idx in indices:
            if idx not in seen and idx < len(frames):
                seen.add(idx)
                selected.append(frames[idx])

    try:
        import requests

        if len(selected) == 1:
            # Single photo
            url = f"https://api.telegram.org/bot{bot_token}/sendPhoto"
            caption = (
                f"🖼️ <b>معاينة الإطار المقتطع:</b>\n\n"
                f"⏱️ <b>الفترة:</b> <code>{start}</code> إلى <code>{end}</code>\n"
                f"🔢 <b>إجمالي الفريمات:</b> <code>1 فريم</code>\n"
                f"📦 جاري إرسال الملف المضغوط الكامل..."
            )
            with open(selected[0], "rb") as f:
                resp = requests.post(
                    url,
                    data={"chat_id": chat_id, "caption": caption, "parse_mode": "HTML"},
                    files={"photo": (selected[0].name, f, "image/jpeg")},
                    timeout=60,
                )
                return resp.json().get("ok", False)

        # Media group album
        url = f"https://api.telegram.org/bot{bot_token}/sendMediaGroup"
        media = []
        files = {}

        caption = (
            f"🖼️ <b>معاينة الفريمات المقتطعة ({len(selected)} نماذج):</b>\n\n"
            f"⏱️ <b>الفترة:</b> <code>{start}</code> إلى <code>{end}</code>\n"
            f"🔢 <b>إجمالي الفريمات الحرفية:</b> <b>{total_frames} فريم</b>\n"
            f"📦 <i>جاري إرسال الأرشيف الكامل ZIP أدناه...</i>"
        )

        file_handles = []
        try:
            for i, p in enumerate(selected):
                attach_name = f"photo_{i}"
                item: Dict[str, Any] = {
                    "type": "photo",
                    "media": f"attach://{attach_name}",
                }
                if i == 0:
                    item["caption"] = caption
                    item["parse_mode"] = "HTML"
                media.append(item)

                fh = open(p, "rb")
                file_handles.append(fh)
                files[attach_name] = (p.name, fh, "image/jpeg")

            resp = requests.post(
                url,
                data={"chat_id": chat_id, "media": json.dumps(media)},
                files=files,
                timeout=120,
            )
            res_data = resp.json()
            if res_data.get("ok"):
                logger.info("Preview album sent successfully to Telegram.")
                return True
            else:
                logger.warning(f"sendMediaGroup returned not ok: {res_data}")
        finally:
            for fh in file_handles:
                fh.close()

    except Exception as e:
        logger.error(f"Failed to send Telegram preview album: {e}")
    return False


def send_telegram_document(
    bot_token: str,
    chat_id: int | str,
    doc_path: Path,
    caption: str,
) -> bool:
    """Sends the complete frames ZIP archive directly as document."""
    if not bot_token or not chat_id or not doc_path.exists():
        return False
    size = doc_path.stat().st_size
    if size > 50 * 1024 * 1024:
        return False

    try:
        import requests

        url = f"https://api.telegram.org/bot{bot_token}/sendDocument"
        with open(doc_path, "rb") as f:
            files = {"document": (doc_path.name, f, "application/zip")}
            data = {
                "chat_id": chat_id,
                "caption": caption,
                "parse_mode": "HTML",
            }
            resp = requests.post(url, data=data, files=files, timeout=300)
            res_data = resp.json()
            if res_data.get("ok"):
                logger.info(f"Frames archive uploaded directly to Telegram chat {chat_id}")
                return True
            else:
                logger.warning(f"sendDocument returned not ok: {res_data}")
    except Exception as e:
        logger.error(f"Failed to send Telegram document: {e}")
    return False


def notify_telegram(
    bot_token: str,
    chat_id: int | str,
    text: str,
    download_url: Optional[str] = None,
) -> None:
    """Sends text or error message with optional download button."""
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
                    [{"text": "🚀 تحميل أرشيف الفريمات (ZIP)", "url": download_url}],
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


def extract_frames(
    url: str,
    start: str,
    end: str,
    chat_id: int | str,
    bot_token: str = "",
) -> bool:
    """Extracts all literal frames between start and end, zips them, and uploads."""
    direct_url = normalize_video_url(url)
    timestamp = int(time.time())
    ffmpeg_bin = get_ffmpeg_binary()

    safe_start = re.sub(r"[^\w.-]", "_", str(start))
    safe_end = re.sub(r"[^\w.-]", "_", str(end))
    temp_dir = RECORDINGS_DIR / f"temp_frames_{timestamp}"
    temp_dir.mkdir(parents=True, exist_ok=True)

    zip_path = RECORDINGS_DIR / f"frames_{safe_start}_to_{safe_end}_{timestamp}.zip"

    logger.info(f"Extracting all frames from {direct_url} [{start} -> {end}] via {ffmpeg_bin}...")

    # Primary method: accurate seek with native stream pacing
    cmd = [
        ffmpeg_bin,
        "-y",
        "-ss", str(start),
        "-to", str(end),
        "-i", direct_url,
        "-q:v", "2",
        str(temp_dir / "frame_%05d.jpg"),
    ]

    try:
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=300)
        if res.returncode != 0:
            err_msg = res.stderr.decode("utf-8", errors="ignore")[-400:]
            logger.warning(f"ffmpeg frame extraction exited with code {res.returncode}: {err_msg}")
    except Exception as e:
        logger.warning(f"Frame extraction primary attempt error: {e}")

    frames = sorted(temp_dir.glob("frame_*.jpg"))

    # Fallback method if no frames were generated (e.g. streaming quirks or slow keyframe seeking)
    if not frames:
        logger.info("No frames extracted on first pass; retrying with input-first seeking...")
        cmd_fallback = [
            ffmpeg_bin,
            "-y",
            "-i", direct_url,
            "-ss", str(start),
            "-to", str(end),
            "-q:v", "2",
            str(temp_dir / "frame_%05d.jpg"),
        ]
        try:
            subprocess.run(cmd_fallback, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300)
            frames = sorted(temp_dir.glob("frame_*.jpg"))
        except Exception as e:
            logger.error(f"Fallback frame extraction failed: {e}")

    if not frames:
        logger.error(f"No frames could be extracted for range {start}-{end}")
        notify_telegram(
            bot_token,
            chat_id,
            f"❌ <b>فشل استخراج الفريمات:</b>\n"
            f"تعذر استخراج أي إطار في الفترة المحددة (<code>{start}</code> إلى <code>{end}</code>).\n"
            f"تأكد من صحة الرابط وأن التوقيت يقع ضمن مدة الفيديو الأصلية.",
        )
        # Cleanup
        shutil.rmtree(temp_dir, ignore_errors=True)
        return False

    total_frames = len(frames)
    logger.info(f"Successfully extracted {total_frames} frames. Compressing to ZIP...")

    # Pack into ZIP
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for f in frames:
            # Place inside 'frames/' directory inside ZIP
            zf.write(f, arcname=f"frames/{f.name}")

    zip_size_bytes = zip_path.stat().st_size
    zip_size_mb = zip_size_bytes / (1024 * 1024)
    logger.info(f"Created ZIP: {zip_path.name} ({zip_size_mb:.2f} MB, {total_frames} frames)")

    # Send preview album first so user gets instant gratification
    send_telegram_preview_album(bot_token, chat_id, frames, str(start), str(end), total_frames)

    # Deliver complete ZIP
    caption = (
        f"📦 <b>جميع فريمات الفيديو بالكامل</b>\n\n"
        f"⏱️ <b>الفترة:</b> <code>{start}</code> إلى <code>{end}</code>\n"
        f"🔢 <b>إجمالي الفريمات:</b> <b>{total_frames} فريم</b>\n"
        f"💾 <b>الحجم:</b> <code>{zip_size_mb:.2f} MB</code>\n\n"
        f"💡 جميع الصور بالدقة والجودة الأصلية داخل الملف."
    )

    doc_sent = False
    if zip_size_bytes <= 50 * 1024 * 1024:
        doc_sent = send_telegram_document(bot_token, chat_id, zip_path, caption)

    if not doc_sent:
        logger.info(f"File size is {zip_size_mb:.2f} MB or direct send failed; uploading fallback...")
        download_url = upload_fallback(zip_path)
        if download_url:
            notify_telegram(
                bot_token,
                chat_id,
                f"📦 <b>تم استخراج {total_frames} فريم بنجاح!</b>\n\n"
                f"⏱️ <b>الفترة:</b> <code>{start}</code> إلى <code>{end}</code>\n"
                f"💾 <b>الحجم:</b> <code>{zip_size_mb:.2f} MB</code> (تجاوز 50MB لتيليجرام)\n\n"
                f"👇 يمكنك تحميل الأرشيف الكامل مباشرة من الرابط السريع أدناه:",
                download_url=download_url,
            )
        else:
            notify_telegram(
                bot_token,
                chat_id,
                f"⚠️ تم استخراج <b>{total_frames}</b> فريم بحجم <code>{zip_size_mb:.2f} MB</code>، لكن تعذر الرفع المباشر.",
            )

    # Clean temporary frame images to conserve disk space
    shutil.rmtree(temp_dir, ignore_errors=True)
    return True


def main() -> None:
    if len(sys.argv) < 4:
        print("Usage: python frame.py <url> <start> <end> [chat_id] [bot_token]")
        sys.exit(1)

    url = sys.argv[1]
    start = sys.argv[2]
    end = sys.argv[3]
    chat_id = sys.argv[4] if len(sys.argv) > 4 else ""
    bot_token = sys.argv[5] if len(sys.argv) > 5 else ""

    success = extract_frames(url, start, end, chat_id, bot_token)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
