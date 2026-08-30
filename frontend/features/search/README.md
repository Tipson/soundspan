# Search Feature Domain

Start-here guide for `frontend/features/search`.

## Start Here

1. Route entrypoints: `frontend/app/playlists/page.tsx`, `frontend/app/search/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/searchRuntime.test.ts src/routes/__tests__/browseRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/searchService.test.ts`
- `cd frontend && node --test --import tsx tests/unit/searchSongsPriority.test.ts tests/unit/discoverySelection.test.ts tests/unit/searchAlbumDedup.test.ts`
- `cd frontend && node --test --experimental-test-module-mocks --import tsx tests/component/searchPageResults.component.test.ts tests/component/searchEmptyState.component.test.ts tests/component/searchFiltersFederation.component.test.ts tests/component/searchSectionHeader.component.test.ts tests/component/searchRowActions.component.test.ts tests/component/libraryTracksList.component.test.ts`

External song results retain Last.fm metadata and merge exact YouTube Music
provider identities when that integration is enabled. Rows with a provider
identity play directly; only metadata-only rows use provider fuzzy matching.
The same global query returns browsable YouTube Music albums and artists;
provider artist identities remain available even when a same-name local artist
exists. When an exact local shadow duplicates a canonical provider artist or
album, search keeps one card and uses the provider route so the full online
profile/catalog opens; non-canonical discovery metadata cannot displace a local
entity. Canonical native or resolvable TV album identities open through the
existing playable album route while channels and ordinary playlists are rejected.
The primary search surface is music-only and uses URL-backed All, Tracks,
Artists, and Albums views. Dormant podcast/audiobook components remain for
upstream compatibility but are not queried or rendered here. All immediately
shows a confident exact-aware artist beside five popular tracks across owned
and external sources; no primary result is hidden behind a Show all gate. Its
single Albums shelf contains at most six owned and provider albums total.
Tracks requests and renders at most 50 tracks across those sources. Clicking a
visible result snapshots only visible playable rows in screen order, excluding
hidden, offline, and unmatched rows. Obvious long-form/video presentations are
ranked after songs. The route uses the same editorial spacing, translucent
surfaces, card geometry, and responsive hierarchy as Home and catalog detail
pages, with a dedicated 375px single-column layout and a two-column primary
result at desktop widths.
Discovery source work is bounded independently (1.5s alias correction plus a
9s provider deadline); the browser allows 14s and the default proxy allows 20s,
so a slow provider yields available partial results instead of erasing them.

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/AliasResolutionBanner.tsx` | components |
| `components/DiscoverPodcastsGrid.tsx` | components |
| `components/DiscoverTracksList.tsx` | components |
| `components/EmptyState.tsx` | components |
| `components/LibraryAlbumsGrid.tsx` | components |
| `components/LibraryAudiobooksGrid.tsx` | components |
| `components/LibraryPodcastsGrid.tsx` | components |
| `components/ProviderAlbumsGrid.tsx` | components |
| `components/SearchArtistsGrid.tsx` | components |
| `components/LibraryTracksList.tsx` | components |
| `components/SearchFilters.tsx` | components |
| `components/SearchSectionHeader.tsx` | components |
| `components/SimilarArtistsGrid.tsx` | components |
| `components/SoulseekSongsList.tsx` | components |
| `components/TopResult.tsx` | components |
| `components/TVSearchInput.tsx` | components |
| `components/YouTubePlaylistPreviewCard.tsx` | components |
| `components/YouTubePreviewCard.tsx` | components |
| `hooks/useSearchData.ts` | hooks |
| `hooks/useSearchTrackMatches.ts` | hooks |
| `hooks/useSoulseekSearch.ts` | hooks |
| `hooks/useYouTubePlaylist.ts` | hooks |
| `hooks/useYouTubeUrl.ts` | hooks |
| `discoverySelection.ts` | root |
| `albumDedup.ts` | root |
| `songDedup.ts` | root |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.
