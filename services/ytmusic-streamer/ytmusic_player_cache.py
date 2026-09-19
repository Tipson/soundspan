"""Keep JavaScript challenge evaluation on yt-dlp's upstream providers.

The startup hook is retained for the streamer's optional-adapter contract.
Serialized EJS preprocessing is not reused across requests: successful solver
JSON does not prove that the resulting signature is accepted by YouTube's CDN.
Player source, media and anonymous visitor caches have separate ownership.
"""


def register_player_cache() -> bool:
    """Leave the upstream solver registry unchanged and report no custom adapter."""
    return False
