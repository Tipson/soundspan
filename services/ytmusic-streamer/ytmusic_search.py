"""Search normalization, parsing, caching, and HTTP routes."""

import asyncio
import random
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal, cast

import requests
from fastapi import HTTPException, Query
from ytmusic_client import (
    SEARCH_MODE,
    _invalidate_ytmusic,
    _is_issue_813_invalid_argument_error,
    _is_oauth_auth_error,
    _resolve_user_search_strategy,
    _run_public_ytmusic,
    _run_public_ytmusic_with_retry,
    _run_ytmusic_with_auth_retry,
    _ytmusic_auto_tv_fallback_users,
)
from ytmusic_models import BatchSearchQuery, BatchSearchRequest, SearchRequest
from ytmusic_runtime import JsonList, JsonObject, _bound_cache, _sanitized_http_error, app, log
from ytmusicapi import YTMusic

from services.common.sidecar_runtime_utils import env_float, env_int

# Max queries accepted in a single batch search request.
_BATCH_SEARCH_MAX_QUERIES = 50
BATCH_CONCURRENCY = env_int("YTMUSIC_BATCH_CONCURRENCY", "3")
_batch_semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)
BATCH_DELAY_MIN = env_float("YTMUSIC_BATCH_DELAY_MIN", "0.3")
BATCH_DELAY_MAX = env_float("YTMUSIC_BATCH_DELAY_MAX", "1.0")

# Public catalog search is latency-sensitive: the backend gives each sidecar
# request eight seconds before using partial results. Keep both the provider
# transport and this endpoint inside that budget, and never queue work behind
# blocked provider threads.
SEARCH_PROVIDER_CONCURRENCY = 3
SEARCH_PROVIDER_REQUEST_TIMEOUT_SECONDS = 5.0
SEARCH_ENDPOINT_TIMEOUT_SECONDS = 6.0
_SEARCH_PROVIDER_DRAIN_SECONDS = 6.0
_SEARCH_PROVIDER_CAPACITY_DETAIL = "YouTube Music search capacity is temporarily exhausted"
_SEARCH_PROVIDER_TIMEOUT_DETAIL = "YouTube Music search timed out"
_SearchProviderResult = tuple[JsonList, Literal["tv", "native"]]
_SearchProviderJob = asyncio.Future[_SearchProviderResult]


class _SearchProviderDeadlineError(TimeoutError):
    """Identify expiry of the sidecar-owned search endpoint deadline."""


_search_provider_executor = ThreadPoolExecutor(
    max_workers=SEARCH_PROVIDER_CONCURRENCY,
    thread_name_prefix="ytmusic-search-provider",
)
_search_provider_jobs: set[_SearchProviderJob] = set()
_search_provider_admitting = True

# Search result cache (in-memory, short TTL to reduce duplicate requests).
_search_cache: dict[str, JsonObject] = {}
_search_cache_lock = threading.Lock()
SEARCH_CACHE_TTL = env_int("YTMUSIC_SEARCH_CACHE_TTL", "300")  # 5 minutes
SEARCH_CACHE_MAX = env_int("YTMUSIC_SEARCH_CACHE_MAX", "1024")
_PLAYABLE_VIDEO_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _parse_duration_text_value(value: Any) -> int:
    """
    Parse "mm:ss" or "hh:mm:ss" duration strings to seconds.
    Returns 0 when missing/invalid.
    """
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    text = str(value or "").strip()
    if ":" not in text:
        return 0
    parts = text.split(":")
    try:
        parts_int = [int(p) for p in parts]
    except ValueError:
        return 0
    if len(parts_int) == 3:
        return parts_int[0] * 3600 + parts_int[1] * 60 + parts_int[2]
    if len(parts_int) == 2:
        return parts_int[0] * 60 + parts_int[1]
    return 0


