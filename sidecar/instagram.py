"""Instagram stories / highlights helper for the SaveLink sidecar.

Instagram serves story data only to a logged-in web session, and it rejects
plain HTTP clients from datacenter IPs. Cloudflare Workers have neither a
browser TLS fingerprint nor a movable IP, so this module talks to Instagram
through curl_cffi (real Chrome fingerprint) and an optional proxy.

Configuration (sidecar environment)
  IG_COOKIE       full cookie header copied from a logged-in instagram.com tab
  IG_PROXY        optional http(s) proxy used for Instagram requests only
  IG_IMPERSONATE  curl_cffi target profile, default "chrome"

Endpoints
  GET /ig/stories?username=...
  GET /ig/highlights?username=...
  GET /ig/highlight-items?id=highlight:123  (or 123)
  GET /ig/whoami                            (session smoke test)
"""

from __future__ import annotations

import os
import re
import time
from typing import Any, Optional

from curl_cffi import requests as crequests
from fastapi import APIRouter, Header, HTTPException, Query

TOKEN = os.getenv("YTDLP_TOKEN", "")
COOKIE = os.getenv("IG_COOKIE", "").strip()
PROXY = os.getenv("IG_PROXY", "").strip()
IMPERSONATE = os.getenv("IG_IMPERSONATE", "chrome").strip() or "chrome"

STORIES_DOC_ID = os.getenv("IG_STORIES_DOC_ID", "29341065465524437")
HIGHLIGHTS_DOC_ID = os.getenv("IG_HIGHLIGHTS_DOC_ID", "26970053832668570")
WEB_APP_ID = "936619743392459"

router = APIRouter(prefix="/ig", tags=["instagram"])

_dtsg: Optional[str] = None
_dtsg_at: float = 0.0


def _authorize(authorization: str) -> None:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def _session() -> crequests.Session:
    kwargs: dict[str, Any] = {"impersonate": IMPERSONATE}
    if PROXY:
        kwargs["proxy"] = PROXY
    return crequests.Session(**kwargs)


def _csrf() -> str:
    match = re.search(r"csrftoken=([^;]+)", COOKIE)
    return match.group(1) if match else ""


def _headers(referer: str = "https://www.instagram.com/") -> dict[str, str]:
    return {
        "cookie": COOKIE,
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "x-ig-app-id": WEB_APP_ID,
        "x-asbd-id": "129477",
        "x-ig-www-claim": "0",
        "x-csrftoken": _csrf(),
        "x-requested-with": "XMLHttpRequest",
        "referer": referer,
        "origin": "https://www.instagram.com",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
    }


def _require_cookie() -> None:
    if not COOKIE:
        raise HTTPException(status_code=503, detail="IG_COOKIE is not set on the sidecar")


def _json(response: Any, label: str) -> Any:
    """Instagram answers an unauthenticated client with its HTML login shell."""
    body = response.text or ""
    if "text/html" in (response.headers.get("content-type") or "") or body.lstrip().startswith("<"):
        raise HTTPException(
            status_code=401,
            detail=f"{label}: Instagram refused the session (login wall). Refresh IG_COOKIE.",
        )
    try:
        import json

        payload = json.loads(body)
    except ValueError as error:  # pragma: no cover - defensive
        raise HTTPException(status_code=502, detail=f"{label}: invalid JSON from Instagram") from error
    if isinstance(payload, dict) and payload.get("status") == "fail":
        raise HTTPException(
            status_code=401,
            detail=f"{label}: {payload.get('message') or 'Instagram refused the session'}",
        )
    return payload


def _graphql(label: str, doc_id: str, variables: dict[str, Any], referer: str) -> Any:
    global _dtsg, _dtsg_at
    _require_cookie()
    if not _dtsg or time.time() - _dtsg_at > 3600:
        with _session() as session:
            home = session.get("https://www.instagram.com/", headers=_headers(), timeout=25)
        match = re.search(r'\["DTSGInitialData",\[\],\{"token":"([^"]+)"', home.text or "") or re.search(
            r'"DTSGInitData",\[\],\{"token":"([^"]+)"', home.text or ""
        )
        if not match:
            raise HTTPException(
                status_code=401,
                detail="Instagram did not return a session token (fb_dtsg). Refresh IG_COOKIE.",
            )
        _dtsg, _dtsg_at = match.group(1), time.time()

    import json

    friendly = {
        "stories": "PolarisStoriesV3ReelPageStandaloneQuery",
        "highlights": "PolarisProfileStoryHighlightsTrayContentQuery",
    }[label]
    body = [
        ("fb_api_req_friendly_name", friendly),
        ("variables", json.dumps(variables)),
        ("doc_id", doc_id),
        ("fb_dtsg", _dtsg),
    ]
    with _session() as session:
        response = session.post(
            "https://www.instagram.com/api/graphql",
            headers={**_headers(referer), "content-type": "application/x-www-form-urlencoded",
                     "x-fb-friendly-name": friendly},
            data=body,
            timeout=30,
        )
    return _json(response, label)


def _user_id(username: str) -> str:
    """Public embed is enough for the numeric id and needs no session."""
    handle = username.lstrip("@").strip()
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle):
        raise HTTPException(status_code=422, detail="invalid username")
    _require_cookie()
    with _session() as session:
        embed = session.get(
            f"https://www.instagram.com/{handle}/embed/",
            headers={"cookie": COOKIE, "accept": "text/html", "accept-language": "en-US,en;q=0.9"},
            timeout=25,
        )
    match = re.search(r'data-owner-id="(\d+)"', embed.text or "")
    if match:
        return match.group(1)
    payload = _json(
        session.get(
            f"https://www.instagram.com/api/v1/users/web_profile_info/?username={handle}",
            headers=_headers(),
            timeout=25,
        ),
        "profile",
    )
    user_id = ((payload or {}).get("data") or {}).get("user", {}).get("id")
    if not user_id:
        raise HTTPException(status_code=404, detail=f"@{handle}: private or not found")
    return str(user_id)


