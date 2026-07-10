# AWM Agent Workflow — soundspan

This extends [AGENTS.md](../AGENTS.md) with the AWM-managed workflow for agents that have `awm` available. All invariants and working rules from AGENTS.md still apply.

See [awm-work-loop.md](awm-work-loop.md) for the full command reference.

## Source Of Truth

- Canonical rules: `.awm/awm-rules.yaml`
- Canonical tags: `.awm/awm-tags.yaml`
- Canonical verification: `.awm/awm-tests.yaml`
- Canonical workflow gates: `.awm/awm-workflows.yaml`
- AWM work storage is the source of truth for active and historical plan state. Use `awm work list/search --scope all` when you need archived or completed history.

## Task Loop

For non-trivial work (multi-step, multi-file, or governed changes), follow this loop. Trivial single-file fixes can skip the AWM ceremony.

1. Read `AGENTS.md` and any tool-specific companion (e.g. `CLAUDE.md`) and the human task.
2. Run `awm context --task-text "<current task>" --phase <plan|execute|review>`.
3. Read the returned hard rules and fetch only the keys needed for the current step.
4. If the task spans multiple steps, multiple files, or likely handoff, create or update AWM work with `awm work ...`.
5. For code, config, schema, or behavior changes, run `awm verify ...` before completion.
6. If `.awm/awm-workflows.yaml` requires a review task such as `review:cross-llm`, satisfy it with `awm review --run --receipt-id <receipt-id>` when the task defines a `run` block; otherwise use manual review fields or `awm work`.
7. Close the task with `awm done ...`. Changed files must stay within the active receipt scope.

## When To Use `work`

Use `awm work` when any of the following are true:

- the task has more than one material step
- more than one file or subsystem is involved
- planning, verification, or handoff matters
- durable task state should survive compaction or session reset

For executable changes, include a `verify:tests` task.

For single review-gate updates, `awm review` is the thinner wrapper around `awm work`; use `awm review --run` for runnable workflow gates and reserve manual `status` / `outcome` / `evidence` fields for non-run mode.

## Feature Plans

- For net-new feature work, create a root AWM plan with `kind=feature` before implementation.
- Root feature plans must include `objective`, `in_scope`, `out_of_scope`, `constraints`, `references`, and stage statuses for `spec_outline`, `refined_spec`, and `implementation_plan`.
- Root feature plans must include top-level `stage:spec-outline`, `stage:refined-spec`, and `stage:implementation-plan` tasks. Put concrete child tasks beneath them with `parent_task_key`.
- If a feature splits into multiple execution streams, create child plans with `kind=feature_stream` and `parent_plan_key=<root plan key>`.
- Feature and feature-stream plans must carry `verify:tests`, and implementation leaf tasks must carry explicit `acceptance_criteria`.
- `awm verify` selects `awm-feature-plan-validate` for feature-relevant work and runs `scripts/awm-feature-plan-validate.py` with the active receipt/plan context.
- See `docs/AWM_FEATURE_PLANS.md` for examples and command shapes.

## Worktrees

- Default SQLite is repo-local, so each worktree gets its own `.awm/context.db`. This is the recommended setup when multiple worktrees may diverge at the same time.
- Treat a new worktree like a fresh AWM runtime surface: run `awm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .` before relying on retrieval there, and run `awm health --project soundspan --include-details` if the worktree was created from older repo state.
- If you run AWM commands from outside the worktree root, set `AWM_PROJECT_ROOT` to the active worktree path.
- If you move AWM to shared Postgres for multi-agent coordination, do not point multiple divergent worktrees at the same shared AWM project state. Use distinct project ids or isolated backends per worktree, otherwise retrieval and sync become last-sync-wins across trees.

## AWM-Specific Working Norms

- Do not silently expand governed file scope. Refresh context first. Use `work.plan.discovered_paths` when later-discovered files must be declared for review or done.
- Keep work state current when you pause, hand off, or hit a blocker.
- Cross-LLM review: for non-trivial implementation work, satisfy the repo review gate before final completion:
  - `awm review --run --project soundspan --receipt-id <receipt-id>`
  - reviewer provider, model, reasoning, and shared `--yolo` settings live in `.awm/awm-workflows.yaml`
  - Treat the gate as a loop, and findings as TDD input rather than suggestions: fix each blocking finding (with a regression test where applicable), then re-run the gate until it passes. Multiple rounds are normal — the gate regularly catches real bugs on work that already passed tests.

## Ruleset Maintenance

When `.awm/awm-rules.yaml`, `.awm/awm-tags.yaml`, `.awm/awm-tests.yaml`, or `.awm/awm-workflows.yaml` changes:

```bash
awm sync --project soundspan --mode working_tree --insert-new-candidates --project-root .
awm health --project soundspan --include-details
```

## Skill Aliases

Tools with the AWM skill pack installed expose these shorthand commands:

| AWM CLI | Skill alias |
|---|---|
| `awm context` | `/awm-context [phase] <task>` |
| `awm work` | `/awm-work` |
| `awm verify` | `/awm-verify` |
| `awm review --run` | `/awm-review <id> {"run":true}` |
| `awm done` | `/awm-done` |

Direct CLI (`awm sync`, `awm health`, `awm history`, `awm status`) has no skill aliases — call those directly.
