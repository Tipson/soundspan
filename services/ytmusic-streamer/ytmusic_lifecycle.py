"""Health and process lifecycle routes for the assembled sidecar."""

import asyncio

from ytmusic_browse import YTMUSIC_HOME_FILTERED_SHELVES
from ytmusic_client import (
    SEARCH_MODE,
    YTMUSIC_LANGUAGE,
    YTMUSIC_LOCATION,
    _ytmusic_auto_tv_fallback_users,
    _ytmusic_instances,
    _ytmusic_instances_lock,
)
from ytmusic_library import shutdown_library_playlist_provider
from ytmusic_runtime import DATA_PATH, JsonObject, app, log
from ytmusic_search import (
    SEARCH_CACHE_TTL,
    SEARCH_ENDPOINT_TIMEOUT_SECONDS,
    SEARCH_PROVIDER_CONCURRENCY,
    _clean_search_cache,
    shutdown_search_provider,
)
from ytmusic_stream import (
    EXTRACT_DELAY_MAX,
    EXTRACT_DELAY_MIN,
    YTDLP_EXTRACT_CONCURRENCY,
    _clean_stream_cache,
    shutdown_stream_provider,
)
from ytmusic_tail_warmup import shutdown_tail_warmup


@app.get("/health")
async def health() -> JsonObject:
    # Count how many users have OAuth files
    oauth_files = list(DATA_PATH.glob("oauth_*.json"))
    return {
        "status": "ok",
        "service": "ytmusic-streamer",
        "authenticated_users": len(oauth_files),
        "search_mode": SEARCH_MODE,
        "auto_tv_fallback_users": len(_ytmusic_auto_tv_fallback_users),
    }


@app.on_event("startup")
async def startup() -> None:
    from ytmusic_fast_probe import warm_fast_probes

    await asyncio.to_thread(warm_fast_probes, workers=max(1, YTDLP_EXTRACT_CONCURRENCY // 2))
    log.info("YouTube Music Streamer starting up (multi-user mode)")
    log.info(
        f"Search admission config: provider_concurrency={SEARCH_PROVIDER_CONCURRENCY}, "
        f"endpoint_deadline={SEARCH_ENDPOINT_TIMEOUT_SECONDS}s, "
        f"extract_delay={EXTRACT_DELAY_MIN}-{EXTRACT_DELAY_MAX}s, "
        f"search_cache_ttl={SEARCH_CACHE_TTL}s, "
        f"search_mode={SEARCH_MODE}"
    )
    log.info(
        f"Browse config: language={YTMUSIC_LANGUAGE}, "
        f"location={YTMUSIC_LOCATION or '(provider default)'}, "
        f"home_filtered_shelves={YTMUSIC_HOME_FILTERED_SHELVES or '(none)'}"
    )

    # Ensure data directory exists and is writable
    DATA_PATH.mkdir(parents=True, exist_ok=True)
    test_file = DATA_PATH / ".write_test"
    try:
        test_file.write_text("ok")
        test_file.unlink()
    except PermissionError:
        log.error(
            f"DATA_PATH ({DATA_PATH}) is not writable! "
            "OAuth credentials cannot be saved. "
            "If using Docker, try removing and recreating the ytmusic_data volume: "
            "docker volume rm soundspan_ytmusic_data"
        )

    oauth_files = list(DATA_PATH.glob("oauth_*.json"))
    if oauth_files:
        log.info(f"Found {len(oauth_files)} user OAuth credential file(s)")
    else:
        log.info("No OAuth credentials found — users need to authenticate via settings")


@app.on_event("shutdown")
async def shutdown() -> None:
    await shutdown_tail_warmup()
    await shutdown_stream_provider()
    await shutdown_search_provider()
    await shutdown_library_playlist_provider()
    _clean_stream_cache()
    _clean_search_cache()
    with _ytmusic_instances_lock:
        _ytmusic_instances.clear()
    log.info("YouTube Music Streamer shutting down")
