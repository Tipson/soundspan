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

Keep suggested labels real and useful without presenting them as an external
catalog search. Manual artist entry remains available when a listener's choice
is not among the zero-network suggestions.

## Tests

- Unit coverage verifies label normalization, count limits, account query keys,
  and the exact API methods and bodies.
- Component coverage verifies Russian copy, accessible dialog behavior,
  selection and skip flows, shell gating, and a late account-A mutation while
  account B is active.
