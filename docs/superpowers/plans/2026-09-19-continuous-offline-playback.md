# Continuous offline playback implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Preserve the user's autonomous execution authorization and no-push rule.

**Goal:** Prevent physical Android offline playback from losing its audio session at prepared track boundaries.

**Architecture:** A bounded MediaSource transport supplies the existing native element. An AudioEngine adapter translates track-relative controls and events without replacing the source at a prepared natural handoff. Existing source and queue ownership remain authoritative.

**Tech Stack:** TypeScript, browser MediaSource/SourceBuffer, native HTMLAudioElement, node:test, Chromium and physical ADB diagnostics.

**Spec:** `docs/designs/androidContinuousOfflinePlayback.md`

## Global constraints

- Node.js 24; no new runtime dependency required.
- TDD for retained executable code; throwaway diagnostic prototypes stay outside the repository.
- One audible element, current/next source ownership only; no silent keepalive audio.
- Preserve manual pause, offline availability, account cleanup and source generation guards.
- No production rollout based only on mocks, a standalone fixture, or MediaSession PLAYING.
- No git push; rollback-ready deployment only after acceptance.

## Review focus

- A cancelled or replaced next item must never become audible.
- Seek and repeat must work after old decoded ranges have been evicted.
- Empty, unsupported, corrupt or differently encoded files must not trap a queue.
- A load cancelled during an asynchronous append must not resume after user pause.
- Progress, completion and diagnostics must describe the current occurrence, not the aggregate timeline.

## Task 1: Confirm transport viability

- [x] Reproduce native and Howler failures on physical Pixel.
- [ ] Complete a correctly foreground-started continuous-stream phone run with Wi-Fi/data disabled and screen locked.
- [ ] Verify parsed boundaries, real output progress and service retention, then document limitations.

## Task 2: Bounded source transport

Files: `frontend/lib/audio-engine/continuousAudioBuffer.ts`, `frontend/tests/unit/continuousAudioBuffer.test.ts`.

Consumes an injected SourceBuffer, local blob source descriptors, native position and cancellation signals. Produces bounded serialized append/remove operations, current/next timeline boundaries, cancellation, refill-on-seek and cleanup.

- [x] Write failing behavioral tests for bounded append, stale/cancelled next sources, asynchronous errors and seek refills.
- [x] Run targeted node:test through the existing WSL Node 24 environment; confirm RED.
- [x] Implement the transport and pass targeted tests.
- [x] Exercise real browser decoding for supported containers and format changes; verify output sequence rather than only call counts.

## Task 3: Engine integration

Files: `frontend/lib/audio-engine/continuousAudioEngine.ts`, `frontend/lib/audio-engine/index.ts`, `frontend/lib/audio-engine/engineSelectionPolicy.ts`, associated unit/component tests.

Consumes the bounded transport and existing native engine. Produces the same AudioEngine control/event contract, track-relative positions, one logical end per source occurrence and exact-source preload promotion.

- [x] Pin pause-during-load, queue replacement, stale end, replay, out-of-buffer seek and cancellation behavior in failing tests.
- [x] Implement adapter and retain existing source ownership and generation checks.
- [x] Keep production activation gated on physical acceptance; candidate builds exercise the adapter, with no loop-based prototype in product code.
- [x] Verify runtime source selection and compatibility fallback with behavioral tests.

## Task 4: Acceptance and release

- [x] Build the candidate; run unit/component/typecheck/lint/build gates appropriate to changed frontend.
- [ ] Run real downloaded queues on Pixel and Realme, including 30-minute offline screen-off Pixel acceptance.
- [x] Review ordinary diff and apply adversarial-reviewer to cancellation, memory bounds, playback intent and queue ownership.
- [ ] Update changelog/release evidence; prepare rollback; deploy only a validated candidate and verify its build and user-visible flow.