def _normalize_native_search_item(item: object) -> JsonObject | None:
    """
    Normalize search results into the connector shim shape used by the backend.
    This accepts both native `yt.search()` items and TV-parser candidates.
    """
    if not isinstance(item, dict):
        return None

    result_type = str(item.get("resultType") or item.get("type") or "").strip()
    normalized_type = result_type.lower() if result_type else "unknown"

    artists_value = item.get("artists")
    artist_names: list[str] = []
    if isinstance(artists_value, list):
        for artist in artists_value:
            if isinstance(artist, dict):
                name = str(artist.get("name") or "").strip()
                if name:
                    artist_names.append(name)
            elif isinstance(artist, str):
                name = artist.strip()
                if name:
                    artist_names.append(name)

    primary_artist = (
        artist_names[0]
        if artist_names
        else str(item.get("artist") or item.get("author") or "Unknown").strip()
    )
    if not primary_artist:
        primary_artist = "Unknown"

    thumbnails = item.get("thumbnails")
    if not isinstance(thumbnails, list):
        thumbnails = []

    browse_id = str(item.get("browseId") or "").strip()
    if normalized_type == "album":
        title = str(item.get("title") or "").strip()
        if not browse_id or not title:
            return None
        year = str(item.get("year") or "").strip()
        is_explicit = item.get("isExplicit")
        return {
            "type": "album",
            "browseId": browse_id,
            "title": title,
            "artist": primary_artist,
            "artists": artist_names or ([primary_artist] if primary_artist != "Unknown" else []),
            "year": year or None,
            "thumbnails": thumbnails,
            "isExplicit": bool(is_explicit) if is_explicit is not None else False,
        }

    if normalized_type == "artist":
        channel_id = str(item.get("channelId") or browse_id).strip()
        artist_name = str(item.get("artist") or item.get("name") or item.get("title") or "").strip()
        if not channel_id or not artist_name:
            return None
        return {
            "type": "artist",
            "browseId": browse_id or channel_id,
            "channelId": channel_id,
            "title": artist_name,
            "artist": artist_name,
            "thumbnails": thumbnails,
        }

    video_id = item.get("videoId")
    if not video_id:
        # Songs/videos must stay directly playable for matching.
        return None

    album = item.get("album")
    album_name: str | None = None
    if isinstance(album, dict):
        name = str(album.get("name") or "").strip()
        album_name = name or None
    elif isinstance(album, str):
        name = album.strip()
        album_name = name or None

    duration = item.get("duration")
    duration_seconds_raw = item.get("duration_seconds")
    if not isinstance(duration_seconds_raw, int):
        duration_seconds_raw = item.get("durationSeconds")
    duration_seconds = _parse_duration_text_value(
        duration_seconds_raw if duration_seconds_raw is not None else duration
    )

    title = str(item.get("title") or "").strip() or "Unknown"
    is_explicit = item.get("isExplicit")
    return {
        "type": normalized_type,
        "videoId": str(video_id),
        "title": title,
        "artist": primary_artist,
        "artists": artist_names,
        "album": album_name,
        "duration": str(duration or ""),
        "duration_seconds": duration_seconds,
        "thumbnails": thumbnails,
        "isExplicit": bool(is_explicit) if is_explicit is not None else False,
    }


def _native_search(
    yt: YTMusic,
    query: str,
    filter: Literal["songs", "albums", "artists", "videos"] | None = None,
    limit: int = 20,
) -> JsonList:
    """Execute yt.search() and normalize results to sidecar response shape."""
    raw_items: object = yt.search(query, filter=filter, limit=limit)
    if not isinstance(raw_items, list):
        return []

    normalized: JsonList = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        mapped = _normalize_native_search_item(item)
        if mapped:
            normalized.append(mapped)
    return normalized[:limit]


