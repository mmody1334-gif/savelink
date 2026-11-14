# Stripchat Mouflon v2 Decryption Plugin for Streamlink
# Bypasses Stripchat's anti-scraping and teaser ad loop (Mouflon PSCH v1/v2)
from __future__ import annotations
import logging
import re
import base64
import random
import string
import hashlib
import functools
from streamlink.plugin import Plugin, pluginmatcher
from streamlink.stream.hls import HLSStream, HLSStreamWorker, HLSStreamReader
from streamlink.exceptions import StreamError

log = logging.getLogger(__name__)

# ====================== Key Map ======================
KEY_MAP = {
  "Zokee2OhPh9kugh4": "Quean4cai9boJa5a",
  "Zeechoej4aleeshi": "ubahjae7goPoodi6",
  "Ook7quaiNgiyuhai": "EQueeGh2kaewa3ch",
  "Fq6m2TO2ZeBkRPm9": "xb6di1NF9EFXHUwb",
  "GrRncsoByZmsiT6L": "NigHYyOD9l4rvAEb",
  "1Dzcc6OjP73LKbtI": "Y64UVwX5RrIWnOLp",
  "N2oLovTIXb0o28Uj": "ABE7Sj8jh3oPM2ae",
  "NTK9aqcLmNFMWrpQ": "tOcYOap4Ty1l9Jzb",
  "7uUnbD0jMCB9GH32": "lzCQ6QBTnLpB0zMF",
  "Ohi7eTRBpkAuML0l": "kExe29N2sLFrHGqu",
  "OLzu7QlySkG2fVRn": "CsovScFH9VirSJ4Z"
}
DEFAULT_PKEY = "Zokee2OhPh9kugh4"
DEFAULT_KEY = KEY_MAP[DEFAULT_PKEY]
FALLBACK_PKEY_V2 = "Fq6m2TO2ZeBkRPm9"

# ====================== Decryption Core ======================
class MouflonDecryptor:
    @staticmethod
    def get_pkey(text: str) -> str:
        m = re.search(r"#EXT-X-MOUFLON:PSCH:(?:v1|v2):([^\s,]+)", text)
        pkey = m.group(1) if m else DEFAULT_PKEY
        return pkey if pkey in KEY_MAP else DEFAULT_PKEY

    @staticmethod
    def decode_v1(enc: str, key: str) -> str:
        enc += "=" * ((4 - len(enc) % 4) % 4)
        data = base64.b64decode(enc)
        kh = hashlib.sha256(key.encode()).digest()
        return bytes(b ^ kh[i % 32] for i, b in enumerate(data)).decode("utf-8", errors="ignore")

class MouflonV2Decryptor:
    @classmethod
    @functools.lru_cache(maxsize=256)
    def decode(cls, encrypted: str, key_v2: str) -> str:
        try:
            reversed_token = encrypted[::-1]
            reversed_token += "=" * ((4 - len(reversed_token) % 4) % 4)
            data = base64.b64decode(reversed_token)
            key_hash = hashlib.sha256(key_v2.encode("utf-8")).digest()
            decrypted_bytes = bytearray(b ^ key_hash[i % 32] for i, b in enumerate(data))
            return decrypted_bytes.decode("utf-8", errors="replace")
        except Exception as e:
            log.error(f"[v2] Decrypt error: {e}")
            return encrypted

class DecryptWorker(HLSStreamWorker):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.current_pkey = DEFAULT_PKEY
        self.current_key = DEFAULT_KEY

    def _fetch_playlist(self):
        res = self.session.http.get(self.stream.url, exception=StreamError, **self.reader.request_params)
        res.encoding = "utf-8"
        text = res.text
        
        new_pkey = MouflonDecryptor.get_pkey(text)
        if new_pkey != self.current_pkey:
            self.current_pkey = new_pkey
            self.current_key = KEY_MAP.get(new_pkey, DEFAULT_KEY)

        lines = text.splitlines()
        new_lines = []
        i = 0
        while i < len(lines):
            if lines[i].startswith("#EXT-X-MOUFLON:FILE:"):
                enc = lines[i].split(":", 2)[2]
                real = MouflonDecryptor.decode_v1(enc, self.current_key)
                new_lines.append("#DECRYPTED")
                if i + 1 < len(lines):
                    new_lines.append(real)
                i += 2
                continue
            new_lines.append(lines[i])
            i += 1
        res._content = "\n".join(new_lines).encode("utf-8")
        return res

class DecryptHLSStreamReader(HLSStreamReader):
    __worker__ = DecryptWorker

class DecryptHLSStream(HLSStream):
    __reader__ = DecryptHLSStreamReader

class DecryptWorkerV2(HLSStreamWorker):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.current_key_v2 = KEY_MAP[FALLBACK_PKEY_V2]

    def _fetch_playlist(self):
        res = self.session.http.get(self.stream.url, exception=StreamError, **self.reader.request_params)
        res.encoding = "utf-8"
        text = res.text

        extracted_pkey = None
        m = re.search(r"#EXT-X-MOUFLON:PSCH:v2:([^\s,]+)", text)
        if m:
            extracted_pkey = m.group(1)
        else:
            url_match = re.search(r"[?&]pkey=([^&]+)", self.stream.url)
            if url_match:
                extracted_pkey = url_match.group(1)

        if extracted_pkey and extracted_pkey in KEY_MAP:
            active_pkey = extracted_pkey
        else:
            active_pkey = FALLBACK_PKEY_V2

        self.current_key_v2 = KEY_MAP[active_pkey]

        lines = text.splitlines()
        new_lines = []
        i = 0
        while i < len(lines):
            line = lines[i]
            if line.startswith("#EXT-X-MOUFLON:URI:"):
                mouflon_uri = line.split(":", 2)[2]
                match = re.search(r'_([A-Za-z0-9+/=]{10,})', mouflon_uri)
                if match:
                    token = match.group(1)
                    decrypted = MouflonV2Decryptor.decode(token, self.current_key_v2)
                    real_uri = mouflon_uri.replace(token, decrypted)
                    new_lines.append(real_uri)
                    i += 2
                    continue
            new_lines.append(line)
            i += 1
        res._content = "\n".join(new_lines).encode("utf-8")
        return res

