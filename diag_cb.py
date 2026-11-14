import subprocess, sys, json, time, os, re
import curl_cffi.requests as creq

model = "bunnyblondy"
s = creq.Session(impersonate="safari17_0")

print("=== 1. Check HTML page initialRoomDossier ===", flush=True)
rp = s.get(f"https://chaturbate.com/{model}/", timeout=15)
print("HTML status:", rp.status_code, "len:", len(rp.text), flush=True)
m_dos = re.search(r'initialRoomDossier\s*=\s*"([^"]+)"', rp.text)
if m_dos:
    raw = m_dos.group(1).encode('utf-8').decode('unicode_escape')
    dos = json.loads(raw)
    print("Dossier room_status:", dos.get("room_status"), "hls_source:", dos.get("hls_source"), "cmaf_edge:", dos.get("cmaf_edge"), flush=True)
else:
    print("No initialRoomDossier in HTML. Searching .m3u8 in HTML:", re.findall(r'https?://[^\s"\'\\]+\.m3u8[^\s"\'\\]*', rp.text), flush=True)

print("\n=== 2. Fresh m3u8 from get_edge_hls_url_ajax -> Direct ffmpeg (NO prior GET) ===", flush=True)
r_ajax = s.post(
    "https://chaturbate.com/get_edge_hls_url_ajax/",
    data={"room_slug": model},
    headers={"X-Requested-With": "XMLHttpRequest", "Accept": "application/json", "Origin": "https://chaturbate.com", "Referer": f"https://chaturbate.com/{model}/"},
    timeout=10,
)
fresh_url1 = r_ajax.json().get("url")
print("fresh_url1:", fresh_url1[:100] if fresh_url1 else None, flush=True)
if fresh_url1:
    p1 = subprocess.run(
        [
            "ffmpeg", "-y",
            "-user_agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            "-headers", f"Referer: https://chaturbate.com/{model}/\r\nOrigin: https://chaturbate.com\r\n",
            "-i", fresh_url1,
            "-t", "6", "-c", "copy", "test_fresh1.mp4"
        ],
        capture_output=True, text=True, timeout=25
    )
    print("ffmpeg fresh1 rc:", p1.returncode, "size:", os.path.getsize("test_fresh1.mp4") if os.path.exists("test_fresh1.mp4") else 0, flush=True)
    if p1.returncode != 0:
        print("ffmpeg fresh1 err:", p1.stderr[-600:], flush=True)

print("\n=== 3. Fresh m3u8 resolved via curl_cffi -> sub-playlists -> ffmpeg ===", flush=True)
r_ajax2 = s.post(
    "https://chaturbate.com/get_edge_hls_url_ajax/",
    data={"room_slug": model},
    headers={"X-Requested-With": "XMLHttpRequest", "Accept": "application/json", "Origin": "https://chaturbate.com", "Referer": f"https://chaturbate.com/{model}/"},
    timeout=10,
)
fresh_url2 = r_ajax2.json().get("url")
if fresh_url2:
    base_host = "https://" + fresh_url2.split("/")[2]
    r_pl = s.get(fresh_url2, headers={"Referer": f"https://chaturbate.com/{model}/", "Origin": "https://chaturbate.com"}, timeout=10)
    print("Master playlist status:", r_pl.status_code, flush=True)
    print("Master playlist full:\n", r_pl.text, flush=True)
    vid_paths = re.findall(r'(/v1/edge/streams/[^\s"\']+_video_[^\s"\']+)', r_pl.text)
    aud_paths = re.findall(r'URI="(/v1/edge/streams/[^\s"\']+_audio_[^\s"\']+)"', r_pl.text)
    if vid_paths:
        v_url = base_host + vid_paths[-1]
        r_v = s.get(v_url, timeout=10)
        print("Video chunklist status:", r_v.status_code, "head:\n", r_v.text[:600], flush=True)
        cmd3 = [
            "ffmpeg", "-y",
            "-user_agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            "-headers", f"Referer: https://chaturbate.com/{model}/\r\nOrigin: https://chaturbate.com\r\n",
            "-i", v_url,
        ]
        if aud_paths:
            cmd3 += [
                "-user_agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
                "-headers", f"Referer: https://chaturbate.com/{model}/\r\nOrigin: https://chaturbate.com\r\n",
                "-i", base_host + aud_paths[0],
            ]
        cmd3 += ["-t", "6", "-c", "copy", "test_sub.mp4"]
        p3 = subprocess.run(cmd3, capture_output=True, text=True, timeout=25)
        print("ffmpeg sub rc:", p3.returncode, "size:", os.path.getsize("test_sub.mp4") if os.path.exists("test_sub.mp4") else 0, flush=True)
        print("ffmpeg sub stderr tail:", p3.stderr[-600:], flush=True)
