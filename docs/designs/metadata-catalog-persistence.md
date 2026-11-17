# Metadata catalog persistence

Status: shipped.

MusicBrainz release groups and tracklists already fetched for artist and album
views are retained as hidden local skeletons. Persisted albums use the
`CATALOG` `AlbumLocation`; their tracks have no playable file path and remain
excluded from library, search, enrichment, and federation surfaces.

Persistence is write-through only. An artist's complete, unfiltered provider
list is retained in `ArtistCatalogReleaseGroup`, keyed by artist and release
group. Ordered rows preserve full release dates and secondary types even when
the same release already belongs to another artist's global Album row or an
owned album. Each route applies its own display filters after reading.

One transaction locks the exact artist row, replaces at most 100 metadata
rows and stamps `catalogSyncedAt` last. Secondary types are bounded to 64
inputs, 16 unique values and 64 characters per value. Empty or failed provider
results do not replace a snapshot or advance freshness; zero-row reads miss.
Skeleton writes retain their independent ownership and override guards.

Redis stays the hot cache, and fresh snapshot rows are read only after a
Redis miss. Library discography keys use `discography:v2:` to isolate entries
from legacy filtered cache payloads. Populated lists cache for 24 hours;
empty lists and provider failures cache for 120 seconds. Artist discographies
and album tracklists are fresh for seven days. Library snapshot reads require
the exact local artist ID, effective MBID and null peer ID. Reads refresh
`catalogTouchedAt` without delaying the response.

An hourly worker removes at most 50 oldest catalog albums per run after 180
untouched days. `CATALOG_RETENTION_DAYS` changes the retention window. Download
jobs, music requests, track preferences, ratings, and playlist items retain
referenced albums. Deleting an album cascades to its skeleton tracks.

The feature defaults on. `CATALOG_PERSISTENCE=off` disables catalog reads,
writes, and retention. Catalog skeletons are local cache state and are never
included in federation exports.
