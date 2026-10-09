# Recommendation quality and early playback stops — 2026-10-07

Read-only measurement after browser-journey commit `9d65dad4`. No application,
ranking, schema, routing, or autoplay-pause behavior changed. Nothing deployed or
pushed. Canonical follow-up and full evidence are in Obsidian notes 38 and 39.

## Measurement boundary

The fixed interval is `[2026-09-30T10:25:07Z, 2026-10-07T10:25:07Z)` with another
seven days of history. Test accounts are excluded. A bounded one-off Prisma
reader used only `count/findMany` and disconnected; no recommendation generation
or provider requests were triggered. Before/after row counts agreed, all declared
limits were respected, and the report returned `complete: true`.

The 14-day reader covered 1,996 Play rows, 954 served generations, 26,755 exposure
rows, and 100 currently active track dislikes. The primary seven-day interval has
694 Play rows across six accounts and 279 served generations across seven
accounts: 9,575 generated positions, 938 recorded impressions, and 540 exposure
rows with playback attribution. These are different denominators.

## Observed repeats and feedback

An attempt is one persisted Play ID. Positive measured progress requires
`listenedSeconds > 0` or `0 < completionRatio <= 1`; failed or very short attempts
can have progress. Repeats require the same owner and exact provider/local ID,
with a strictly earlier attempt within 24 hours or seven days. Prior history
includes every context. Alternate uploads/providers are not merged, so this is a
lower bound on equivalent-recording repeats.

| Context | Attempts | Positive progress | Attempt repeats, 24h / 7d | Progress repeats, 24h / 7d |
| --- | ---: | ---: | ---: | ---: |
| All | 694 | 641 | 43 / 83 | 20 / 46 |
| Wave | 558 | 511 | 42 / 66 | 19 / 34 |
| Personalized mixes | 53 | 51 | 0 / 3 | 0 / 3 |
| Explicit manual contexts | 7 | 5 | 0 / 4 | 0 / 2 |
| Home without unambiguous mix attribution | 76 | 74 | 1 / 10 | 1 / 7 |

Wave repeats are confirmed: 7.53% of attempts within 24 hours and 11.83% within
seven days; positive-progress repeats are 3.72% and 6.65%. Mix playback covers only
one account. Manual selection repeats are not automatically recommendation
failures, and a recorded Play is not proof that audio was audible.

All 100 current active track dislikes resolved. There were zero exact-identity
matches in served generations created strictly after the current dislike, zero
associated viewed/played exposure rows, and zero Play attempts after the current
dislike. Historical cleared/rewritten feedback, alternate recordings, and artist
bans are outside that claim.

Artist keys covered all 9,575 generated positions. The longest same-artist streak
within a generation was three; p95 was two. Baseline home generations had a mean
largest-artist share of 22.28% for `for-you` (19 generations) and 26.48% for `new`
(five). Wave `for-you` shares were 6.80% baseline (33) and 5.54% hybrid (20).
Thematic mixes require a different interpretation of concentration.

## Hybrid decision

The existing evaluator was also run with a served-only in-memory repository.
Shadow alternatives are excluded from actual impression denominators:

| Metric | Baseline | Hybrid |
| --- | ---: | ---: |
| Served generations | 132 | 147 |
| Recorded impressions | 596 | 342 |
| Repeat impressions within 24 hours | 241 / 596 (40.44%) | 20 / 342 (5.85%) |
| Repeat impressions within seven days | 313 / 596 (52.52%) | 61 / 342 (17.84%) |
| Meaningful/completed final attributions | 187 / 271 (69.00%) | 168 / 257 (65.37%) |
| Early skips among final attributions | 82 / 271 (30.26%) | 88 / 257 (34.24%) |

These repeat-impression metrics use canonical keys and recorded impression times,
not Play identities. Exposure engagement is latest attribution, not an immutable
per-attempt ledger. Only three accounts had observations for both algorithms.
Equal-account meaningful completion was 84.49% baseline / 72.81% hybrid; early
skips were 15.23% / 26.52%. This observational sample does not establish causality
or justify expanding the live `hybridRolloutPercent=50` to 100%.

## Confirmed early stop

One fresh Android/native/network run was hidden on 2026-10-07:

- 10:04:43Z: native pause at 3.98 seconds with 1.66 seconds buffered.
- 10:04:44Z–10:04:45Z: unexpected pause despite play intent; recovery advanced the
  clock to 4.12 seconds.
- 10:04:49Z: stalled at 4.96 seconds with 0.68 seconds buffered, `readyState=2`.
- 10:04:56Z: buffer timeout and `MEDIA_ERR_NETWORK`.
- 10:05:01Z: fatal after source recovery, engine stopped, position zero.
- 10:09:07Z: after returning to the foreground, the 116.14-second track was fully
  buffered and its clock advanced again; track-end arrived at 10:11:04Z.

Observed timestamps and owner/run correlation establish the order; delivery was
delayed by about 244–259 seconds. Later foreground playback does not erase the
earlier failed automatic recovery. `navigator.onLine=true` is not proof of a
working connection or media pipeline.

The bounded streamer interval 10:03:40Z–10:05:15Z contained health/warmup 200 and
preload 206 responses, without explicit CDN-continuation errors or HTTP 5xx.
There is no request/run correlation, so this cannot rule out a network or server
fault. The initial pause/buffer exhaustion cannot yet be attributed to phone
connectivity, browser suspension, an OS interruption, or the older CDN incident.

At the snapshot, all 14 containers were healthy; the route monitor had 65/65
successful checks. That monitor covers two initial Range fragments, not decoding
or background playback on a phone. The 24-hour diagnostic summary had one
affected run and one explicit recovery failure; the retained week had 45 affected
runs: 23 recovered, seven failed, 15 unresolved. This is not a failure rate for all
plays.

Both client and server diagnostic allowlists omit the source-recovery `outcome`
field emitted by `useServerMusicSourceRecovery`. The incident records that source
recovery was attempted but cannot distinguish its detailed failed/no-candidate
result. Preserving a bounded result and correlating recovery with media state is
the next diagnostic step. The reverted autoplay-pause feature remains reverted.

## Verification and artifacts

verify: backend build; 14 existing evaluator/CLI/persistence tests; 18 one-off
analysis tests; Node syntax check; arithmetic, read-only/privacy and limit reviews.
No physical Android/iPhone acceptance was performed.

One-off scripts, aggregate JSON, and verification record are outside the source
checkout at
`C:/Users/Dartum/Documents/ChatGPT/soundspan/output/recommendation-quality-20261007/`.
No private database rows, user IDs, track titles, provider IDs, or source URLs were
copied into the aggregate reports. Enumeration counts bracket the read but do not
form an atomic snapshot; mutable engagement cannot reconstruct historical state.
Future Play engagement/viewed/played timestamps were suppressed at the cutoff;
exposure outcome has no separate update timestamp.

Next priorities: diagnose failed background recovery without changing pause
behavior; then tune home impression repeats and Wave playback repeats separately,
preserving familiar/manual intent and verifying comparable outcomes.
