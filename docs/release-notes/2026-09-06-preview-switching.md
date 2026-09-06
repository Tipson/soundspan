# Short-preview switching: 6 September 2026

Released frontend revision: `24f75302b70c21ce722e4f24f8f693c06e2e11d4`.
Image: `local/soundspan-frontend:preview-24f7530`.

## Reproduction and change

- verify: production Chromium, isolated operator account, 20 distinct Wave
  tracks plus back/repeat selections. No playback timeout in that run.
- verify: first Wave start took 5216 ms; a separate Breaking the Habit start
  took 5344 ms. The latter spent about 5003 ms between loadstart and playing.
  This confirms remaining network startup latency, not its elimination.
- Rapid selection after a 900 ms preview retained a 1250 ms client gate because
  the prior track had not played five seconds. The settled-preview threshold
  is now 0.5 seconds. Its gate remains 300 ms; unresolved bursts retain 1250 ms.
- verify: matched source IDs and 900 ms preview: Next to `ljUtuoFt-8c`
  improved 1362 -> 394 ms; Previous to `ZEMBDKMtHqM` improved 1302 -> 350 ms.
  Measurements are click to browser playing, not physical audible output.
- New tracks after release still took 2519 and 3775 ms. Cold startup stays open.

## Checks and deployment

- verify: regression failed before the fix; 133 orchestrator component tests
  passed afterwards, including 0.49/0.5/0.75/30 second boundary cases.
- verify: full frontend component suite, typecheck, targeted lint and immutable
  frontend image build exited 0. Ordinary and bounded self-adversarial review
  found no additional blocker in the changed gate/cancellation boundary.
- verify: frontend reached healthy. Deployment asserted unchanged backend,
  worker and YouTube container IDs and unchanged Privoxy configuration hash.
- Only frontend was replaced. No git push or provider/account-wide rollout.
- Browser was paused after testing. The burst test's final pause selector was
  ambiguous; pause was recovered separately. Do not count it as clean end-to-end
  burst acceptance. Unit cancellation/burst coverage remains green.

Rollback overlay backup:
`/srv/music/soundspan-releases/b0-b340a7c/compose-before-preview-24f7530.json`.
Restore only the previous frontend image; do not revert unrelated services.

## Remaining priorities

1. Separate URL resolution, CDN first-byte and first playable buffer costs for
   ordinary cold tracks; optimize the measured bottleneck with bounded work.
2. Repeat a clean rapid-burst browser scenario and physical iPhone acceptance.
3. Test-account first-login sync screen polls an admin maintenance endpoint and
   receives 403 until skipped. Track separately from audio errors.
4. No 100-listener capacity conclusion follows from these single-session tests.

Local evidence: `output/p0-breaking-cold-before.log`,
`output/p0-skip-batch1.log`, `output/p0-matched-after.log`,
`output/p0-after-batch1.log`, `output/preview-release.log`.
