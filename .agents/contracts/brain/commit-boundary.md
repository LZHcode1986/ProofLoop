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


