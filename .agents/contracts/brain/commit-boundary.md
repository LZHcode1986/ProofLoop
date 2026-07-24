# Commit Boundary Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

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

## Target-specific required fields

- Boundary Type
- Description
- Changed Files

## Expected results

Boundary closed with commit hash, or Boundary blocked.

## Stop routing

- SCOPE_VIOLATION → Brain re-evaluates boundary scope
- DIRTY_WORKTREE → Brain requests clean worktree before re-dispatch
- COMMIT_FAILURE → Brain investigates and retries

## Packet

```text
Route: committer
Objective: <commit objective>
Continuation: <task_id | none>
Boundary Type: <type from enumeration>
Description: <what changed>
Changed Files: <list>
Allowed Scope: <per boundary type>
Forbidden Scope: <delivery/ (unless stage-plan/stage-close), .opencode/, .agents/>
Acceptance Criteria: <commit created>
Verification Method: <git log>
Expected Evidence: <commit hash>
Authoritative Inputs: <none>
Constraints: <per boundary type>
Stop Conditions: <dirty worktree, scope violation>
Expected Result: <Boundary closed | Boundary blocked>
```
