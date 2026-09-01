# Soundspan product design system

Status: published and post-deploy verified on 2026-08-31

Published source commit: `59aa0c3e30e0a974cc0f0f5168b88ffd9968b0a1`.
Production image: `local/soundspan:2.6.1-redesign-59aa0c3`
(`sha256:21164ec09fade19376bfa81e60b3c21e8d036ae1f645b794c17dd9819d01c205`).
The companion YouTube Music streamer stayed on its previous image and was not
recreated during this release.

Authoritative visual targets:

- Home, shell, and player: [`references/canonical-home-target.png`](references/canonical-home-target.png)
- Sidebar proportions and density: [`references/canonical-sidebar-target.png`](references/canonical-sidebar-target.png)

These two images are the acceptance references for hierarchy, density, geometry,
and visual atmosphere. The earlier
[`references/editorial-flow-selected.png`](references/editorial-flow-selected.png)
is retained as exploration history, but it is not authoritative where it
conflicts with the canonical targets or the contracts below.

Reference dimensions are 1487×1058 for Home and 205×747 for the sidebar crop.
Visual QA compares the implementation at the same 1487×1058 viewport before
responsive extrapolation is accepted.

Acceptance evidence and the full comparison history are recorded in
[`../../design-qa.md`](../../design-qa.md). Responsive browser captures live in
[`qa/evidence`](qa/evidence), with native-size source/implementation pairs in
[`qa/comparison`](qa/comparison). Deployment status is recorded separately above
because evidence filenames alone are not proof of a production deployment.

## Product thesis

Soundspan is an online-first personal music service for a small group of people
who expect to press Play immediately, discover relevant music, and keep separate
taste and offline state per account and device. The primary job of every core
screen is to reduce the distance between intent and audible music.

The interface borrows proven interaction patterns from Spotify and Yandex Music,
but not their branding. Soundspan should feel recognizable through its own
artwork-led ambient field and continuous Wave behavior.

## Visual direction

**Quiet stage, living music.** Navigation and utility chrome stay calm and low
contrast. Album artwork, the active track, and the selected Wave mood provide
the color. Only one area on a screen may be visually dominant.

The signature element is the **spectral seam**: a restrained 2–3 px signal from
the current artwork or selected mood that links active navigation, progress, and
the player. A larger ambient field is reserved for Vibe and the full player. It
is not used on Settings or dense lists.

Avoid:

- pure black panels separated by many visible grey borders;
- identical rounded rectangles for every kind of content;
- blue pills as the default answer to hierarchy;
- visible horizontal browser scrollbars;
- technical provider language in user-facing labels;
- decorative gradients that are unrelated to artwork, playback, or mood;
- copying Spotify green, Yandex branding, or their exact component geometry.

## Foundation tokens

### Color

| Token | Value | Purpose |
|---|---:|---|
| `--music-canvas` | `#090909` | App background |
| `--music-stage` | `#121214` | Main content stage |
| `--music-surface` | `#1c1b1e` | Cards and list surfaces |
| `--music-raised` | `#28272b` | Menus, selected rows, overlays |
| `--music-soft` | `#343138` | Strong hover and pressed states |
| `--music-ink` | `#faf8fc` | Primary text |
| `--music-ink-body` | `#e8e3eb` | Body text |
| `--music-ink-muted` | `#cdc6d1` | Metadata |
| `--music-ink-faint` | `#aaa3b0` | Tertiary copy that remains AA on raised surfaces |
| `--music-action` | `#a970ff` | Primary actions and focus fallback |
| `--music-action-strong` | `#c497ff` | Hovered action fallback |
| `--music-positive` | `#64d8a8` | Liked/saved/success |
| `--music-negative` | `#ff738e` | Disliked/error |
| `--music-warning` | `#f0a45c` | Recoverable attention |
| `--music-line` | `rgb(255 255 255 / 0.08)` | Default separation |
| `--music-line-strong` | `rgb(255 255 255 / 0.14)` | Interactive boundary |

Artwork-derived colors are contextual variables (`--artwork-a`, `--artwork-b`)
with safe violet/amber fallbacks. They provide the Home hero and player
atmosphere; permanent chrome remains neutral. They must never reduce text
contrast below WCAG AA.

The runtime `--color-*` aliases mirror this foundation and are canonical:

- Brand: `brand #a970ff`, `brand-dark #7f4bd3`,
  `brand-hover #c497ff`, `brand-light #decaff`.
- Assisted features: `ai #d866c7`, `ai-dark #a73e96`,
  `ai-hover #f19ae5`.
- Surfaces: `surface #090909`, `surface-sunken #101011`,
  `surface-raised #121214`, `surface-elevated/overlay #1c1b1e`, and
  `surface-active/highlight/hover #28272b`.
