# Soundspan redesign design QA

## Comparison target

- Source visual truth: `design-system/soundspan/references/canonical-home-target.png`
- Sidebar source crop: `design-system/soundspan/references/canonical-sidebar-target.png`
- Browser implementation: `design-system/soundspan/qa/evidence/home-desktop-1487x1058.png`
- Full side-by-side evidence: `design-system/soundspan/qa/comparison/home-full-comparison.png`
- Focused shell, hero, and player evidence: `design-system/soundspan/qa/comparison/home-shell-player-comparison.png`
- Responsive evidence:
  - `design-system/soundspan/qa/evidence/home-mobile-390x844.png`
  - `design-system/soundspan/qa/evidence/vibe-desktop-1487x1058.png`
  - `design-system/soundspan/qa/evidence/vibe-short-desktop-1366x768.png`
  - `design-system/soundspan/qa/evidence/vibe-mobile-390x844.png`

The source and desktop implementation are both 1487 x 1058 physical pixels,
captured at a 1487 x 1058 CSS viewport with `deviceScaleFactor: 1`. No density
normalization or browser-frame crop was required. The comparison image places
the source on the left and implementation on the right at native size.

State: authenticated Russian account, dark theme, populated personalized feed,
active current track, desktop player visible. The QA feed used real remote music
artwork URLs and a deterministic silent audio response so transient provider
availability could not distort the visual state.

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
  inside the app boundary at both 1487 x 1058 and 1366 x 768; its tuning sheet owns
  internal overflow.
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
  and playlist-create controls have visible focus/pressed/disabled states and
  practical pointer targets.

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

## Responsive and interaction evidence

- Desktop Home: sidebar/main-column adjacency, top-bar ownership, semantic Home
  regions, and no unexpected runtime/page errors. Optional disabled Mix/Discover
  endpoints and a missing optional avatar image are explicitly recognized as
  fallback responses rather than unhandled application errors.
- Desktop player: three regions, two transport levels, artwork atmosphere,
  progress, shuffle/repeat, like/dislike, volume, overflow, and retry states.
- Vibe: no document scroll at 1487 x 1058 or 1366 x 768; play, Tune, current
  selection, current-track feedback, and Skip remain inside the locked stage.
- Mobile Home/Vibe: 390 x 844 screenshots show mobile top bar, mini player, bottom
  navigation, no desktop chrome, and no horizontal page overflow.
- PWA install: explicit install request, unavailable-prompt feedback, accepted
  pending state, `appinstalled` completion, and safe player offsets are covered by
  component tests.

## Follow-up polish

- **P3:** when playback history eventually exposes trustworthy per-track resume
  positions for online provider rows, continuation cards can add the source
  mock's progress line without synthesizing data.

final result: passed
