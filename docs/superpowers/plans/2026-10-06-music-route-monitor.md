# Music route monitor implementation plan

Goal: detect repeated failures of public radio discovery or audio continuation without creating listening history.

Architecture: a standard-library Python operator command runs outside the application, with a systemd timer and persistent private state. A small Node adapter runs inside the existing API container to issue a two-minute JWT for an explicitly marked test account and deliver idempotent administrator notifications through Prisma. The public probe requests radio and two consecutive 256 KiB audio ranges. No application routes, playback behavior, database schema, routing, or external monitoring service change.

Tech Stack: Python 3.11+, Node 24, existing Prisma/config/notification modules, systemd.

Spec: the owner approved the development roadmap and asked to start implementation and preserve context in Obsidian. This deliverable covers only its first item; the rest remains queued in the canonical vault.

Global Constraints: no git push; no owner credentials in files or output; no Play/history writes; no parallel probes; bounded time and traffic; repeated failures only; existing autoplay-pause rollback remains intact. Public HTTPS only, redirects forbidden. Ordinary and adversarial review before completion. Physical phones and cold provider availability are separate acceptance gates.

Review Focus: JWT eligibility and secrecy; response/body/range validation; bounded network time; incident persistence and idempotency; no notification spam after failed delivery or restart; systemd permissions and rollback.

1. Write failing behavioral tests for public HTTP radio/audio, truncation, ignored ranges, redirects, timeout, durable failure/recovery state, and test-account auth/admin delivery.
2. Implement the Python probe, serialized state machine, and Node runtime adapter. Default cadence 15 minutes, alert after three failed runs, recover after two healthy runs. Keep notifications pending until delivered.
3. Add systemd units and operator documentation; record approved roadmap and implementation status in Obsidian.
4. Run targeted tests, syntax/format checks and backend build; review the diff, then attempt to break its security/retry behavior. Fix material findings and repeat affected checks.
5. Validate the real public path with a marked test account; record evidence and any deployment boundary. Commit the reviewed implementation, update the vault, and report the remaining roadmap.
