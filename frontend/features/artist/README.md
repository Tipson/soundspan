# Artist Feature Domain

Start-here guide for `frontend/features/artist`.

## Start Here

1. Route entrypoints: `frontend/app/album/[id]/page.tsx`, `frontend/app/artist/[id]/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/artistsRuntime.test.ts`
- `npm --prefix frontend run test:component`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/ArtistActionBar.tsx` | components |
| `components/ArtistBio.tsx` | components |
| `components/ArtistHero.tsx` | components |
| `components/ArtistViewTabs.tsx` | components |
| `components/AvailableAlbums.tsx` | components |
| `components/Discography.tsx` | components |
| `components/index.ts` | components |
| `components/PopularTracks.tsx` | components |
| `components/SimilarArtists.tsx` | components |
| `hooks/index.ts` | hooks |
| `hooks/useArtistActions.ts` | hooks |
| `hooks/useArtistAlbumRequests.ts` | hooks |
| `hooks/useArtistData.ts` | hooks |
| `hooks/useArtistTracks.ts` | hooks |
| `hooks/useDownloadActions.ts` | hooks |
| `hooks/useTidalTopTracks.ts` | hooks |
| `hooks/useTrackAlbumResolutions.ts` | hooks |
| `hooks/useYtMusicTopTracks.ts` | hooks |
| `types.ts` | root |
| `artistView.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.

## Online-first Actions

The artist action bar exposes playback, account Library, playlist, preference,
radio, and current-device offline controls. It does not mount permanent server
acquisition actions; Download to this device queues the artist's playable
popular tracks in the current browser/PWA only.

The responsive artist page presents playable Popular tracks before the longer
About biography, keeps the selected visible track list as playback context, and
uses the shared artwork-led music-detail hero, touch-sized action dock, and
canonical track surface. Those surfaces stack without horizontal overflow on
narrow screens while keeping long names and artist filters visible.

Artist content is addressable through `?view=overview|tracks|albums|singles`.
The Tracks view exposes every track returned by the artist data source as one
ordered playback context. Library artists use a bounded paginated track read;
provider-only artists expose the complete song set returned by that provider's
artist response. Albums include untyped releases; Singles & EPs only includes
releases explicitly classified as singles or EPs.