def _tv_search(yt: YTMusic, query: str, filter: str | None = None, limit: int = 20) -> JsonList:
    """
    WORKAROUND(#813) — Custom search parser for the TVHTML5 client.

    The standard yt.search() cannot parse the TV response format, so we
    call yt._send_request("search", ...) directly and parse the
    TV-specific renderers ourselves.

    REVERT: delete this entire function and restore the original
    search() endpoint that calls yt.search().  See the workaround
    registry at the top of this file for full instructions.

    Returns a list of dicts with keys: type, videoId, title, artist(s),
    album, duration, duration_seconds, thumbnails, etc.
    """
    body: JsonObject = {"query": query}

    # Apply filter params (song-only search).
    # For TVHTML5 the filter encoding is the same as WEB_REMIX.
    if filter == "songs":
        body["params"] = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    elif filter == "videos":
        body["params"] = "EgWKAQIQAWoMEA4QChADEAQQCRAF"
    elif filter == "albums":
        body["params"] = "EgWKAQIYAWoMEA4QChADEAQQCRAF"
    elif filter == "artists":
        body["params"] = "EgWKAQIgAWoMEA4QChADEAQQCRAF"

    try:
        raw = yt._send_request("search", body)
    except Exception:
        raise  # let caller handle

    items: JsonList = []
    seen_result_ids: set[str] = set()

    def _as_object(value: Any) -> JsonObject:
        """Return one provider value as an object or an empty object."""
        return value if isinstance(value, dict) else {}

    def _as_list(value: Any) -> list[Any]:
        """Return one provider value as a list or an empty list."""
        return value if isinstance(value, list) else []

    def _nested_object(value: Any, *keys: str) -> JsonObject:
        """Safely descend through provider-owned object fields."""
        current = value
        for key in keys:
            current = _as_object(current).get(key)
        return _as_object(current)

    def _extract_text(obj: Any) -> str:
        """Pull text from classic renderer text or view-model content."""
        if not obj:
            return ""
        if isinstance(obj, str):
            return obj
        if not isinstance(obj, dict):
            return ""
        content = obj.get("content")
        if isinstance(content, str):
            return content
        simple_text = obj.get("simpleText")
        if isinstance(simple_text, str):
            return simple_text
        runs = obj.get("runs")
        if isinstance(runs, list):
            return "".join(
                text
                for run in runs
                if isinstance(run, dict) and isinstance((text := run.get("text")), str)
            )
        return ""

    def _parse_duration_text(text: str) -> int:
        """Convert '3:45' or '1:02:30' to seconds."""
        parts = text.strip().split(":")
        try:
            parts_int = [int(p) for p in parts]
        except ValueError:
            return 0
        if len(parts_int) == 3:
            return parts_int[0] * 3600 + parts_int[1] * 60 + parts_int[2]
        if len(parts_int) == 2:
            return parts_int[0] * 60 + parts_int[1]
        return 0

    def _parse_duration_label(text: str) -> int:
        """
        Parse human-readable accessibility labels like:
        - "3 minutes, 45 seconds"
        - "1 hour, 2 minutes, 5 seconds"
        """
        if not text:
            return 0
        lower = text.lower()
        hours = re.search(r"(\d+)\s*hour", lower)
        minutes = re.search(r"(\d+)\s*minute", lower)
        seconds = re.search(r"(\d+)\s*second", lower)
        if not any((hours, minutes, seconds)):
            return 0
        return (
            (int(hours.group(1)) * 3600 if hours else 0)
            + (int(minutes.group(1)) * 60 if minutes else 0)
            + (int(seconds.group(1)) if seconds else 0)
        )

    def _is_metadata_noise(text: str) -> bool:
        """Detect metadata tokens that are not artist/album labels."""
        value = (text or "").strip().lower()
        if not value or value == "\u2022":
            return True
        return bool(
            re.search(
                r"\b(view|views|ago|subscriber|subscribers|episode|episodes|song|songs)\b",
                value,
            )
        )

    def _append_item(item: JsonObject) -> None:
        """Append one normalized result while preserving first-seen order."""
        video_id = str(item.get("videoId") or "")
        result_type = str(item.get("type") or "").lower()
        if filter == "albums" and result_type != "album":
            return
        if filter == "artists" and result_type != "artist":
            return
        if video_id:
            if _PLAYABLE_VIDEO_ID_PATTERN.fullmatch(video_id) is None:
                return
            identity = f"video:{video_id}"
        elif result_type == "album":
            browse_id = str(item.get("browseId") or "").strip()
            if not browse_id:
                return
            identity = f"album:{browse_id}"
        elif result_type == "artist":
            channel_id = str(item.get("channelId") or item.get("browseId") or "").strip()
            if not channel_id:
                return
            identity = f"artist:{channel_id}"
        else:
            return
        if identity in seen_result_ids:
            return
        seen_result_ids.add(identity)
        items.append(item)

    def _walk_renderers(node: Any, depth: int = 0) -> None:
        """Recursively walk the TV response tree and extract results."""
        if depth > 15 or len(items) >= limit:
            return
        if isinstance(node, dict):
            # ── lockupViewModel (current TVHTML5 search) ──
            if "lockupViewModel" in node:
                r = node["lockupViewModel"]
                if not isinstance(r, dict):
                    return

                content_type = str(r.get("contentType") or "")
                is_track_content = content_type in {
                    "LOCKUP_CONTENT_TYPE_MUSIC",
                    "LOCKUP_CONTENT_TYPE_VIDEO",
                }
                is_explicit_album = "ALBUM" in content_type
                is_explicit_artist = "ARTIST" in content_type
                is_album_content = is_explicit_album or (
                    not is_explicit_artist and filter == "albums"
                )
                is_artist_content = is_explicit_artist or (
                    not is_explicit_album and filter == "artists"
                )
                if not (is_track_content or is_album_content or is_artist_content):
                    return

                watch_endpoint = _nested_object(
                    r,
                    "rendererContext",
                    "commandContext",
                    "onTap",
                    "innertubeCommand",
                    "watchEndpoint",
                )
                watch_video_id = str(watch_endpoint.get("videoId") or "")
                content_id = str(r.get("contentId") or "")
                if _PLAYABLE_VIDEO_ID_PATTERN.fullmatch(watch_video_id):
                    video_id = watch_video_id
                elif _PLAYABLE_VIDEO_ID_PATTERN.fullmatch(content_id):
                    video_id = content_id
                else:
                    video_id = ""

                browse_endpoint = _nested_object(
                    r,
                    "rendererContext",
                    "commandContext",
                    "onTap",
                    "innertubeCommand",
                    "browseEndpoint",
                )
                browse_id = str(browse_endpoint.get("browseId") or "")
                if not browse_id and not video_id:
                    browse_id = content_id

                # TVHTML5 can return channels and ordinary playlists inside an
                # album-filtered response. Only native album identities and TV
                # OLAK album-playlist identities have a supported browse path.
                if filter == "albums" and not browse_id.startswith(("MPRE", "VLOLAK5uy_")):
                    return

                if not video_id and browse_id and (is_album_content or is_artist_content):
                    metadata = _nested_object(r, "metadata", "lockupMetadataViewModel")
                    title_text = _extract_text(metadata.get("title")) or "Unknown"
                    rows = _as_list(
                        _nested_object(
                            metadata,
                            "metadata",
                            "contentMetadataViewModel",
                        ).get("metadataRows")
                    )
                    primary_values: list[str] = []
                    if rows:
                        first_row_parts = _as_list(_as_object(rows[0]).get("metadataParts"))
                        primary_values = [
                            value
                            for part_value in first_row_parts
                            if (value := _extract_text(_as_object(part_value).get("text")))
                            and not _is_metadata_noise(value)
                        ]
                    thumbnail_view = _nested_object(r, "contentImage", "thumbnailViewModel")
                    thumbnails = _as_list(_nested_object(thumbnail_view, "image").get("sources"))

                    if is_album_content:
                        artist_name = primary_values[0] if primary_values else "Unknown"
                        year = next(
                            (
                                value
                                for value in primary_values[1:]
                                if re.fullmatch(r"\d{4}", value)
                            ),
                            None,
                        )
                        _append_item(
                            {
                                "type": "album",
                                "browseId": browse_id,
                                "title": title_text,
                                "artist": artist_name,
                                "artists": [artist_name] if artist_name != "Unknown" else [],
                                "year": year,
                                "thumbnails": thumbnails,
                                "isExplicit": False,
                            }
                        )
                    else:
                        _append_item(
                            {
                                "type": "artist",
                                "browseId": browse_id,
                                "channelId": browse_id,
                                "title": title_text,
                                "artist": title_text,
                                "thumbnails": thumbnails,
                            }
                        )
                    return

                if video_id:
                    metadata = _nested_object(r, "metadata", "lockupMetadataViewModel")
                    title_text = _extract_text(metadata.get("title")) or "Unknown"
                    rows = _as_list(
                        _nested_object(
                            metadata,
                            "metadata",
                            "contentMetadataViewModel",
                        ).get("metadataRows")
                    )
                    artist_name = ""
                    album_name = None
                    if rows:
                        first_row_parts = _as_list(_as_object(rows[0]).get("metadataParts"))
                        primary_values = [
                            value
                            for part_value in first_row_parts
                            if (value := _extract_text(_as_object(part_value).get("text")))
                            and not _is_metadata_noise(value)
                        ]
                        if primary_values:
                            artist_name = primary_values[0]
                            if len(primary_values) > 1:
                                album_name = primary_values[1]

                    if not artist_name and " - " in title_text:
                        artist_name = title_text.split(" - ", 1)[0].strip()
                    if not artist_name:
                        artist_name = "Unknown"

                    thumbnail_view = _nested_object(r, "contentImage", "thumbnailViewModel")
                    thumbnails = _as_list(_nested_object(thumbnail_view, "image").get("sources"))
                    duration_text = ""
                    duration_seconds = 0
                    for overlay_value in _as_list(thumbnail_view.get("overlays")):
                        badges = _as_list(
                            _nested_object(
                                overlay_value,
                                "thumbnailBottomOverlayViewModel",
                            ).get("badges")
                        )
                        for badge_value in badges:
                            badge_view = _nested_object(badge_value, "thumbnailBadgeViewModel")
                            candidate_text = _extract_text(badge_view.get("text"))
                            candidate_seconds = _parse_duration_text(candidate_text)
                            accessibility_label = _nested_object(
                                badge_view,
                                "rendererContext",
                                "accessibilityContext",
                            ).get("label", "")
                            if not isinstance(accessibility_label, str):
                                accessibility_label = ""
                            candidate_seconds = max(
                                candidate_seconds,
                                _parse_duration_label(accessibility_label),
                            )
                            if candidate_seconds > 0:
                                duration_text = candidate_text
                                duration_seconds = candidate_seconds
                                break
                        if duration_seconds > 0:
                            break

                    _append_item(
                        {
                            "type": "video"
                            if content_type == "LOCKUP_CONTENT_TYPE_VIDEO"
                            else "song",
                            "videoId": video_id,
                            "title": title_text,
                            "artist": artist_name,
                            "artists": [artist_name] if artist_name != "Unknown" else [],
                            "album": album_name,
                            "duration": duration_text,
                            "duration_seconds": duration_seconds,
                            "thumbnails": thumbnails,
                            "isExplicit": False,
                        }
                    )
                return

            # ── compactVideoRenderer (common in TVHTML5 search) ──
            if "compactVideoRenderer" in node:
                r = node["compactVideoRenderer"]
                vid = r.get("videoId", "")
                if vid:
                    title_text = _extract_text(r.get("title"))
                    # Short byline text usually has "Artist · Album" or just "Artist"
                    byline = _extract_text(r.get("shortBylineText") or r.get("longBylineText"))
                    duration_text = _extract_text(r.get("lengthText"))
                    thumbs = r.get("thumbnail", {}).get("thumbnails", [])
                    _append_item(
                        {
                            "type": "song",
                            "videoId": vid,
                            "title": title_text,
                            "artist": byline.split("\u00b7")[0].strip() if byline else "Unknown",
                            "artists": [byline.split("\u00b7")[0].strip()] if byline else [],
                            "album": byline.split("\u00b7")[1].strip()
                            if "\u00b7" in byline
                            else None,
                            "duration": duration_text,
                            "duration_seconds": _parse_duration_text(duration_text),
                            "thumbnails": thumbs,
                            "isExplicit": False,
                        }
                    )
                return

            # ── tileRenderer (TVHTML5 v7+) ──
            if "tileRenderer" in node:
                r = node["tileRenderer"]
                nav_ep = r.get("onSelectCommand", {}).get("watchEndpoint", {})
                vid = nav_ep.get("videoId", "")
                if not vid:
                    # Try navigation endpoint
                    nav_ep2 = r.get("navigationEndpoint", {}).get("watchEndpoint", {})
                    vid = nav_ep2.get("videoId", "")
                if vid:
                    metadata = r.get("metadata", {}).get("tileMetadataRenderer", {})
                    title_text = (
                        _extract_text(
                            r.get("header", {}).get("tileHeaderRenderer", {}).get("title")
                        )
                        or _extract_text(metadata.get("title"))
                        or _extract_text(r.get("overlayMetadata", {}).get("primaryText"))
                    )

                    # metadata lines contain artist / album / duration
                    lines = metadata.get("lines", []) if metadata else []
                    artist_name = ""
                    album_name = None
                    duration_text = ""
                    duration_seconds = 0
                    for line in lines:
                        line_renderer = line.get("lineRenderer", {})
                        line_values: list[str] = []
                        for item_entry in line_renderer.get("items", []):
                            text_obj = item_entry.get("lineItemRenderer", {}).get("text")
                            lt = _extract_text(text_obj)
                            if lt:
                                line_values.append(lt)
                                # Duration looks like 3:45
                                if re.match(r"^\d{1,2}:\d{2}(:\d{2})?$", lt):
                                    duration_text = lt
                                    duration_seconds = _parse_duration_text(lt)
                            if isinstance(text_obj, dict):
                                accessibility_label = (
                                    text_obj.get("accessibility", {})
                                    .get("accessibilityData", {})
                                    .get("label", "")
                                )
                                if accessibility_label:
                                    duration_seconds = max(
                                        duration_seconds,
                                        _parse_duration_label(accessibility_label),
                                    )

                        if not artist_name and line_values:
                            primary_values = [
                                value for value in line_values if not _is_metadata_noise(value)
                            ]
                            if primary_values:
                                artist_name = primary_values[0]
                                if len(primary_values) > 1:
                                    album_name = primary_values[1]

                    if not artist_name and title_text and " - " in title_text:
                        # Fallback for titles like "Artist - Track Name".
                        artist_name = title_text.split(" - ", 1)[0].strip()

                    if duration_seconds > 0 and not duration_text:
                        minutes = duration_seconds // 60
                        seconds = duration_seconds % 60
                        duration_text = f"{minutes}:{seconds:02d}"

                    if not title_text:
                        # Last-resort fallback to avoid empty-title candidates.
                        title_text = _extract_text(metadata.get("title")) or "Unknown"

                    if not artist_name:
                        artist_name = "Unknown"

                    _append_item(
                        {
                            "type": "song",
                            "videoId": vid,
                            "title": title_text,
                            "artist": artist_name,
                            "artists": [artist_name] if artist_name != "Unknown" else [],
                            "album": album_name,
                            "duration": duration_text,
                            "duration_seconds": duration_seconds,
                            "thumbnails": (
                                r.get("contentImage", {})
                                .get("musicThumbnailRenderer", {})
                                .get("thumbnail", {})
                                .get("thumbnails", [])
                            ),
                            "isExplicit": False,
                        }
                    )
                return

            # ── musicCardShelfRenderer (top result) ──
            if "musicCardShelfRenderer" in node:
                r = node["musicCardShelfRenderer"]
                nav_ep = (
                    r.get("title", {})
                    .get("runs", [{}])[0]
                    .get("navigationEndpoint", {})
                    .get("watchEndpoint", {})
                )
                vid = nav_ep.get("videoId", "")
                if vid:
                    title_text = _extract_text(r.get("title"))
                    subtitle = _extract_text(r.get("subtitle"))
                    _append_item(
                        {
                            "type": "song",
                            "videoId": vid,
                            "title": title_text,
                            "artist": subtitle.split("\u00b7")[0].strip()
                            if subtitle
                            else "Unknown",
                            "artists": [subtitle.split("\u00b7")[0].strip()] if subtitle else [],
                            "album": None,
                            "duration": "",
                            "duration_seconds": 0,
                            "thumbnails": r.get("thumbnail", {})
                            .get("musicThumbnailRenderer", {})
                            .get("thumbnail", {})
                            .get("thumbnails", []),
                            "isExplicit": False,
                        }
                    )
                # Also walk children for more results
                for child in r.get("contents", []):
                    _walk_renderers(child, depth + 1)
                return

            # ── Fallback: walk all dict values ──
            for v in node.values():
                _walk_renderers(v, depth + 1)

        elif isinstance(node, list):
            for item_node in node:
                _walk_renderers(item_node, depth + 1)

    _walk_renderers(raw)

    normalized: JsonList = []
    for item in items:
        mapped = _normalize_native_search_item(item)
        if mapped:
            normalized.append(mapped)

    log.debug(
        "TV search %r filter=%r: parsed=%s normalized=%s",
        query,
        filter,
        len(items),
        len(normalized),
    )
    return normalized[:limit]