- Lines: `line #2b292f`, `line-muted #403c47`, `line-strong #615a69`.
- Content: `content #faf8fc`, `content-body #e8e3eb`,
  `content-secondary #cdc6d1`, `content-muted #aaa3b0`, and
  `content-disabled #77717d`.
- Status: `success #64d8a8`, `error #ff738e`, `warning #f0a45c`.

`frontend/styles/tokens.ts`, the `@theme` block, and this document must change
together. Contrast tests remain the gate for text, focus rings, and shared
surfaces.

### Typography

- **Display:** the platform interface stack at a stronger weight with optical
  sizing and tighter tracking, used sparingly for the Wave title and editorial
  moments. Artwork, not a novelty font, carries product personality.
- **Interface/body:** the native system UI stack, which provides consistent
  Cyrillic support and platform-appropriate metrics on Windows, Android, and
  iOS. The Soundspan wordmark keeps its dedicated brand face.
- **Utility:** tabular numerals from the system stack for times, progress, and
  bitrate.
- Minimum body size is 14 px on desktop and 15 px on mobile; touch controls use
  at least 14 px labels. Secondary text must remain visibly readable.

### Geometry

- Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64` px.
- Compact controls: 10–12 px radius.
- Cards and sheets: 16–20 px radius.
- Dominant editorial/Vibe surfaces: 24–32 px radius.
- Circular controls are reserved for Play/Pause, avatars, and explicit icon-only
  actions.
- Minimum pointer target: 40 px desktop; minimum touch target: 44 px mobile.

### Motion

- 160–240 ms for hover, pressed, and selection feedback.
- 280–420 ms for sheets and route-level continuity.
- Use opacity and transform only for routine motion.
- Vibe may use one slow ambient field. When analyzed BPM and energy already exist
  for the active track, they control cadence and amplitude. Online-first tracks
  without those fields use a deterministic visual fallback derived from track,
  direction, and mood; the fallback is never presented as measured audio data.
- The Vibe canvas animates only while playback is active on a visible desktop
  page. It does not attach an analyzer or `AudioContext` to the media element,
  and low-power/mobile environments retain a static field.
- Dense lists must not stagger or bounce.
- Respect `prefers-reduced-motion` and provide a static ambient field.

## Layout contract

### Desktop shell

- The canonical wide layout uses a fixed 232–248 px sidebar, a fluid main stage,
  and a fixed 112–132 px player. At the 1487×1058 reference viewport the target
  proportions are approximately 247 px sidebar and 131 px player.
- Sidebar primary navigation contains only `Главная`, `Волна`, and
  `Моя музыка`. Its library section shows `Любимые треки`, then the current
  account's owned, non-hidden playlists directly; it is not a generic
  `Плейлисты` pseudo-entry.
- A short desktop viewport (850 px high or less) shows one direct playlist and a
  compact `Все плейлисты +N` escape before `Создать плейлист`, so the sidebar
  does not expose a nested scrollbar at 720p. Taller desktops may show a bounded
  list, with the same overflow escape when more shortcuts exist.
- Do not add `Недавние`, Podcasts, separate Artist/Album/Track destinations, or
  an `All playlists` sort toolbar to the sidebar. Playlist creation remains a
  clear action below the owned shortcuts.
- Search is globally available in the top bar; the Search route is a result
  canvas, not a sidebar destination. The top bar must not duplicate the three
  primary sidebar destinations.
- The main stage owns artwork color and page hierarchy. Permanent shell chrome
  remains neutral so the current artwork is the only ambient color source.
- The player is a stable three-zone bottom dock: identity on the left,
  two-level transport and timeline in the center, and current-track utilities
  on the right. Music transport visibly exposes Shuffle / Previous / Play-Pause
  / Next / Repeat. Diagnostics and rare actions remain in overflow.
- Content reserves player height; neither the player nor its popovers may cover
  playable rows or cause layout movement when the track changes.

### Mobile PWA

- Bottom navigation contains `Главная`, `Волна`, and `Моя музыка`. Search opens
  from the persistent header control with immediate focus; it is not a second
  navigation destination.
- A compact player sits immediately above it; tapping opens a full-screen player.
- Sheets replace centered dialogs for Wave tuning, downloads, and track actions.
- Safe-area insets and offline state are part of the component contract.

## Content archetypes

Use only these recurring content shapes:

1. **Quick tile** — short horizontal item for recent activity or a saved action.
2. **Music card** — square artwork with title and one metadata line for albums,
   mixes, artists, and stations.
3. **Editorial card** — larger artwork-led module for a daylist, discovery set, or
   mood collection.
4. **Track row** — the canonical dense playable unit with clear active, loading,
   liked, disliked, downloaded, and unavailable states.

Carousels hide system scrollbars and expose previous/next controls on desktop.
Mobile carousels show a partial next card as an overflow cue.

## Core screen contracts

### Home

- Opens with the artwork-led `Моя волна` hero from the canonical Home target:
  roughly 225 px artwork, a concise personal explanation, one primary
  `Запустить` action, and a secondary `Настроить` action.
- The first desktop viewport prioritizes `Продолжить прослушивание`, a compact
  right-side `Недавно слушали` list, and `Миксы для вас`. `Недавно слушали`
  belongs here, never in the sidebar.
- At 1487×1058, Continue cards are approximately 180 px wide in four columns;
  the recent rail is approximately 280–300 px wide. Artwork and readable
  metadata carry hierarchy instead of nested bordered panels.
- Additional ranked sections may follow below the fold, with 5–7 sections at
  most: daily mixes, discovery, listen again, relevant stations, and new
  releases. Provider shelves are deduplicated, taste-ranked, and hidden when
  irrelevant.
- `Миксы для вас` is one visually continuous surface. `Показать все` expands the
  available personal and generated mixes inline and changes to `Свернуть`; it
  must not navigate to the general playlists collection.
- Other desktop shelves expose `Показать все` or restrained previous/next
  controls; they do not show native horizontal scrollbars.

### Vibe

- On desktop, Vibe occupies the available area between top bar and player using
  `100dvh`-based sizing. The document itself must not scroll.
- Uses a full-stage artwork-derived ambient field and one dominant Play/Pause
  action. The current track, direction, mood, and feedback remain visible in
  the fitted stage rather than becoming a long settings page.
- `Direction` (`For you`, `New`, `Familiar`) and `Mood/scenario` (`Calm`,
  `Energetic`, `Focus`, `Workout`, `Forgotten`, `Favorites`) are independent.
- Tuning opens an overlay sheet. The sheet owns any required internal scroll and
  keeps the current song playing; closing it returns to the same Vibe state.
  On mobile only, minimal internal scrolling is acceptable when safe-area and
  44 px touch targets cannot otherwise fit.
- Every tuning option changes candidate ranking; no decorative inactive filters
  are allowed. The chosen direction and mood persist per account across
  navigation and are reflected in the Vibe URL.
- Applying a different direction or mood while Wave is active immediately
  requests the new candidates, replaces the Wave queue, and advances away from
  the old current track. Reapplying the unchanged pair does not skip. A failed
  replacement keeps playback recoverable and exposes a retry without discarding
  the requested selection.
- Like, dislike, and skip stay next to the current track and affect this account.

### Search

- Search input remains in the global top bar and suggestions appear while typing.
- Result filters are sticky and deep-linkable.
- `All` for an artist query shows the canonical artist, 5–10 popular tracks,
  unique albums, and related artists without requiring `Show all` for the main
  intent.
- `Tracks` returns a real combined provider list and a useful recovery state only
  when no playable results exist.

### Artist

- Artwork-led hero with Play, Shuffle, Save/Follow, and overflow actions.
- Sticky filters: `Overview`, `Tracks`, `Albums`, `Singles`.
- `Tracks` exposes the complete available catalog in a sequential playback queue.
- Duplicate provider/local shadow entities are merged before presentation.

### Album and Playlist

- Share the same detail-page language as Artist: ambient hero, action dock, and
  one canonical track surface.
- Playback always continues in the visible list order before similar music begins.
- Save/download actions state exactly where the content will be stored.
- The playlists collection has an explicit create action and focused create
  dialog. Add-to-playlist uses a responsive selector containing only playlists
  owned by the current account; the same selector can create a playlist and
  safely retry adding to that already-created playlist after a transient error.

### Library

- User collection, not server storage. Its top-level tabs are `Плейлисты`,
  `Альбомы`, and `Исполнители`; the Playlists view combines `Любимые треки`,
  owned personal playlists, and `Загрузки на этом устройстве` in one hierarchy
  instead of duplicating them as separate destinations.
- A canonical track row shows a download icon only for a verified ready copy on
  the current device. Absence of a local copy has no placeholder icon.
- Supports grid/list density without changing the information hierarchy.

### Settings

- Uses progressive disclosure: Account, Playback, Offline, Integrations,
  Appearance, Security.
- Technical and administrative options live one level deeper.
- Settings remain calm and do not use artwork ambient fields.

## Accessibility and quality floor

- Text contrast is at least 4.5:1; large text is at least 3:1.
- Visible keyboard focus uses `--music-action` without layout shift.
- All icon-only controls have accessible names and tooltips where needed.
- Loading preserves layout; broken artwork always has a deliberate fallback.
- Validate at 375, 768, 1024, and 1440 px, plus installed Android and iPhone PWA.
