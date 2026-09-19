# Testing access release

## Scope

Public `/welcome` listening room, persistent application queue, administrator approval using existing single-use invitations, first registration navigation, and returning-session login. Only backend, backend-worker and frontend images change. Existing sidecars, playback history and music libraries remain outside the mutation scope.

## Verification

- verify: backend TypeScript build completed successfully.
- verify: frontend webpack production build completed successfully; separate full-project TypeScript check completed after correcting a test mock signature.
- verify: frontend full component suite passed 1,279 tests; unit suite passed 1,619 tests. Focused application component tests passed again after moving the query key into the shared factory.
- verify: Linux backend coverage passed 8,555 tests / 602 suites, with 7 tests and 2 suites already skipped. Lines: 94.55%, branches: 83.52%. The initial staging archive omitted fixture files; the completed fixture archive passed the full rerun.
- verify: fresh isolated PostgreSQL migrations passed. Real HTTP requests passed concurrent submission, concurrent approval, first registration, current-user authentication, username/email repeat login, token refresh, single-use rejection and non-admin authorization boundaries.
- verify: OpenAPI route synchronization passed 4 tests; route documentation index passed.
- verify: desktop and 390px browser layouts rendered the form and existing-access link. Static landing assets are same-origin and the private preview organizer is excluded.

The existing route-error ratchet reports `recordingLanguageRuntime.ts`, which is unchanged from HEAD and outside this release. Changed-source ESLint passes with one intentional navigation warning: registration reloads the document to recreate the authentication provider after replacing its session. No unrelated recommendation code or baseline was changed.

## Adversarial review

Verdict before deployment: CLEAN for the changed access flow.

- Public submission exposes no invitation or approval state and acknowledges only committed persistence.
- Administrator routes enforce actual authentication and role guards; ordinary users cannot list or approve applications.
- Real database concurrency produced one application and one invitation; repeated approval preserved the link. Existing registration claim rejected reuse.
- Approval creates ordinary user access through the established registration route. No administrator role can be submitted through the landing form.
- Migration is additive. Image rollback retains the application table and submitted data; no database restore is used as routine rollback.
- User-entered contact and account names are rendered as text. Invitation URLs are built from the server-controlled same-origin registration path.

## Production verification

- verify: deployed all three candidates as `local/soundspan-{backend,backend-worker,frontend}:access-20260911`; frontend build `V6tKT0ZmMMNn7pr1fCsDc`. All three containers reported healthy. Fourteen neighboring containers retained their IDs during rollout (including temporary QA containers).
- verify: public HTTPS `/welcome`, `/login`, `/register`, `/api/health` returned 200; anonymous application listing returned 401 and the unpublished organizer returned 404.
- verify: a synthetic browser submission appeared in the owner's authenticated administrator account; approval produced a copyable link, registration opened the platform, logout/password login succeeded, reload preserved the session, and the landing's login link reused it. The administrator then saw **Доступ активирован**.
- verify: the owner's existing `dartum` session also followed landing → login → home without another password prompt.
- verify: public same-origin audio reached the playing state and was paused after the check.
- verify: the exact synthetic application, consumed invitation and ordinary test account were removed in a guarded transaction after verification. No message was sent to Telegram.

Backup: `/srv/music/soundspan-releases/access-20260911/backup/soundspan.dump`, 24,583,710 bytes; SHA-256 `b5582a1412d49091631870c39d0e6348f9b60193721bfbd5e79a527f9179b170`. `pg_restore --list` validated the archive. `compose-before.json` in the same directory preserves the prior image references. The additive application table is retained on image rollback.