def _search_cache_key(
    user_id: str,
    query: str,
    filter_: str | None,
    limit: int,
    strategy: Literal["tv", "native"],
) -> str:
    """Build a deterministic cache key for search results."""
    return f"{user_id}:{strategy}:{query}:{filter_ or ''}:{limit}"


def _get_cached_search(
    user_id: str,
    query: str,
    filter_: str | None,
    limit: int,
    strategy: Literal["tv", "native"],
) -> JsonList | None:
    """Return cached search results if still valid, else None."""
    key = _search_cache_key(user_id, query, filter_, limit, strategy)
    with _search_cache_lock:
        entry = _search_cache.get(key)
        if entry and entry.get("expires_at", 0) <= time.time():
            del _search_cache[key]
            entry = None
    if entry and entry.get("expires_at", 0) > time.time():
        log.debug(f"Search cache hit: {key}")
        return cast(JsonList, entry["results"])
    return None


def _set_cached_search(
    user_id: str,
    query: str,
    filter_: str | None,
    limit: int,
    strategy: Literal["tv", "native"],
    results: JsonList,
) -> None:
    """Store search results in cache with TTL."""
    key = _search_cache_key(user_id, query, filter_, limit, strategy)
    with _search_cache_lock:
        _search_cache[key] = {
            "results": results,
            "expires_at": time.time() + SEARCH_CACHE_TTL,
        }
        expired_count = _clean_search_cache_locked()
        _bound_cache(_search_cache, SEARCH_CACHE_MAX)
    if expired_count:
        log.debug(f"Cleaned {expired_count} expired search cache entries")


