# Testing access

The public listening room is served at `/welcome`. Existing listeners use its **Войти** link; authenticated sessions continue into the platform. The platform home and PWA remain at `/`.

Applicants provide their Telegram username and optional device. Submission calls `POST /api/auth/test-applications`; a successful response means the application is persisted. Normalized Telegram usernames are unique, so retries do not create additional applications or change the original details. Submission is limited to ten attempts per IP per hour.

Administrators open `/admin#test-applications`. **Обновить** refreshes the queue. **Одобрить** atomically creates one single-use invitation, and repeated approval returns the same invitation. **Скопировать** copies the registration URL; the administrator sends it to the applicant in Telegram. No message is sent automatically. After account creation, the queue shows **Доступ активирован** and the account name. Returning listeners use their username or email and password.

`GET /api/auth/test-applications` returns `items` and `nextCursor`, with up to 50 entries. `POST /api/auth/test-applications/:id/approve` returns the approved entry. Both operations require administrator authorization and disable response caching. Invitation codes are returned only by the protected administrator API.

The additive migration `20260911120000_add_test_applications` creates `TestApplication`, linked to the existing `InviteCode` model. Approval uses a serializable transaction with bounded conflict retries; registration uses the existing atomic invitation claim. Rolling back application images may leave the new table intact without affecting older code or losing applications.

The static landing lives in `frontend/public/welcome`; all scripts, fonts and audio are same-origin. The local preview organizer and its journal are not published. Audio files were supplied by the project owner. Landing scripts have a separate self-only CSP; the platform retains its nonce-based policy.
