# Collection playback and artist radio

Status: design phase

## Scope

Restore primary collection playback as a consistent purple circular icon button. Keep accessible labels, loading states, shuffle and secondary actions. Active collection pause/resume must survive client navigation and must not control an unrelated queue.

Artist radio must work for external catalog artists with no local audio. Match seed recordings to the requested artist, retain provider metadata, bound lookup/fan-out, distinguish empty results from provider failures, and preserve newer playback intent and shared-session confirmation.

## Verification and release checklist

- [x] Reproduce empty artist radio on public production API with a test account.
- [x] Observe failing regression tests before implementing UI and radio corrections.
- [x] Finish targeted tests and independent adversarial review.
- [ ] Run frontend/backend builds, tests and repository gates against the exact candidate.
- [ ] Commit locally; do not push.
- [ ] Back up and release only frontend/backend/worker, retain rollback images.
- [ ] Verify production artist radio, media response and desktop/mobile button states.
- [ ] Update the canonical Obsidian task list with evidence and remaining limitations.

## Implementation boundaries

Collection ownership is kept in the current browser runtime and follows committed queue/media replacements. Pause, seek, ordinary next and cancelled radio requests retain it; switching media or replacing the queue invalidates it. A full browser reload does not restore collection provenance, so the primary collection button starts that collection explicitly. Cross-device session synchronization is outside this change.

Remote artist radio searches up to 20 songs, accepts exact normalized artist names, requests recommendations from at most three valid unique seeds, removes seeds and duplicates, and preserves provider identifiers. It does not substitute unrelated search results when no matching recording exists. Provider failures remain errors; successful empty results remain empty. Continued Wave behavior and other provider integrations are unchanged.

The implementation does not modify playback transport, offline audio storage, downloads, recovery timing, existing queue-intent guards, or provider credentials.
