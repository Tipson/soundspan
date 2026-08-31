# Soundspan redesign design QA

## Comparison target

- Source visual truth: `design-system/soundspan/references/canonical-home-target.png`
- Sidebar source crop: `design-system/soundspan/references/canonical-sidebar-target.png`
- Current Home release-candidate capture:
  `design-system/soundspan/qa/evidence/home-polish-production-1487x1058.png`
- Current native-size side-by-side comparison:
  `design-system/soundspan/qa/comparison/home-polish-reference-vs-production.png`
- Current Library capture:
  `design-system/soundspan/qa/evidence/library-polish-production-1487x1058.png`
- Current Vibe captures:
  - `design-system/soundspan/qa/evidence/vibe-polish-production-1487x1058.png`
  - `design-system/soundspan/qa/evidence/vibe-polish-production-1280x720.png`
  - `design-system/soundspan/qa/evidence/vibe-polish-production-mobile-390x844.png`
- Current mobile Home capture:
  `design-system/soundspan/qa/evidence/home-polish-production-mobile-390x844.png`
- Earlier comparison history remains in
  `design-system/soundspan/qa/comparison/home-full-comparison.png` and
  `design-system/soundspan/qa/comparison/home-shell-player-comparison.png`.

The source and current desktop implementation are both 1487 x 1058 physical
pixels, captured at a 1487 x 1058 CSS viewport with `deviceScaleFactor: 1`. No
density normalization or browser-frame crop was required. The current comparison
is 2974 x 1058 and places the source on the left and implementation on the right
at native size.

State: authenticated Russian account, dark theme, populated personalized feed,
idle desktop player visible. The QA feed used provider-derived artwork and a
deterministic audio response so transient playback availability could not distort
the visual state.

The `*-production-*` strings are immutable artifact filenames used by the capture
run. The candidate was subsequently published from commit
`59aa0c3e30e0a974cc0f0f5168b88ffd9968b0a1`; deployment evidence is recorded in
the release-status section below rather than inferred from these filenames.

## Required fidelity surfaces

- **Fonts and typography:** the implementation keeps Soundspan's existing
  production font stack and brand wordmark, with the source hierarchy reproduced
  through a 56 px-equivalent Wave heading, compact uppercase eyebrow, 20 px shelf
  headings, readable metadata, and stable truncation. The generated mock's exact
  display face is not a licensed source asset, so its optical hierarchy rather
  than an invented replacement font is the acceptance criterion.
- **Spacing and layout rhythm:** the 248 px sidebar, 88 px top bar, 128 px player,
  220 px hero artwork, four continuation cards, right recency column, and five
  mix slots match the source's major-region proportions. The Vibe stage remains
  inside the app boundary at 1487 x 1058 and 1280 x 720; its tuning sheet owns
  required internal overflow. At 720p the sidebar uses its short-height escape
  instead of exposing a nested playlist scrollbar.
- **Colors and tokens:** near-black chrome, neutral content surfaces, violet/amber
  actions, semantic states, and artwork-derived atmosphere use synchronized
  runtime/design-system tokens. Text contrast tests retain their AA floors.
- **Image quality and asset fidelity:** Home and the player use real feed artwork
  through the shared image component with `object-cover`, fallbacks, and no CSS
  or inline-SVG substitutes. Artwork subject and ambient hue intentionally change
  with the account's current music instead of hard-coding the Linkin Park image
  from the source mock.
- **Copy and content:** core navigation, search, Wave, Home shelves, player actions,
  install feedback, and accessibility labels are coherent Russian copy. Provider
  names and dynamic catalog metadata remain unchanged.
- **Icons and affordances:** one Lucide family is used consistently. Primary play,
  Wave tuning, navigation, like/dislike, shuffle/repeat, progress, volume, install,
  playlist-create, add-to-playlist, and verified-download controls have visible
  focus/pressed/disabled states and practical pointer targets. Download status is
  a positive-only icon: no icon is rendered when the track is not stored locally.

## Comparison history

### Iteration 1 — blocked

- **[P1] Home atmosphere covered dashboard copy.** The extended hero ambient
  layer painted above Continue listening, Recently listened, and mix metadata.
  Fix: promoted all post-hero content to an explicit positioned content layer and
  kept the ambient field behind it. Post-fix evidence shows fully readable shelf
  headings and metadata while preserving the artwork blend.