def _search_once(
    user_id: str,
    query: str,
    filter_: Literal["songs", "albums", "artists", "videos"] | None,
    limit: int,
    strategy: Literal["tv", "native"],
    use_unauth_client: bool = False,
) -> JsonList:
    """
    Execute one search strategy with cache lookup/store.
    """
    cached = _get_cached_search(user_id, query, filter_, limit, strategy)
    if cached is not None:
        return cached

    if use_unauth_client:

        def search_public(yt: YTMusic) -> JsonList:
            if strategy == "native":
                return _native_search(yt, query, filter=filter_, limit=limit)
            return _tv_search(yt, query, filter=filter_, limit=limit)

        items = cast(
            JsonList,
            _run_public_ytmusic_with_retry(
                strategy,
                f"search-{strategy} user={user_id} query={query!r}",
                search_public,
                request_timeout_seconds=SEARCH_PROVIDER_REQUEST_TIMEOUT_SECONDS,
                retry_timeouts=False,
            ),
        )
    else:
        if strategy == "native":
            items = _run_ytmusic_with_auth_retry(
                user_id,
                operation=f"search-native query={query!r}",
                func=lambda yt: _native_search(yt, query, filter=filter_, limit=limit),
            )
        else:
            items = _run_ytmusic_with_auth_retry(
                user_id,
                operation=f"search-tv query={query!r}",
                func=lambda yt: _tv_search(yt, query, filter=filter_, limit=limit),
            )

    _set_cached_search(user_id, query, filter_, limit, strategy, items)
    return items


