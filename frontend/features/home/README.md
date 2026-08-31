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
| `components/AudiobooksGrid.tsx` | components |
| `components/ContinueListening.tsx` | components |
| `components/FeaturedPlaylistsGrid.tsx` | components |
| `components/HomeHero.tsx` | components |
| `components/HomeQuickActions.tsx` | legacy utility links; intentionally not rendered on Home |
| `components/HomeWaveHero.tsx` | personalized My Wave launch surface |
| `components/HomeMadeForYou.tsx` | bounded set of distinct account-backed and generated mixes |
| `components/LibraryRadioStations.tsx` | components |
| `components/libraryRadioStationsGenreSelection.ts` | components |
| `components/MixesGrid.tsx` | components |
| `components/PodcastsGrid.tsx` | components |
| `components/PopularArtistsGrid.tsx` | components |
| `components/PersonalizedTrackShelf.tsx` | personalized provider tracks |
| `components/PersonalizedMixCard.tsx` | playable card backed by one real personalized feed shelf |
| `components/SectionHeader.tsx` | components |
| `components/StaticPlaylistCard.tsx` | components |
| `hooks/useHomeData.ts` | hooks |
| `hooks/usePersonalizedHomeFeed.ts` | personalized provider feed |
| `personalizedHomeRequestPolicy.ts` | shared bounded request and retry policy |
| `types.ts` | root |

## Playback Behavior

- Home opens with a compact balanced My Wave action built from Quick picks, discovery,
  and Listen again, resets its direction to For you, then marks the queue for
  automatic provider continuation. The launch surface describes the continuous
  flow without exposing the finite seed-window size as a track limit. Its
  artwork fan comes from that account's current feed rather than decorative or
  placeholder recommendations.
- Continue listening is one resumable track row and disappears when the account
  has no recent provider history.
- Made For You exposes five playable collections initially and expands all
  remaining collections in place. It derives distinct
  Daily blend, Fresh finds, Back in rotation, and Quick picks recipes from
  independent account signals, deduplicates identical recipes, then fills any
  remaining initial slots with non-empty Discover Weekly and generated mixes.
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
- Starting a personalized provider shelf creates a directly playable YouTube
  Music queue.
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

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.
