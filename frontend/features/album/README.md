# Album Feature Domain

Start-here guide for `frontend/features/album`.

## Start Here

1. Route entrypoints: `frontend/app/album/[id]/page.tsx`, `frontend/app/artist/[id]/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/artistsRuntime.test.ts`
- `npm --prefix frontend run test:component`

## Directory Contents

| Path | Kind |
| --- | --- |
| `albumActionVisibility.ts` | action visibility and acquisition policy |
| `albumHydration.ts` | source-specific album hydration |
| `albumPlayback.ts` | playback mapping |
| `components/AlbumActionBar.tsx` | components |
| `components/AlbumHero.tsx` | components |
| `components/SimilarAlbums.tsx` | components |
| `components/TrackList.tsx` | components |
| `hooks/providerStatusCache.ts` | hooks |
| `hooks/useAlbumActions.ts` | hooks |
| `hooks/useAlbumAcquisition.ts` | acquisition hook |
| `hooks/useAlbumData.ts` | hooks |
| `hooks/useAlbumPlaybackActions.ts` | playback and queue hook |
| `hooks/useAlbumPreferenceActions.ts` | album preference hooks |
| `hooks/useAlbumRequest.ts` | hooks |
| `hooks/useTidalGapFill.ts` | hooks |
| `hooks/useTrackDeepLink.ts` | hooks |
| `hooks/useYtMusicGapFill.ts` | hooks |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.

## Device Offline Surface

The user-facing album action bar is online-first: Save to Library stores an
account-scoped bookmark, while Download to this device queues only playable
album tracks in the current browser/PWA. Server acquisition and request actions
are not mounted in this bar. Removing or saving an album never mutates another
device's offline queue.

The responsive album page keeps complete long titles visible, stacks artwork
above metadata on narrow screens, wraps its touch-sized actions, and plays a
selected row within the album's ordered playable context.