class DecryptHLSStreamReaderV2(HLSStreamReader):
    __worker__ = DecryptWorkerV2

class DecryptHLSStreamV2(HLSStream):
    __reader__ = DecryptHLSStreamReaderV2

@pluginmatcher(re.compile(r"https?://(?:[\w-]+\.)?(?:stripchat\.com|stripol\.com|xlivesex\.com|stripchats\.io)/([^/?#]+)", re.I))
@pluginmatcher(re.compile(r"https?://[^\?]*\.doppiocdn\.(?:com|org|live|net|media)/.*\.m3u8", re.I))
class Stripchat(Plugin):
    def _sanitize_url_pkey(self, url: str) -> str:
        m = re.search(r"([?&]pkey=)([^&]+)", url)
        if m:
            pkey_val = m.group(2)
            if pkey_val not in KEY_MAP:
                url = url.replace(f"pkey={pkey_val}", f"pkey={FALLBACK_PKEY_V2}")
        return url

    def _get_streams(self):
        if "doppiocdn" in self.url:
            target_url = self._sanitize_url_pkey(self.url)
            text = self.session.http.get(target_url).text
            if "#EXT-X-STREAM-INF" in text:
                streams = HLSStream.parse_variant_playlist(self.session, target_url)
                final = {}
                for name, s in streams.items():
                    sub_url = self._sanitize_url_pkey(s.url)
                    txt = self.session.http.get(sub_url).text
                    if "#EXT-X-MOUFLON:URI:" in txt:
                        final[name] = DecryptHLSStreamV2(self.session, sub_url)
                    else:
                        final[name] = DecryptHLSStream(self.session, sub_url)
                return final

            if "#EXT-X-MOUFLON:URI:" in text:
                return {"live": DecryptHLSStreamV2(self.session, target_url)}
            return {"live": DecryptHLSStream(self.session, target_url)}

        username = self.match.group(1)
        username = re.sub(r"/(?:videos?|vod|clips?|archive)/?$", "", username, flags=re.I)
        log.info(f"[plugin] Resolving Stripchat live model: {username}")

        base_urls = [
            "https://zh.xlivesex.com",
            "https://zh.stripchats.io",
            "https://zh.stripol.com",
            "https://zh.stripchat.com",
            "https://stripchat.com"
        ]

        headers = {
            "Referer": self.url,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "x-device-info": '{"t":"webMobile","v":"1.0","ui":24631221}'
        }

        for base_url in base_urls:
            uniq = ''.join(random.choices(string.ascii_lowercase + string.digits, k=16))
            try:
                user_id_url = f"{base_url}/api/front/users/user-ids/{username}?{uniq}"
                user_id_response = self.session.http.get(user_id_url, headers=headers, timeout=10)
                
                if user_id_response.status_code == 200:
                    user_id_data = user_id_response.json()
                    model_id = user_id_data.get("id")
                    if model_id:
                        api = f"{base_url}/api/front/v2/models/{model_id}/cam?timezoneOffset=0&triggerRequest=loadCam&uniq={uniq}"
                        res = self.session.http.get(api, headers=headers, timeout=10)
                        
                        if res.status_code == 200:
                            data = res.json()
                            cam = data.get("cam", {})
                            user_data = data.get("user", {})
                            uid = user_data.get("user", {}).get("id") or user_data.get("id") or model_id
                            
                            # Check if model is offline or in a private / ticket show
                            if not uid or cam.get("show") or not cam.get("isCamAvailable", False):
                                log.info(f"[plugin] Model {username} is offline or in a private/ticket show.")
                                return {}

                            log.info(f"[plugin] Model {username} is live (UID: {uid}), resolving Mouflon stream...")
                            
                            auto = f"https://edge-hls.doppiocdn.com/hls/{uid}/master/{uid}_auto.m3u8"
                            text = self.session.http.get(auto).text
                            
                            m = re.search(r"#EXT-X-MOUFLON:PSCH:v2:([^\s]+)", text)
                            pkey = m.group(1) if m else DEFAULT_PKEY
                            
                            if pkey not in KEY_MAP:
                                pkey = FALLBACK_PKEY_V2
                            
                            master = f"{auto}?psch=v2&pkey={pkey}&_HLS_msn=1&_HLS_part=0"
                            streams = HLSStream.parse_variant_playlist(self.session, master)
                            
                            final = {}
                            for name, s in streams.items():
                                txt = self.session.http.get(s.url).text
                                if "#EXT-X-MOUFLON:URI:" in txt:
                                    final[name] = DecryptHLSStreamV2(self.session, s.url)
                                else:
                                    final[name] = DecryptHLSStream(self.session, s.url)
                            return final
            except Exception as e:
                log.debug(f"[plugin] Node {base_url} error: {e}")
                continue

        return {}

__plugin__ = Stripchat