def _search_with_mode_fallback(
    user_id: str,
    query: str,
    filter_: Literal["songs", "albums", "artists", "videos"] | None,
    limit: int,
    use_unauth_client: bool = False,
) -> tuple[JsonList, Literal["tv", "native"]]:
    """
    Execute search according to configured mode.
    In auto mode, try native first and fall back to TV for the current public
    request. Only the authenticated #813 signature pins a user's later calls.
    `use_unauth_client=True` routes search through public clients so queries do
    not use user OAuth sessions.
    """
    strategy = _resolve_user_search_strategy(user_id)
    if strategy == "tv":
        return (
            _search_once(
                user_id,
                query,
                filter_,
                limit,
                "tv",
                use_unauth_client=use_unauth_client,
            ),
            "tv",
        )

    try:
        return (
            _search_once(
                user_id,
                query,
                filter_,
                limit,
                "native",
                use_unauth_client=use_unauth_client,
            ),
            "native",
        )
    except Exception as native_err:
        # A provider timeout already consumed the search transport budget.
        # Retrying through the fallback strategy would outlive the backend's
        # eight-second deadline and leave another blocked provider call behind.
        if isinstance(native_err, (requests.Timeout, TimeoutError)):
            raise
        # Preserve explicit native behavior unless auto fallback is enabled.
        if SEARCH_MODE != "auto" or (not use_unauth_client and _is_oauth_auth_error(native_err)):
            raise

        log.warning(
            "Native yt.search() failed for user %s; switching to TV fallback "
            "(query=%r, filter=%r, error=%s)",
            user_id,
            query,
            filter_,
            native_err,
        )
        # Public catalog calls deliberately use disposable unauthenticated
        # clients. Never let one transient provider failure pin the shared
        # public identity to TV mode for every user and every future request.
        # Authenticated clients retain the existing #813 workaround, but only
        # for the specific invalid-argument signature it was designed for.
        if not use_unauth_client and _is_issue_813_invalid_argument_error(native_err):
            _ytmusic_auto_tv_fallback_users.add(user_id)
        if not use_unauth_client:
            _invalidate_ytmusic(user_id)
        return (
            _search_once(
                user_id,
                query,
                filter_,
                limit,
                "tv",
                use_unauth_client=use_unauth_client,
            ),
            "tv",
        )


