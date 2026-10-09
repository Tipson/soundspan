# Taste Profile

Account-scoped first-run music-taste setup and its reusable settings editor.

## Boundaries

- `api.ts` is the typed frontend boundary for `GET`, `POST`, and `PUT /api/taste-profile`.
- `hooks/useTasteProfile.ts` uses the shared query-key factory to key query and mutation results by the authenticated account ID. A late response for one account cannot populate another account's cache.
- `components/TasteProfileOnboardingGate.tsx` renders only when the server returns `needsOnboarding: true`. Existing listeners and accounts that explicitly skipped setup see no dialog.
- `components/TasteProfileEditor.tsx` replaces the same profile later without repeating first-run semantics.
- Selected genres and artists create bounded recommendation seeds only. The flow never writes likes, plays, or playlist membership.

## Integration

The protected `AuthenticatedLayout` mounts the onboarding gate once with the
current `user.id`. `TasteProfileSettingsSection` mounts `TasteProfileEditor`
through its explicit open/close control. Loading failures offer a retry in the
dialog; failed saves keep the current choices available for another attempt.

## Selection flow

The fullscreen artist-selection screen provides genre shortcuts and an expandable
“Все жанры” palette with 34 genres in six groups. Escape closes the palette and
returns focus to its trigger. The screen contains only its title, search, filters,
artists, selection count and save action; routine explanatory paragraphs are omitted. “Все исполнители” browses Last.fm charts; individual genres
map to community tags. Catalog pages contain 48 artists and load near the scroll
boundary, with an accessible load/retry button. Names are deduplicated across
pages. Saved-genre browsing interleaves those genres one request at a time.
Catalog-wide canonical artist search is also available. Filters do not implicitly add preferences.
Saved genres and selected artists remain removable across filters.

Genre/search controls sit outside the scrolling results. The save action remains
visible. Changing a genre resets the result scroll position. Portrait loading is
cached and limited to three concurrent requests; missing artwork uses initials.

There are no minimum or maximum selection counts. Empty selections explicitly
clear preferences and finish onboarding. Label validation and the application's
request-body safety limit still apply. The complete selection is persisted;
initial playable recommendation seeds use at most sixteen queries sampled across
the entire selection and at most twelve tracks. Seed recovery retains all labels.
This finite starter shelf is not an exhaustive playlist for every selected artist.

The interaction reference is Yandex Music's documented genre-filtered artist
selection, including a mixed shelf and Russian-language genre branches:
[Yandex accessibility guide](https://inclusion.yandex.ru/tutorials/music-web),
[preference settings](https://www.yandex.ru/support/music/ru/technical-issues/incorrect-recommendations).
The labels and curated artist shelves are Soundspan's examples, not an exported
Yandex taxonomy. The layout is a Soundspan adaptation. The curated shelf is only
an initial/offline fallback, explicitly labelled on a catalog failure. Shared
server pages are cached for six hours and concurrent identical requests coalesce.
Upstream failures return 503 rather than pretending the catalog ended; retry keeps
already loaded cards and selections. Preview playback is not implemented; no likes
are created by this flow. Portrait homonyms remain a separate identity issue.

## Tests

- Unit coverage verifies label normalization, unrestricted counts, account query keys,
  and the exact API methods and bodies.
- Component coverage verifies Russian copy, accessible dialog behavior,
  selection and skip flows, shell gating, and a late account-A mutation while
  account B is active.
- Editor coverage verifies load retry, failed-save recovery, recommendation
  invalidation, and reopening saved choices through another API read.
