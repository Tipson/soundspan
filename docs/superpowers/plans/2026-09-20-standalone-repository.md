# Standalone repository implementation plan

Goal: maintain Tipson/soundspan as an independent project with preserved Git history and license notices. Name and production domain remain unchanged.

- [x] Inspect GitHub fork relationship, remote tracking, original license and repository links.
- [x] Export GitHub PRs, reviews and comments; mirror remote refs and verify with git fsck.
- [x] Back up current local HEAD as a complete verified Git bundle and save Git configuration.
- [x] Detach GitHub fork relationship after confirmation of permanent metadata implications.
- [x] Stop local main tracking upstream and exclude historical upstream from bulk fetch operations. Retain the promisor remote for historical object retrieval.
- [x] Verify GitHub isFork=false, unchanged remote branch tips and unchanged local HEAD.

Boundary: no push, repository deletion, rename, history rewrite, runtime or deployment change. Existing GPL license and source attribution remain intact. Runtime branding and deployment templates are a separate migration; repository detachment does not replace their original URLs or images automatically.

Backup: `C:/Users/Dartum/Documents/ChatGPT/soundspan/output/fork-detach-20260920`. GitHub documents possible loss of issues, PRs and metadata when leaving the fork network; exported JSON is an archive, not a promise of exact restoration into GitHub.

Verified outcome: GitHub reports `isFork=false` and `parent=null`. Remote branches and tags match the pre-detachment mirror exactly; all three closed PRs remain accessible. Local application HEAD remained `ae5d8d4ea9a00bd0410c3fd6ca2c9412dc3ee91e` before recording this documentation. LICENSE is unchanged. Local main has no upstream tracking; the historical promisor remote has `skipDefaultUpdate=true` and `skipFetchAll=true`, with push disabled. No application code changed, so no application build or playback test was required for this repository-only operation.