def _clean_search_cache_locked() -> int:
    """Remove expired search entries while the owning lock is held."""
    now = time.time()
    expired = [k for k, v in _search_cache.items() if v.get("expires_at", 0) <= now]
    for k in expired:
        del _search_cache[k]
    return len(expired)


def _clean_search_cache() -> None:
    """Remove expired entries from search cache."""
    with _search_cache_lock:
        expired_count = _clean_search_cache_locked()
    if expired_count:
        log.debug(f"Cleaned {expired_count} expired search cache entries")


def _consume_search_provider_job(job: _SearchProviderJob) -> None:
    """Retire provider work only after its dedicated worker has settled."""
    _search_provider_jobs.discard(job)
    if not job.cancelled():
        _ = job.exception()


def _submit_search_provider_job(
    user_id: str,
    query: str,
    filter_: Literal["songs", "albums", "artists", "videos"] | None,
    limit: int,
) -> _SearchProviderJob:
    """Admit one public search without queueing behind occupied workers."""
    if not _search_provider_admitting or len(_search_provider_jobs) >= SEARCH_PROVIDER_CONCURRENCY:
        raise HTTPException(status_code=503, detail=_SEARCH_PROVIDER_CAPACITY_DETAIL)

    loop = asyncio.get_running_loop()
    job = cast(
        _SearchProviderJob,
        loop.run_in_executor(
            _search_provider_executor,
            _search_with_mode_fallback,
            user_id,
            query,
            filter_,
            limit,
            True,
        ),
    )
    _search_provider_jobs.add(job)
    job.add_done_callback(_consume_search_provider_job)
    return job


async def _run_search_provider(
    user_id: str,
    query: str,
    filter_: Literal["songs", "albums", "artists", "videos"] | None,
    limit: int,
) -> _SearchProviderResult:
    """Await admitted search work while retaining timed-out worker slots."""
    job = _submit_search_provider_job(user_id, query, filter_, limit)
    deadline = asyncio.timeout(SEARCH_ENDPOINT_TIMEOUT_SECONDS)
    try:
        async with deadline:
            return await asyncio.shield(job)
    except TimeoutError as error:
        if deadline.expired():
            raise _SearchProviderDeadlineError from error
        raise


