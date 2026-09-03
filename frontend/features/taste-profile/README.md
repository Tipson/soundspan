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
current `user.id`. Settings can mount `TasteProfileEditor` after its account
section owns an explicit open/close control; no route or global layout state is
required.

## Selection flow

1. Browse 34 genres in six groups or narrow them by text search. Genre selection
   is optional; the listener can go directly to artists.
2. Browse a balanced mix of the chosen genres, filter to another genre without
   implicitly selecting it, or use canonical MusicBrainz artist autocomplete.
   The curated shelf starts with twelve artists and expands on demand; it is not
   a live provider catalog. Selected artists remain removable across filters.
3. Review all selected genres and artists, including saved labels outside the
   curated catalog, before saving. Returning to earlier steps preserves choices.

The existing API limits remain 3–16 total signals and at most ten of each kind.
The footer stays visible while long genre and artist lists scroll independently.
Suggestion browsing makes no provider calls; autocomplete remains debounced and
cancellable, and saving uses the existing bounded seed-resolution service.

The interaction reference is Yandex Music's documented genre-filtered artist
selection, including a mixed shelf and Russian-language genre branches:
[Yandex accessibility guide](https://inclusion.yandex.ru/tutorials/music-web),
[preference settings](https://www.yandex.ru/support/music/ru/technical-issues/incorrect-recommendations).
The labels and curated artist shelves are Soundspan's examples, not an exported
Yandex taxonomy. The three-step flow is a Soundspan adaptation, not a claim about
Yandex's exact step count. Preview playback and an infinite artist map are not
implemented; no likes are created by this flow.

## Tests

- Unit coverage verifies label normalization, count limits, account query keys,
  and the exact API methods and bodies.
- Component coverage verifies Russian copy, accessible dialog behavior,
  selection and skip flows, shell gating, and a late account-A mutation while
  account B is active.
