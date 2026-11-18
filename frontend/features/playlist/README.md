# Playlist Feature Domain

## Start Here

1. Route entrypoints: `frontend/app/playlist/[id]/page.tsx`, `frontend/app/playlist/my-liked/page.tsx`.
2. `components/PlaylistDetailHero.tsx` owns the shared artwork-led playlist identity surface.
3. `components/CreatePlaylistDialog.tsx` owns the focused playlist-creation flow used by the collection page.
4. `createPlaylistRoute.ts` owns the `/playlists?create=1` deep-link decision used by sidebar shortcuts.
5. Playlist playback and mutation controllers remain in their route modules.

## Detail-page Contract

- Playlist detail uses the same ambient hero, translucent action dock, and ordered track surface as album and artist details.
- The hero communicates the playlist owner, track count, and duration without exposing provider implementation details.
- Ordinary playlist details request 100 merged track/pending positions at a time through the opaque `nextCursor` contract and prefetch the next page near the scroll boundary. The total count remains authoritative while unloaded rows stay out of the browser and API response.
- Reordering is available only after the complete playlist is loaded and remains capped by the backend's 1,000-item mutation contract; removal and other row actions continue to invalidate the paginated query.
- Playback, reordering, sharing, device downloads, likes, and recovery actions retain their existing route behavior.
- Owners can opt into a finite smart shuffle preview from the secondary-actions sheet. It captures the complete bounded playlist snapshot before playback, preserves ordered item occurrences and inserts one admitted discovery after three own tracks; a shorter playlist receives one at the end. The pool is finite and never loops. The existing 100-entry playback checkpoint limits the preview to at most99 own playable occurrences, with injections using only remaining capacity. Larger playlists are declined before pool loading or queue changes; ordinary playback remains available and own occurrences are never truncated. Unavailable providers or admission retain the original tracks without enabling a no-op smart mode.
- Smart queue entries retain a local seed, cursor and own/discovery lineage in the existing owner-bound playback checkpoint. Discoveries use the existing finite recommendation admission and playlist attribution. Disabling prunes only future discoveries, preserving current playback and history; Undo is fenced by owner, queue revision and preference ordering. The saved playlist is never written by this mode.
- `lib/prepareSmartShuffle.ts` validates the full owner snapshot and bounded admitted pool; `hooks/useSmartShuffle.ts` binds opt-in, cancellation and guarded Undo to the existing player.

## Targeted Verification

- `node --test --experimental-test-module-mocks --import tsx tests/component/musicDetailSurfaces.component.test.ts`
- `node --test --import tsx tests/unit/playlistPagination.test.ts tests/unit/playlistsApi.test.ts`
- `npm --prefix frontend run test:component`