def _drain_search_provider_executor(
    drained: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Drain the dedicated search executor and notify the event loop."""
    try:
        _search_provider_executor.shutdown(wait=True, cancel_futures=True)
    except Exception:
        log.exception("YouTube Music search provider executor drain failed")
    finally:
        try:
            loop.call_soon_threadsafe(drained.set)
        except RuntimeError:
            return


async def shutdown_search_provider() -> None:
    """Stop search admission and bound shutdown waiting for provider workers."""
    global _search_provider_admitting

    _search_provider_admitting = False
    loop = asyncio.get_running_loop()
    drained = asyncio.Event()
    drain_thread = threading.Thread(
        target=_drain_search_provider_executor,
        args=(drained, loop),
        name="ytmusic-search-provider-shutdown",
        daemon=True,
    )
    drain_thread.start()
    try:
        async with asyncio.timeout(_SEARCH_PROVIDER_DRAIN_SECONDS):
            await drained.wait()
    except TimeoutError:
        log.warning(
            "YouTube Music search provider drain exceeded %.1f seconds",
            _SEARCH_PROVIDER_DRAIN_SECONDS,
        )


@app.post("/search")
async def search(req: SearchRequest, user_id: str = Query(...)) -> JsonObject:
    """Search YouTube Music for songs, albums, or artists.

    Search uses an unauthenticated client context so user OAuth search history
    is not touched. user_id is still used for cache segmentation and pacing.

    Mode behavior is controlled by YTMUSIC_SEARCH_MODE:
      - auto (default): native first; public fallback is request-scoped and an
        authenticated #813 failure pins only that user to TV
      - tv: force TVHTML parser path
      - native: force ytmusicapi yt.search()
    """
    try:
        items, strategy = await _run_search_provider(
            user_id,
            req.query,
            req.filter,
            req.limit,
        )
        log.debug(
            "Search: query=%r, filter=%r, limit=%s, strategy=%s, configured_mode=%s",
            req.query,
            req.filter,
            req.limit,
            strategy,
            SEARCH_MODE,
        )
        return {"results": items, "total": len(items)}
    except HTTPException:
        raise
    except (requests.Timeout, TimeoutError) as e:
        log.warning(
            "Search timed out for user %s query=%r filter=%r: %s",
            user_id,
            req.query,
            req.filter,
            type(e).__name__,
        )
        raise HTTPException(status_code=504, detail=_SEARCH_PROVIDER_TIMEOUT_DETAIL) from e
    except Exception as e:
        raise _sanitized_http_error(
            f"Search for user {user_id} query={req.query!r} filter={req.filter!r}",
            e,
            500,
            "Search failed",
        ) from e


@app.post("/search/batch")
async def search_batch(req: BatchSearchRequest, user_id: str = Query(...)) -> JsonObject:
    """Run multiple search queries with controlled concurrency.

    Uses a semaphore to limit parallel InnerTube requests (default: 3)
    and adds random delays between requests to look organic.

    Rate-pacing: requests are throttled via _batch_semaphore and
    inter-request delays instead of firing all N simultaneously.
    """
    if len(req.queries) > _BATCH_SEARCH_MAX_QUERIES:
        raise HTTPException(
            status_code=422,
            detail=f"Batch search accepts at most {_BATCH_SEARCH_MAX_QUERIES} queries",
        )

    async def _run_one(q: BatchSearchQuery) -> JsonObject:
        """Execute and sanitize one query in the batch."""
        # Check primary cache first — avoids consuming a semaphore slot.
        strategy = _resolve_user_search_strategy(user_id)
        cached = _get_cached_search(user_id, q.query, q.filter, q.limit, strategy)
        if cached is not None:
            return {"results": cached, "total": len(cached), "error": None}

        semaphore = _batch_semaphore
        await semaphore.acquire()
        provider_job: asyncio.Task[_SearchProviderResult] | None = None
        try:
            # Random delay between requests within the batch
            delay = random.uniform(  # noqa: S311 -- request pacing jitter is not security-sensitive
                BATCH_DELAY_MIN, BATCH_DELAY_MAX
            )
            await asyncio.sleep(delay)
            provider_job = asyncio.create_task(
                asyncio.to_thread(
                    _search_with_mode_fallback,
                    user_id,
                    q.query,
                    q.filter,
                    q.limit,
                    True,  # use_unauth_client
                )
            )

            def _release_provider_slot(job: asyncio.Future[_SearchProviderResult]) -> None:
                """Release capacity only after the uncancellable worker has settled."""
                semaphore.release()
                if not job.cancelled():
                    _ = job.exception()

            provider_job.add_done_callback(_release_provider_slot)
            try:
                items, _used_strategy = await asyncio.shield(provider_job)
                return {"results": items, "total": len(items), "error": None}
            except HTTPException:
                raise
            except Exception as e:
                log.warning(f"Batch search failed for query={q.query!r}: {e}")
                return {"results": [], "total": 0, "error": "search failed"}
        finally:
            # Cancellation before the worker task is created still owns a slot.
            # Once created, the task's callback owns release even if this request
            # disconnects while its blocking provider call is still running.
            if provider_job is None:
                semaphore.release()

    log.debug(
        f"Batch search: {len(req.queries)} queries for user {user_id} "
        f"(concurrency={BATCH_CONCURRENCY})"
    )
    results = await asyncio.gather(*[_run_one(q) for q in req.queries])
    return {"results": list(results)}


@app.post("/search/debug")
async def search_debug(req: SearchRequest, user_id: str = Query(...)) -> JsonObject:
    """WORKAROUND(#813) — Return the raw TV-format response for debugging.

    This endpoint lets us inspect the actual TVHTML5 response structure
    so we can tune the _tv_search parser.  NOT called by the backend —
    only for manual troubleshooting (e.g. curl from inside the container).

    REVERT: delete this entire endpoint when #813 is fixed.
    """
    # Keep user_id in the route signature for request-shape compatibility, but
    # debug search uses the public TV client like normal search paths.
    body: JsonObject = {"query": req.query}
    if req.filter == "songs":
        body["params"] = "EgWKAQIIAWoMEA4QChADEAQQCRAF"
    try:
        raw = await asyncio.to_thread(
            _run_public_ytmusic,
            "tv",
            lambda yt: yt._send_request("search", body),
        )
        return {"raw": raw}
    except Exception as e:
        raise _sanitized_http_error("Debug search", e, 500, "Debug search failed") from e
