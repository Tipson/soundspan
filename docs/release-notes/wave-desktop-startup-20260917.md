# Wave desktop startup investigation — 17 September 2026

Status: production pacing correction deployed at 10:28:38 UTC; sustained upstream capacity remains unproven.

## Evidence

The existing Chrome production Wave tab was opened at 09:02:15 UTC. Its retained Resource Timing entries match YouTube-sidecar startup logs at 09:02–09:03 UTC; these are historical entries from this session, not proof of the exact time of the latest complaint.

| Video | Browser header wait | Server resolution stage | Server first readable bytes from task creation |
| --- | ---: | ---: | ---: |
| BwALMfjFkjI | 8875 ms | 11756 ms | 12425 ms |
| UprcpdwuwCg | 9834 ms | 9050 ms after 2946 ms admission wait | 12712 ms |
| 47dtFZ8CFo8 | Request incomplete/cancelled in retained browser timing | 13122 ms after 12725 ms admission wait | 26140 ms |

Task timestamps can predate a click because of preloading. Browser total request duration includes subsequent download; it is not click-to-playing. The two clocks must not be subtracted without correlation.

At approximately 10:06–10:08 UTC, two manual Next actions in the existing Wave tab produced successful HTTP 206 audio responses with header waits of 62 ms (Watermelon Sugar) and 122 ms (Fluorescent Adolescent). The visible playback timeline advanced after both. This is not an audible PCM check or a controlled cold-start reproduction. The user's tab was left playing; no reload or settings change.

## Finding and next bounded work

Cold resolution and waiting for extraction capacity can dominate playback startup. Prepared sources were fast in the two current checks. No CAPTCHA explanation or PC performance fault is established for the observed slow requests.

Before changing limits, reproduce a cold transition in an isolated test session and separate extraction admission, pacing, provider extraction, and delivery. Verify the promotion of preloaded work to interactive priority against the actual deployed sidecar. Evaluate earlier bounded preparation and existing service fallback without relaxing track-identity matching or multiplying extraction concurrency. Preserve the production frontend playback fixes.

Production backend image: 6668d1f39301; frontend: 3d7382d331d4; YouTube: fcaf1e05c8fd. The local functional commit bde22af9 is not deployed by this task. During the initial read-only investigation no production changes were performed. The subsequent configuration release is recorded below. No push was performed.


## Root cause and production correction

A fresh standalone process using the production runtime and environment reproduced 12.2 seconds to resolve a URL. Per-stage instrumentation of the same sequence then measured pacing waits of 9206 and 11116 ms, while the actual fast extraction took 681 and 464 ms. Thus the former broad `resolve_start`/`resolved` interval included our deliberate pause, not only provider response time. Production still had `YTMUSIC_EXTRACT_DELAY_MIN=10` and `YTMUSIC_EXTRACT_DELAY_MAX=15` from the earlier challenge incident.

An isolated configuration trial of 1–2 seconds delivered initial audio bytes for four tracks in 3212, 741, 1073 and 1659 ms, all HTTP 206. It did not read the serving process's stream-URL cache or spool. Initial public-context setup accounts for part of first-start variability. These are prefix checks, not full-file decode or long-term quota tests.

Only these two environment values were changed in production. Both existing images were pinned to their inspected image IDs. The two-worker extraction bound, provider cooldown, priorities, storage and source selection remained intact. The namespace-sharing companion was recreated against the current YouTube container. Thirteen other containers retained IDs and start times; all inspected mounts, ports and network memberships remained unchanged. Runtime environments were compared exactly, allowing only the two intended values.

Deployment: `/srv/music/soundspan-releases/wave-pacing-20260917/compose.json` on CT121, appended to the existing Compose chain. Seven configuration files are backed up privately. Keep this overlay in future YouTube deployments; running an older Compose chain can restore obsolete pacing. Rollback:

```sh
python3 /srv/music/soundspan-releases/wave-pacing-20260917/release.py rollback
```

The release refuses configuration drift, pins original images, verifies runtime invariants and attempts automatic rollback on failed activation. Rollback execution was not rehearsed on the live service.

## Acceptance and review

- Actual deployed environment reads min=1, max=2, extraction workers=2. A fresh sequential extraction process delivered three prefixes in 1562, 918 and 1406 ms, all HTTP 206, 16384 bytes each.
- The serving process recorded a new shared-spool startup for `OSPLfQ3TXZU`: resolution 2057 ms and first readable audio at 2959 ms from task creation.
- Production Wave Next changed Bring Me To Life to Something In The Way; the visible timeline advanced to 1:13 without an error toast. No precise click-to-playing claim is made for this acceptance.
- Public `/api/health`: HTTP 200. The bounded post-deploy YouTube log window contained zero matched ERROR/Traceback/challenge-cooldown/403/429/502–504 lines. This does not prove no future upstream refusal.
- Existing priority/pacing and extraction-budget suites: 21 passed, eight existing FastAPI deprecation warnings. Initial test attempts used an absent Python alias / interpreter without httpx; the existing incident virtual environment ran successfully. Application source/dependencies/images did not change, so no new application build was needed; Compose rendering and exact runtime comparison passed.
- Ordinary review: only pacing changes and required companion lifecycle; no frontend or database migration. Adversarial review: CONCERNS (P2 sustained upstream quotas unknown), no confirmed P0/P1 in this configuration change. Reduced spacing admits more provider requests; two-worker capacity and escalating cooldown stay active. No claim that CAPTCHA is permanently solved.
