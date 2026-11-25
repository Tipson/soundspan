# Contributing to soundspan

First off, thanks for taking the time to contribute! 🎉

## Getting Started

1. Accept collaborator access to `Tipson/soundspan`, or fork it if contributing without write access
2. Clone the repository or your fork locally, and read [shared project knowledge](docs/knowledge/README.md)
3. Set up the development environment and learn how to reproduce the CI gates locally — see **Local Setup & Pre-PR Verification** in [AGENTS.md](AGENTS.md). (There is no root install; each package builds on its own, and all Node packages require Node ≥ 24.)
4. Fetch current refs and create a separate `codex/` task branch from `dev`

## Git Hooks

The `.githooks` directory is optional, local-only, gitignored, and not tracked.
Create it manually if you want to maintain a local pre-commit hook, then enable
it with:

```bash
mkdir -p .githooks
git config core.hooksPath .githooks
```

Your local hook can run `awm verify` on staged code files before each commit.

## Branch Strategy

This fork uses `dev` for integration and `main` for accepted release source:

- Task branches use the `codex/` prefix and open PRs into **`dev`**.
- The owner reviews and integrates a release through a **`dev` → `main` PR**.
- A merge does not establish that the website or APK was updated. Deployment and physical-device acceptance need their own evidence and authorization.
- Image builds on `main` follow the changed-path selection in the image workflow; documentation changes do not require an application deployment.
- Keep relevant [project knowledge](docs/knowledge/WORKFLOW.md) current in the same PR as implementation changes.

The full Quality Visibility workflow targets PRs into `main`, not `dev`. Inspect the actual checks for each PR and follow the local checks in `AGENTS.md`; a green `dev` PR does not imply full backend coverage. The shared workflow describes collaboration, not an assertion that branch protection is enabled.

## Versioning Notes

- Current development target: **`Unreleased`**
- Use `nightly` images for testing unreleased features
- Keep docs current with behavior changes (update `README.md` and `CHANGELOG.md` in the same PR when applicable)

## Making Contributions

### Bug Fixes

1. Check existing issues to see if the bug has been reported
2. If not, open a bug report issue first
3. Fork, branch, fix, and submit a PR referencing the issue

### Small Enhancements

1. Open a feature request issue to discuss first
2. Keep changes focused and minimal

### Large Features

Please open an issue to discuss before starting work.

## Coding Standards