def _reel_items(raw: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for entry in raw or []:
        if not isinstance(entry, dict):
            continue
        videos = entry.get("video_versions") or []
        if entry.get("media_type") == 2 or videos:
            video = videos[0] if videos else None
            if not video or not video.get("url"):
                continue
            items.append(
                {
                    "kind": "video",
                    "url": video["url"],
                    "ext": "mp4",
                    "mime": "video/mp4",
                    "width": video.get("width"),
                    "height": video.get("height"),
                    "referer": "https://www.instagram.com/",
                }
            )
            continue
        candidates = ((entry.get("image_versions2") or {}).get("candidates")) or []
        image = candidates[0] if candidates else None
        if not image or not image.get("url"):
            continue
        items.append(
            {
                "kind": "image",
                "url": image["url"],
                "ext": "jpg",
                "mime": "image/jpeg",
                "width": image.get("width"),
                "height": image.get("height"),
                "referer": "https://www.instagram.com/",
            }
        )
    return items


def _reel_from_feed(reel_id: str) -> Optional[dict[str, Any]]:
    """Legacy private API, used when the web GraphQL query returns nothing."""
    _require_cookie()
    path = f"/api/v1/feed/reels_media/?reel_ids={reel_id}"
    for host in ("https://i.instagram.com", "https://www.instagram.com"):
        with _session() as session:
            response = session.get(f"{host}{path}", headers=_headers(), timeout=25)
        if "text/html" in (response.headers.get("content-type") or ""):
            continue
        try:
            import json

            payload = json.loads(response.text or "{}")
        except ValueError:
            continue
        if payload.get("status") == "fail":
            continue
        reels = payload.get("reels") or {}
        if isinstance(reels, dict) and reels.get(reel_id):
            return reels[reel_id]
        for reel in payload.get("reels_media") or []:
            if str(reel.get("id")) == str(reel_id):
                return reel
    return None


@router.get("/whoami")
def whoami(authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    _require_cookie()
    with _session() as session:
        response = session.get(
            "https://www.instagram.com/api/v1/accounts/current_user/?edit=true",
            headers=_headers(),
            timeout=25,
        )
    payload = _json(response, "whoami")
    user = (payload or {}).get("user") or {}
    return {"ok": True, "username": user.get("username"), "pk": user.get("pk")}


@router.get("/stories")
def stories(username: str = Query(...), authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    user_id = _user_id(username)
    try:
        payload = _graphql("stories", STORIES_DOC_ID, {"reel_ids_arr": [user_id]},
                           f"https://www.instagram.com/stories/{username.lstrip('@')}/")
        reel = (((payload or {}).get("data") or {}).get("xdt_api__v1__feed__reels_media") or {}).get("reels_media") or []
        reel = reel[0] if reel else None
    except HTTPException:
        reel = _reel_from_feed(user_id)
    if reel is None:
        raise HTTPException(status_code=502, detail="stories: Instagram returned no reel data")
    return {
        "username": username.lstrip("@"),
        "updatedAt": reel.get("latest_reel_media"),
        "items": _reel_items(reel.get("items")),
    }


@router.get("/highlights")
def highlights(username: str = Query(...), authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    user_id = _user_id(username)
    handle = username.lstrip("@")

    try:
        payload = _graphql("highlights", HIGHLIGHTS_DOC_ID, {"user_id": user_id}, f"https://www.instagram.com/{handle}/")
        edges = (((payload or {}).get("data") or {}).get("highlights") or {}).get("edges") or []
    except HTTPException:
        edges = []

    tray: list[dict[str, Any]] = []
    if edges:
        for edge in edges:
            node = (edge or {}).get("node") or {}
            if not node.get("id"):
                continue
            tray.append(
                {
                    "id": str(node["id"]),
                    "title": str(node.get("title") or "Highlight")[:40],
                    "count": node.get("media_count") if isinstance(node.get("media_count"), int) else 0,
                }
            )
        return {"username": handle, "highlights": tray}

    _require_cookie()
    with _session() as session:
        response = session.get(
            f"https://i.instagram.com/api/v1/highlights/{user_id}/highlights_tray/",
            headers=_headers(),
            timeout=25,
        )
    payload = _json(response, "highlights")
    for entry in (payload or {}).get("tray") or []:
        if not entry.get("id"):
            continue
        tray.append(
            {
                "id": str(entry["id"]),
                "title": str(entry.get("title") or "Highlight")[:40],
                "count": entry.get("media_count") if isinstance(entry.get("media_count"), int) else 0,
            }
        )
    return {"username": handle, "highlights": tray}


@router.get("/highlight-items")
def highlight_items(id: str = Query(...), authorization: str = Header(default="")) -> dict:
    _authorize(authorization)
    reel_id = id if id.startswith("highlight:") else f"highlight:{id}"

    try:
        payload = _graphql("stories", STORIES_DOC_ID, {"reel_ids_arr": [reel_id]},
                           f"https://www.instagram.com/stories/highlights/{reel_id.replace('highlight:', '')}/")
        reel = (((payload or {}).get("data") or {}).get("xdt_api__v1__feed__reels_media") or {}).get("reels_media") or []
        reel = reel[0] if reel else None
    except HTTPException:
        reel = None
    if reel is None:
        reel = _reel_from_feed(reel_id)
    if reel is None:
        raise HTTPException(status_code=502, detail="highlight: Instagram returned no media")

    return {
        "title": reel.get("title"),
        "items": _reel_items(reel.get("items")),
    }
