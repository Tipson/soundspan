# Source recovery position and diagnostics

Status: verified locally; not deployed.

Native stop resets its clock. A listener who paused an in-flight source replacement could explicitly resume from zero; repeating pause/resume before metadata also allowed a competing play handler to bypass restoration. Retain the confirmed target for the same queue occurrence, load and auth generation. Restore and validate it before playback; respect intervening user seeks, cancellation and rejected starts. Apply the replacement-duration tolerance used by the automatic loader. End an unresponsive explicit restoration at the existing 135-second provider load deadline and preserve the target for another user-initiated attempt.

Client and server sanitizers retain only the seven defined source-recovery outcomes when reason is server_source_recovery, plus the already bounded resumeAtSec. Unknown values, source URLs and unrelated reasons remain excluded. Legacy events without outcome remain valid. No database migration is required.

verify: backend/frontend production builds and frontend typecheck passed; 35 frontend unit, 23 backend and 202 component tests passed; 9 guard/media-clock helper tests and all 9 isolated browser journeys passed with zero skips or retries. Full frontend lint passed with 0 errors and 105 existing warnings; changed runtime hooks have none. Ordinary and separate adversarial review: CLEAN.

Browser decoding and the advancing clock are real; the transport error, account and API replies are synthetic. This verifies recovery control flow, not physical Android background behavior or provider uptime. The initial Android interruption near 5 seconds remains under investigation. Autopause rollback remains intact. Production and network routing were unchanged; Git push was not performed.

Evidence: C:/Users/Dartum/Documents/ChatGPT/soundspan/output/recovery-diagnostics-20261007/. The browser runner emitted one teardown POST to the deliberately closed loopback backend port; no production service or real account was used.
