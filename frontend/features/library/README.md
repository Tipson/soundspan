# Library Feature Domain

Start-here guide for `frontend/features/library`.

## Start Here

1. Route entrypoints: `frontend/app/library/page.tsx`, `frontend/app/album/[id]/page.tsx`, `frontend/app/artist/[id]/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/libraryRuntime.test.ts src/routes/__tests__/homepageRuntime.test.ts`
- `npm --prefix frontend run test:component`
- `npm --prefix frontend run test:unit`

## Personal Library Model

- Library is an account-scoped hub for liked songs, user playlists, explicitly saved albums and artists, plus ordinary device-file downloads whose status and folder permission belong to the current browser profile.
- The primary Playlists view combines liked songs, user playlists, and current-device downloads without repeating a summary block. Albums and Artists remain directly selectable views.
- Saving an album or artist records its exact Soundspan or provider identity. It does not infer album state from liked tracks and does not download media to the server.
- The user-facing route intentionally does not expose the server-file catalog, scan filters, or destructive media controls. Administrative server-media management remains separate.
- Compact screens use one horizontally scrollable, active-tab-aware section rail. The editorial Library hero, section rail, and collection cards share the same quiet surface geometry as music detail pages; card titles wrap instead of clipping, and every tab view leaves room for the persistent mobile player.

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/LibraryHeader.tsx` | components |
| `components/LibraryTabs.tsx` | components |
| `components/PersonalPlaylistGrid.tsx` | user playlist cards |
| `components/SaveMusicEntityButton.tsx` | explicit account save/remove control |
| `components/SavedMusicGrid.tsx` | saved album and artist cards |
| `hooks/useSavedMusic.ts` | saved entity queries and optimistic mutations |
| `savedMusicEntity.ts` | canonical saved-entity route resolution |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.