All contributions must follow the [coding-handbook](https://github.com/BonzTM/coding-handbook): the `typescript/` module for TS/JS and the `python/` module for the `services/**` sidecars. See **Coding Standards & Handbook** in [AGENTS.md](AGENTS.md) for the full policy and precedence — that section is the authority.

## Code Style

### Frontend

The frontend uses ESLint. Before submitting a PR:

```bash
cd frontend
npm run lint
```

### Backend

Follow existing code patterns and TypeScript conventions.

## Testing Frameworks and Structure

Canonical testing guide:

- [`docs/TESTING.md`](docs/TESTING.md)

Summary:

- Backend automated tests: Jest + ts-jest under `backend/src/**/__tests__/`
- Frontend CI-gated tests: unit tests under `frontend/tests/unit/`, component tests under `frontend/tests/component/`, and the standalone typecheck
- Frontend Playwright tests: local/on-demand E2E flows under `frontend/tests/e2e/`
- Backend manual diagnostics (not Jest): `backend/scripts/manual-tests/`
- Python sidecars: all five sidecars have `pytest` suites under `services/*/tests/`

Key backend commands:

```bash
npm --prefix backend test
npm --prefix backend run test:coverage
npm --prefix backend run test:smoke
```

Manual backend diagnostics:

```bash
npm --prefix backend run test:manual:artist-normalization
npm --prefix backend run test:manual:download-dedup
```

Key frontend commands:

```bash
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:unit
npm --prefix frontend run test:component
npm --prefix frontend run test:coverage
npm --prefix frontend run test:e2e
npm --prefix frontend run test:predeploy
```

The frontend `prebuild` evaluates `public/sw.js` and its local `importScripts`
dependencies before compiling Next.js. Run it from the release checkout or
archive, not only a working copy: an untracked public asset can pass local tests
while being absent from the image. Browser smoke verification must also confirm
successful service-worker registration; the build check does not run lifecycle
callbacks or prove device offline playback.

## Full-Stack Validation Requirements

For features or fixes involving APIs, auth, routing/proxying, or external client integrations:

1. Validate backend-direct behavior (route works when called against backend base URL).
2. Validate frontend-base-URL behavior for the same flow in split deployments.
3. Confirm docs tell users the correct URL to configure for their deployment mode.
4. For client-compatibility work, run at least one real-client handshake test or client-profile emulation that matches documented user setup.
5. If the change touches Subsonic/OpenSubsonic routing, run `cd backend && npm run test:smoke:subsonic-proxy`.

If behavior differs between AIO and split deployments, call it out explicitly in the PR description and docs.

## CI Quality Checks

The **Quality Visibility** workflow (`.github/workflows/quality-visibility.yml`) runs blocking checks alongside configurable visibility jobs:

- Blocking jobs: **Backend Tests + Coverage**, **Backend Typecheck**, **Frontend Typecheck**, **Enforcement Gates**, **Enforcement Gates Build**, and **Python Quality**.
- Visibility jobs: **Backend PostgreSQL Integration**, **Frontend Quality Visibility** (lint, build, targeted unit coverage, and component tests), **Python Sidecar Tests**, and **Helm Chart Visibility**. These jobs allow failures by default; `CI_NON_BLOCKING_TEST_VISIBILITY=false` makes them blocking.
- Required status checks in branch protection are configured separately.

### Backend coverage artifacts

Each run uploads a `backend-coverage-*` artifact containing:

- `coverage/lcov.info`
- `coverage/coverage-summary.json`
- `coverage/jest-results.json`
- generated markdown summary (`coverage/coverage-summary.md`)

The workflow summary includes:

- total statement/branch/function/line coverage
- test suite and test counts
- lowest-coverage files
- zero-percent coverage file list

### Backend coverage gate defaults

The backend coverage-summary gate is enabled by default (`CI_ENFORCE_TEST_GATE=true`). Repository variables override its thresholds:

| Repository variable | Default minimum |
| --- | --- |
| `COVERAGE_LINE_MIN` | 94% |
| `COVERAGE_BRANCH_MIN` | 83% |
| `COVERAGE_FUNCTION_MIN` | 93% |
| `COVERAGE_STATEMENT_MIN` | 93% |

`CI_ENFORCE_TEST_GATE=false` disables the summary threshold gate; backend test failures remain blocking. `CI_NON_BLOCKING_TEST_VISIBILITY` does not control the backend test job. `BACKEND_COVERAGE_MAX_WORKERS` defaults to `6`.

## AWM Repo Contract

Repository workflow and verification now run through AWM rather than the legacy agents-template toolchain.

- Repo contract: `AGENTS.md`
- AWM rules: `.awm/awm-rules.yaml`
- AWM tests: `.awm/awm-tests.yaml`
- AWM workflow gates: `.awm/awm-workflows.yaml`
- AWM feature plan schema: `docs/AWM_FEATURE_PLANS.md`

Run locally before pushing:

```bash
awm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .
awm verify --project soundspan --phase review --file-changed <path>
awm health --project soundspan --include-details
```

For backend or `packages/media-metadata-contract/` changes, `awm verify` remains receipt-scoped and targeted. The full backend `build` + `test:coverage` gate is promoted through the runnable review step below before `done`.

When the active receipt matches a repo-defined review gate, also run:

```bash
awm review --run --project soundspan --receipt-id <receipt-id>
```

For net-new feature work, use the repo-local AWM feature plan schema from `docs/AWM_FEATURE_PLANS.md`: root plans use `kind=feature`, split execution streams use `kind=feature_stream`, and `awm verify` enforces the required hierarchy and metadata through `scripts/awm-feature-plan-validate.py`.

## Pull Request Process

1. **Target `dev` for task PRs; the owner opens the integration PR into `main`**
2. Fill out the PR template completely
3. Complete the applicable local checks and inspect the CI checks that actually ran
4. Update affected shared knowledge; include `CHANGELOG.md` and `README.md` updates when behavior is user-facing
5. Wait for review - we'll provide feedback or approve

## Questions?

Use the relevant issue or PR for project questions and task coordination.

Thanks for contributing!