- **[P2] Short desktop Vibe could clip core controls.** The first composition used
  wide-screen spacing at 1366 x 768. Fix: added a scoped short-desktop density mode
  that contracts title/orbit/gaps while retaining play, Tune, current settings,
  now-playing feedback, and Skip. The app boundary remains non-scrollable.
- **[P2] Player atmosphere was flatter and darker than the selected source.** Fix:
  increased real-artwork contribution and added a restrained token-based
  amber/violet spectral layer below the contrast scrim.
- **[P2] Mid-width desktop header and overlays still used stale geometry.** Fix:
  made the header grid shrink safely from 1025 px and derived Activity, overlay
  player, and PWA prompt bounds from shared top-bar/player CSS variables.

### Iteration 2 — passed

The native-size full comparison and focused shell/player comparison show no
remaining actionable P0, P1, or P2 mismatch. The following visible differences
are intentional product constraints:

- the sidebar contains only Liked songs and Playlists below the primary routes,
  per the user's later override, rather than the mock's Recent/Artists/Albums list;
- continuation cards do not fabricate progress when the online feed has no durable
  per-item resume position;
- artwork, crops, titles, and ambient colors are live account data rather than
  fixed mock content.

### Iteration 3 — passed

- **Sidebar ownership and short-height fit:** replaced the generic Playlists row
  with direct owned, non-hidden playlist shortcuts. At 850 px height and below,
  one shortcut plus `Все плейлисты +N` and `Создать плейлист` keeps the sidebar
  usable without a visible nested scrollbar.
- **Home mix continuity:** `Показать все` expands and collapses the personal mix
  collection in place. Every mix card remains on one unified surface instead of
  crossing a partial grey backing or navigating to the unrelated playlists page.
- **Vibe motion and retuning:** the ambient canvas uses existing analyzed BPM and
  energy when available and a deterministic track/direction/mood fallback
  otherwise. It is static for reduced-motion, low-power, hidden, paused, and
  compact environments and never touches the playback audio graph. Applying a
  changed setting to an active Wave replaces its queue and advances immediately;
  unchanged settings do not skip, while failed replacement remains retryable.
- **One collection hierarchy:** Library exposes Playlists, Albums, and Artists;
  the Playlists view contains Liked songs, owned playlists, and this-device
  downloads. The former duplicated overview/download destinations are absent.
- **Playlist workflows:** the collection page exposes a clear create dialog, and
  the responsive add-to-playlist selector supports owned targets plus create-and-
  add recovery without creating duplicates on retry.
- **Downloaded state:** verified ready tracks receive the compact downloaded icon;
  non-downloaded tracks keep the title row visually quiet.

## Responsive and interaction evidence

- Desktop Home: sidebar/main-column adjacency, top-bar ownership, semantic Home
  regions, inline mix expansion, one continuous mix surface, and no unexpected
  runtime/page errors. Optional disabled Mix/Discover endpoints and a missing
  optional avatar image are explicitly recognized as fallback responses rather
  than unhandled application errors.
- Desktop player: three regions, two transport levels, artwork atmosphere,
  progress, shuffle/repeat, like/dislike, volume, overflow, and retry states.
- Vibe: no document scroll at 1487 x 1058 or 1280 x 720; play, Tune, current
  selection, queue preview, and feedback remain inside the locked stage. The
  720p capture also verifies the short-height sidebar escape.
- Mobile Home/Vibe: 390 x 844 screenshots show mobile top bar, mini player, bottom
  navigation, no desktop chrome, and no horizontal page overflow.
- Library: the 1487 x 1058 capture verifies the combined Playlists hierarchy and
  direct owned-playlist sidebar shortcuts.
- PWA install: explicit install request, unavailable-prompt feedback, accepted
  pending state, `appinstalled` completion, and safe player offsets are covered by
  component tests.

## Follow-up polish

- **P3:** when playback history eventually exposes trustworthy per-track resume
  positions for online provider rows, continuation cards can add the source
  mock's progress line without synthesizing data.

## Release status

Design QA passed and the candidate was published on 2026-08-31 as
`local/soundspan:2.6.1-redesign-59aa0c3`
(`sha256:21164ec09fade19376bfa81e60b3c21e8d036ae1f645b794c17dd9819d01c205`).
The runtime, provider, public-route, schema, desktop-browser, and 390 x 844
mobile-browser smoke checks passed after deployment. The main container remained
healthy with zero restarts, and the companion streamer stayed on its previous
healthy image without recreation. Final subjective visual acceptance remains
with the product owner.

final result: passed
