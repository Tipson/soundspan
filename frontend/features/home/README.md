# Home Feature Domain

Start-here guide for `frontend/features/home`.

## Start Here

1. Route entrypoints: `frontend/app/explore/page.tsx`, `frontend/app/library/page.tsx`, `frontend/app/page.tsx`, `frontend/app/radio/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/libraryRuntime.test.ts src/routes/__tests__/homepageRuntime.test.ts`
- `npm --prefix frontend run test:component`
- `npm --prefix frontend run test:unit`

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/ArtistsGrid.tsx` | components |
| `components/ContinueListening.tsx` | components |
| `components/FeaturedPlaylistsGrid.tsx` | components |
| `components/HomeHero.tsx` | components |
| `components/HomeQuickActions.tsx` | legacy utility links; intentionally not rendered on Home |
| `components/HomeWaveHero.tsx` | personalized My Wave launch surface |
| `components/HomeMadeForYou.tsx` | bounded set of distinct account-backed and generated mixes |
| `timeOfDayMix.ts` | local-hour listening contexts for the current personal mix |
| `components/LibraryRadioStations.tsx` | components |
| `components/libraryRadioStationsGenreSelection.ts` | components |
| `components/PopularArtistsGrid.tsx` | components |
| `components/PersonalizedTrackShelf.tsx` | personalized provider tracks |
| `components/PersonalizedMixCard.tsx` | playable card backed by one real personalized feed shelf |
| `components/SectionHeader.tsx` | components |
| `components/StaticPlaylistCard.tsx` | components |
| `hooks/useHomeData.ts` | hooks |
| `hooks/usePersonalizedHomeFeed.ts` | personalized provider feed |
| `selectWaveTracks.ts` | shared Home/Wave queue selection from server-ranked Wave shelves |
| `hooks/useRecommendationImpressions.ts` | viewport-confirmed recommendation impression reporting |
| `personalizedHomeRequestPolicy.ts` | shared bounded request and retry policy |
| `recommendationIdentity.ts` | stable provider identity for playback lineage and impressions |
| `types.ts` | root |

## Playback Behavior

- Home opens with a compact discovery-led My Wave action that adds a saved track
  after four discoveries and a recent track after fifteen queued tracks,
  resets its direction to For you, then marks the queue for
  automatic provider continuation. The launch surface describes the continuous
  flow without exposing the finite seed-window size as a track limit. Its
  artwork fan comes from that account's current feed rather than decorative or
  placeholder recommendations.
- Continue listening is one resumable track row and disappears when the account
  has no recent provider history.
- Made For You exposes five playable collections initially and expands all
  remaining collections in place. A non-empty Discover Weekly leads the row.
  Three daily mixes draw separately from balanced, discovery, and familiar
  account signals. One additional mix uses the listener's local hour and a
  separate energetic, focus, or calm server-ranked discovery feed; it changes
  as the day moves from morning to daytime to evening or night. The mixes use
  separate 25-song shelves so the Home Wave seed remains unchanged. Each mix
  forms its own queue of up to 40 songs,
  leading with the relevant signals and filling from familiar or new music.
  A song can appear in different mixes but not twice within one mix. Empty
  mixes are omitted. Generated mixes fill any remaining initial slots.
  The shelf owns one opaque surface so the artwork atmosphere never creates a
  horizontal color seam through cards or metadata.
- Home folds online discovery into at most one station row and one discovery
  row, deduplicates items across both, filters regional spillover, and hides
  either row when it has nothing navigable. Direction and mood are configured
  only inside Vibe so Home does not duplicate the same control as a link shelf.
- The primary mobile navigation links directly to Vibe so the endless personal
  radio stays one tap away; podcasts and audiobooks are not promoted on Home or
  in the primary music navigation.
- Personalized provider shelves use remote YouTube Music plays, remote likes,
  dislikes, completed listens, early skips, repeats, and playlist items that
  have a YouTube Music match. The online-first feed does not require local
  Audio-DNA files.
- Personalized surfaces report an impression only after each rendered track
  card enters the viewport. Playback carries the originating generation and
  recommendation session directly, so evaluator attribution does not rely on
  a timing heuristic.
- Starting a personalized provider shelf preserves the playable YouTube Music,
  TIDAL, or library identity of every queue item.
- Vibe exposes For you, New, and Familiar modes. Each mode is sent to the
  personalized endpoint and therefore changes server-side ranking rather than
  only relabeling the same browser-side list. Vibe deliberately keeps the
  player, direction controls, and feedback in one focused radio surface instead
  of repeating Home's horizontally scrolling preview shelves.
- Vibe treats direction and listening context as separate controls. Calm,
  Energetic, Focus, Workout, Favorites, and Forgotten are sent as an independent
  server-ranking input and remain in the `/vibe` deep link for later provider
  continuation requests; no local Audio-DNA catalog is required.
- When that queue reaches its final item with repeat disabled, the player asks
  the personalized home feed for unseen continuation tracks, sends a bounded
  tail of the existing queue as exclusions, and rotates across later play,
  like, and playlist seeds before appending the next page. A successful like
  or dislike invalidates the personalized feed; exact disliked provider tracks
  cannot seed or re-enter later pages. Local-library queues use Audio-DNA
  similarity instead. Home and provider-radio continuation share a 17-second
  outer request budget with no timeout retry, leaving the backend's bounded
  provider call time to complete without multiplying work.
- Three consecutive manual skips made before 30 seconds or 20% of a provider
  Wave track trigger one guarded personalized refresh. Playback advances
  immediately, then the first fresh result replaces the still-unplayed tail;
  technical playback failures neither count as negative taste feedback nor
  reset the manual-skip streak, and stale responses cannot overwrite a newer
  Wave session.

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.
