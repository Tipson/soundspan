# PR 4 CI repairs

Goal: fix actual failing checks without weakening the CI gates or pushing changes.

- [x] Inspect Actions logs and SARIF findings.
- [x] Reproduce OIDC component failures with the CI Node 24.20 runtime; older local Node 24.14 passes.
- [x] Give the OIDC DOM harness a real origin and rerun the same tests.
- [x] Upgrade Next.js, sharp and anyio to advisory-fixed patch versions with generated locks.
- [x] Suppress only exact historical fingerprints proven to be a synthetic test fixture and documentation prose; retain secret detection elsewhere.
- [x] Format the two files reported by CI.
- [x] Run security scans, tests, typechecks, builds, ordinary and adversarial review; commit locally.

CodeQL finished after the initial inspection: also fix the reproduced image DNS-guard TTL bypass and triage exact non-security uses of hashing, array membership and scene UUIDs. Do not dismiss the image SSRF alerts before the patched code is pushed and verified on the PR.

No production rollout, history rewriting or git push is included. Confirmed false-positive CodeQL findings may be individually dismissed with evidence; scanning remains enabled.
