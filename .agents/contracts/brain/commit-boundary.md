# Commit Boundary Dispatch Contract

This contract is self-contained.

Dispatch a Git boundary to Committer. The boundary type determines the commit scope and behavior.

## Use when

Any authoritative document change requires a Git boundary. The Committer creates the commit; Brain does not commit directly.

## Boundary Type

| Boundary Type | When | Commit scope |
|---|---|---|
| `baseline-authority` | Seed or reset authority documents | `CONTEXT.md`, `PRD.md`, `tech-spec/*` |
| `stage-plan` | Planner stage plan approved | `delivery/stages/<stage>/*` — plan-only |
| `authority-update` | Brain updates authority after research/prototype | `tech-spec/*`, `CONTEXT.md`, `PRD.md`, `progress.md` |
| `prototype-checkpoint` | Prototype validation in isolated worktree | worktree-local — no production boundary |
| `stage-close` | Stage Review accepted by Brain | `delivery/stages/<stage>/*` — close boundary |
| `direct-fix` | General direct fix complete | bounded scope per task |

Note: `slice-output` is dispatched by Executor, not Brain, and is not part of this contract.

## Required fields

- Boundary Type
- Description
- Changed Files

## Conditional fields by boundary type

| Boundary Type | Required additions |
|---|---|
| `prototype-checkpoint` | `prototype_id`, `worktree_path`, `expected_branch`, `no_push: true`, `no_merge: true` |
| `stage-plan` | `stage_id` |
| `stage-close` | `stage_id` |
## Expected results

Boundary closed with commit hash, or blocked.

## Return codes

When blocked:

```yaml
route_code: RUNTIME_BLOCKER
subtype: COMMIT_BOUNDARY_FAILED
reason: <description>
suggested_owner: Brain
invalidation_scope: []
resume_target:
  owner: Committer
  phase: <phase>
  stage: <stage-id | none>
```


