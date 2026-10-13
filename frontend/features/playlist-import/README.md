# Playlist Import

The import screen at `frontend/app/import/page.tsx` supports provider playlist addresses and M3U files. URL imports use the existing background-job flow; M3U imports preview resolved recordings before creating a playlist. `frontend/app/import/spotify/page.tsx` reuses the same screen.

`importPresentation.tsx` contains supported-address validation, preview rows and source badges, and the API-bound import execution helper. Keep these helpers outside the Next route entrypoint, which exports its page component. All network operations go through `frontend/lib/api.ts`.

Behavioral coverage lives in `frontend/tests/component/importPage.component.test.ts`; it checks accepted addresses, preview and execution behavior. Real provider access and imported account data require separate integration acceptance.
