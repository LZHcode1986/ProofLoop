# Commit Boundary Dispatch Contract

Dispatch a Git boundary to Committer. The boundary type determines the commit scope and behavior.

## When to use

Any authoritative document change requires a Git boundary. The Committer creates the commit; Brain does not commit directly.

## Required Core Packet fields

- Route
- Objective / Brain Intent
- Continuation
- Allowed Scope
- Forbidden Scope / Out of Scope
- Acceptance Criteria
- Verification Method
- Expected Evidence
- Authoritative Inputs
- Constraints
- Stop Conditions
- Expected Result

## Required boundary fields

- Boundary Type — one of the values below
- Description
- Changed Files

## Boundary Type enumeration

| Boundary Type | When | Commit scope |
|---|---|---|
| `baseline-authority` | Seed or reset authority documents | `CONTEXT.md`, `PRD.md`, `tech-spec/*` |
| `stage-plan` | Planner stage plan approved | `delivery/stages/<stage>/*` — plan-only |
| `slice-output` | Worker slice complete | `delivery/stages/<stage>/<slice>/*` |
| `authority-update` | Brain updates authority after research/prototype | `tech-spec/*`, `CONTEXT.md`, `PRD.md`, `progress.md` |
| `prototype-checkpoint` | Prototype validation in isolated worktree | worktree-local — no production boundary |
| `stage-close` | Stage Review accepted by Brain | `delivery/stages/<stage>/*` — close boundary |
| `direct-fix` | General direct fix complete | bounded scope per task |

## Packet shape

```text
Route: committer
Objective: <commit objective>
Continuation: <task_id | none>
Boundary Type: <type from enumeration>
Description: <what changed>
Changed Files: <list>
Allowed Scope: <per boundary type>
Forbidden Scope: <delivery/ (unless stage-plan/slice-output/stage-close), .opencode/, .agents/>
Acceptance Criteria: <commit created>
Verification Method: <git log>
Expected Evidence: <commit hash>
Authoritative Inputs: <none>
Constraints: <per boundary type>
Stop Conditions: <dirty worktree, scope violation>
Expected Result: <Boundary closed | Boundary blocked>
```