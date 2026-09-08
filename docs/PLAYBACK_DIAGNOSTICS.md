# Playback diagnostics

For automated playback testing on an existing listener account, send
`X-Soundspan-Diagnostic: playback` with **both** `POST /api/plays` and
`PATCH /api/plays/:playId/engagement`. Restrict header injection to the Soundspan
origin in an isolated test browser context. Close the context when finished.

Authentication and body validation remain required. Creation returns
`{ "id": "diagnostic-playback", "diagnostic": true }`; engagement returns
`{ "success": true, "diagnostic": true }`. No Play or playback attribution is
stored and no scrobble is forwarded. No schema migration or history deletion is
involved. Requests without the exact header retain ordinary behavior.

Send the same header with `GET /api/personalized/home` and
`POST /api/personalized/impressions` for Home/Wave tests. The feed computes its
ordinary personalized ranking but returns `generationId=diagnostic-recommendation`
without storing served or shadow generations, recommendation metrics or hot-set
analysis jobs. Impressions validate auth/body and return `{ recorded: 0, diagnostic: true }`.
Canonical identity and shared provider/feature caches can still be populated.

This isolates listening, skip and Home/Wave recommendation evidence, not the
whole account: likes, playlist edits, settings, playback-state sync and other
recommendation endpoints remain separate writes. Use a dedicated `isTestAccount`
fixture for whole-platform tests. Do not infer testing from short
listening duration or erase a real listener's historical skips.

An acknowledged diagnostic request is not evidence of successful audio output.
Verify actual media progress, recovery and natural queue transitions separately.
