# Soundspan product design system

Status: deployed release candidate — physical device acceptance pending

Implementation baseline: `ebf89affd7a639bde640ef7d54e4aa58cc633541`

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

The signature element is the **ambient wave field**: a restrained color field
derived from the current artwork or selected mood. It connects the Home hero,
Vibe, full player, and compact player. It is not used on Settings or dense lists.

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
| `--music-canvas` | `#07080b` | App background |
| `--music-stage` | `#0c0e13` | Main content stage |
| `--music-surface` | `#12151c` | Cards and list surfaces |
| `--music-raised` | `#181c25` | Menus, selected rows, overlays |
| `--music-soft` | `#202532` | Strong hover and pressed states |
| `--music-ink` | `#f7f7fa` | Primary text |
| `--music-ink-body` | `#d8dae2` | Body text |
| `--music-ink-muted` | `#a2a6b3` | Metadata |
| `--music-ink-faint` | `#747987` | Disabled and tertiary copy |
| `--music-action` | `#7c9cff` | Primary actions and focus |
| `--music-action-strong` | `#a9bcff` | Hovered action |
| `--music-positive` | `#63d59a` | Liked/saved/success |
| `--music-negative` | `#ff718d` | Disliked/error |
| `--music-warning` | `#f4c76e` | Recoverable attention |
| `--music-line` | `rgb(255 255 255 / 0.08)` | Default separation |
| `--music-line-strong` | `rgb(255 255 255 / 0.14)` | Interactive boundary |

Artwork-derived colors are contextual variables (`--artwork-a`, `--artwork-b`)
with safe indigo/blue fallbacks. They must never reduce text contrast below WCAG
AA.

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
- Vibe may use one slow ambient field; dense lists must not stagger or bounce.
- Respect `prefers-reduced-motion` and provide a static ambient field.

## Layout contract

### Desktop shell

- Compact left navigation holds only Home, Search, Vibe, Library, and personal
  playlists.
- Search is globally available in the top bar; the Search route is a result
  canvas, not a second navigation concept.
- The main stage owns the artwork color and page hierarchy.
- The player is a stable bottom dock, visually connected to the current artwork,
  with playback in the center and preference/queue actions grouped predictably.

### Mobile PWA

- Bottom navigation contains no more than four primary destinations.
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

- Opens with one contextual Wave action, not a marketing explanation.
- Shows 5–7 ranked sections at most: jump back in, daily mixes, discovery,
  listen again, relevant stations, new releases, and one contextual mood row.
- Provider shelves are deduplicated, taste-ranked, and hidden when irrelevant.

### Vibe

- Uses a full-stage ambient field and one dominant Play/Pause action.
- `Direction` (`For you`, `New`, `Familiar`) and `Mood/scenario` (`Calm`,
  `Energetic`, `Focus`, `Workout`, `Forgotten`, `Favorites`) are independent.
- Tuning opens a bottom sheet or compact desktop sheet. Every option changes the
  candidate ranking; no decorative inactive filters are allowed.
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

### Library

- User collection, not server storage: Playlists, Albums, Artists, Liked, and
  Downloads on this device.
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
