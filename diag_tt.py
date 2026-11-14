import subprocess, sys, json, os, re, time
import curl_cffi.requests as creq

def resolve_tiktok_stream(target: str) -> dict:
    # 1. Clean username
    clean = target.strip()
    if "tiktok.com" in clean:
        m = re.search(r"@([a-zA-Z0-9_.-]+)", clean)
        user = m.group(1) if m else clean
    else:
        user = clean.lstrip("@")
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://www.tiktok.com/",
    }

    # Approach A: Webcast Direct API
    try:
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

        print(f"Webcast approach: user={user}, room_id={room_id}")
        if room_id:
            api_url = f"https://webcast.tiktok.com/webcast/room/info/?aid=1988&room_id={room_id}"
            r_api = s.get(api_url, headers=headers, timeout=10)
            if r_api.status_code == 200:
                data = r_api.json().get("data", {})
                status = data.get("status")
                print(f"Room status: {status}")
                if status == 2:
                    st_data = data.get("stream_url", {})
                    flv_pull = st_data.get("flv_pull_url", {})
                    chosen = (
                        flv_pull.get("FULL_HD1")
                        or flv_pull.get("HD1")
                        or flv_pull.get("SD1")
                        or next(iter(flv_pull.values()), None)
                    )
                    if not chosen:
                        chosen = st_data.get("hls_pull_url")
                    if chosen:
                        return {"ok": True, "stream_url": chosen, "source": "webcast_api", "title": data.get("title", "")}
                elif status in (4, None):
                    return {"ok": False, "room_status": "offline"}
    except Exception as e:
        print("Webcast approach error:", e)

    # Approach B: yt-dlp -g -f "best[ext=flv]/best"
    try:
        cmd = [
            sys.executable, "-m", "yt_dlp",
            "--impersonate", "chrome",
            "-g",
            "-f", "best[ext=flv]/best",
            f"https://www.tiktok.com/@{user}/live"
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        print("yt-dlp -g returncode:", res.returncode)
        print("yt-dlp -g stdout:", res.stdout.strip())
        print("yt-dlp -g stderr:", res.stderr.strip()[:300])
        url = res.stdout.strip().split("\n")[0].strip()
        if res.returncode == 0 and url.startswith("http"):
            return {"ok": True, "stream_url": url, "source": "yt-dlp"}
    except Exception as e:
        print("yt-dlp approach error:", e)

    return {"ok": False, "room_status": "offline"}

# Test on shad.208
info = resolve_tiktok_stream("shad.208")
print("\nFinal info:", info)

if info.get("ok"):
    stream_url = info["stream_url"]
    print(f"\nRecording 10s from {stream_url} using ffmpeg...")
    cmd_ff = [
        "ffmpeg", "-y",
        "-user_agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-i", stream_url,
        "-t", "10",
        "-c", "copy",
        "-movflags", "+faststart",
        "test_tt.mp4"
    ]
    p = subprocess.run(cmd_ff, capture_output=True, text=True, timeout=25)
    print("ffmpeg rc:", p.returncode)
    print("ffmpeg stderr tail:\n", p.stderr[-500:])
    if os.path.exists("test_tt.mp4"):
        print("File recorded successfully! Size:", os.path.getsize("test_tt.mp4"))
