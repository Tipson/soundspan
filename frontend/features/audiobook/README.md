# Audiobook Feature Domain

Start-here guide for `frontend/features/audiobook`.

## Start Here

1. Route entrypoints: `frontend/app/audiobooks/[id]/page.tsx` and `frontend/app/audiobooks/series/[name]/page.tsx`
2. Primary tests and route entrypoints for this domain are listed below.
3. Targeted verification commands:
- `npm --prefix backend test -- --runInBand src/routes/__tests__/audiobooksRuntime.test.ts src/routes/__tests__/audiobooksAdvancedRuntime.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/audiobookshelfService.test.ts`
- `npm --prefix backend test -- --runInBand src/services/__tests__/audiobookSections.test.ts src/services/__tests__/audiobookCacheService.test.ts`
- `npm --prefix frontend exec -- node --test --experimental-test-module-mocks --import tsx tests/component/chapterList.component.test.ts`

## Section Navigation

The detail page renders only validated cached sections. Sparse or malformed
Audiobookshelf chapters are replaced by derived multi-file parts when possible.
Navigation remains hidden for honest-empty results. Valid chapters and
multi-file parts seek within the concatenated audiobook stream.

## Directory Contents

| Path | Kind |
| --- | --- |
| `components/AboutSection.tsx` | components |
| `components/AudiobookActionBar.tsx` | components |
| `components/AudiobookHero.tsx` | components |
| `components/ChapterList.tsx` | components |
| `components/index.ts` | components |
| `components/PlayControls.tsx` | components |
| `hooks/index.ts` | hooks |
| `hooks/useAudiobookActions.ts` | hooks |
| `hooks/useAudiobookData.ts` | hooks |
| `index.ts` | root |
| `types.ts` | root |

## Update Rule

- When adding/removing significant files or changing behavior in this domain, update or verify this README and keep the targeted commands below accurate in the same change set.

## Progress write ordering

Manual finish/reset captures a terminal metadata intent before the existing pause.
`lib/audiobookProgressWrites.ts` serializes writes per book and auth generation,
so a pending autosave finishes before the manual write and pause autosaves cannot
undo it. Responses update player metadata only while the book activation and
intent still match. Explicit resume/replay opens a new progress session; failed
writes can be retried. Playback commands and podcast persistence are unchanged.
This is in-tab ordering, not server-side versioning across devices or requests
that commit after a client-side network failure.

Behavioral coverage: `tests/component/audiobookProgressIntent.component.test.ts`
uses the actual hooks and audiobook API request bodies with held responses.

The shared audio controls open the progress session synchronously in `resume`
and `playAudiobook`, before React commits playback state. The persistence layout
effect only resets deduplication; it must not revoke a newer manual intent.
