# Playlist Feature Domain

## Start Here

1. Route entrypoints: `frontend/app/playlist/[id]/page.tsx`, `frontend/app/playlist/my-liked/page.tsx`.
2. `components/PlaylistDetailHero.tsx` owns the shared artwork-led playlist identity surface.
3. `components/CreatePlaylistDialog.tsx` owns the focused playlist-creation flow used by the collection page. Successful navigation closes registered layers and waits for their native history guard traversal through `hooks/useDismissibleLayer.ts` / `lib/dismissibleLayerHistory.ts`. Its optional `onClose("created")` reason prevents a competing deep-link cleanup navigation; ordinary Cancel, Back and Escape queue cleanup with `navigateWhenLayersDismissed` after the child close commits. This wait-only boundary keeps lower player layers open and waits for their guard to disappear before updating the Library URL. The Library locally dismisses a consumed deep-link dialog and clears its real base URL after the guard is gone, preserving the current Next history snapshot before the final destination push.
4. `createPlaylistRoute.ts` owns the `/playlists?create=1` deep-link decision used by sidebar shortcuts.
5. Playlist playback and mutation controllers remain in their route modules.

## Detail-page Contract

- Playlist detail uses the same ambient hero, translucent action dock, and ordered track surface as album and artist details.
- The hero communicates the playlist owner, track count, and duration without exposing provider implementation details.
- Ordinary playlist details request 100 merged track/pending positions at a time through the opaque `nextCursor` contract and prefetch the next page near the scroll boundary. The total count remains authoritative while unloaded rows stay out of the browser and API response.
- Reordering is available only after the complete playlist is loaded and remains capped by the backend's 1,000-item mutation contract; removal and other row actions continue to invalidate the paginated query.
- Playback, reordering, sharing, device downloads, likes, and recovery actions retain their existing route behavior.

## Targeted Verification

- `node --test --experimental-test-module-mocks --import tsx tests/component/musicDetailSurfaces.component.test.ts`
- `node --test --import tsx tests/unit/playlistPagination.test.ts tests/unit/playlistsApi.test.ts`
- `npm --prefix frontend run test:component`
