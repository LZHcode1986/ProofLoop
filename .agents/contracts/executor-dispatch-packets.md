# Executor Subagent Dispatch Packets

This is the canonical contract source for every dispatch made by `@executor`.

Executor must use this file when dispatching:

- `@worker`
- `@code-verifier`
- `@committer`

Brain-to-Executor packets live in:

```text
.agents/contracts/dispatch-packets.md
```

Executor-to-subagent packets live here.

## Git boundary principles

- Committer is a boundary closure agent, not a completion judge.
- Each Worker task gets a `task-diff-snapshot` receipt.
- A slice is committed only after Code Verifier passes.
- Archive output is committed separately.
- Do not commit implementation output before slice verification passes unless Brain explicitly requested audit behavior.

## Worker Implementation

```text
Executor Dispatch: Worker Implementation

Brain Dispatch Contract:
Slice Contract:
Change:
Task ID:
Task Name:
Task Text:
Task Acceptance Criteria:
Allowed File Scope:
Forbidden File Scope:
Required Skills:
Verification Method:
Expected Evidence:
CodeGraph Anchors:
Stop Conditions:
Checkbox Owner:

Evidence Ledger:
- path:
- assigned section:
- update mode: return receipt to Executor

Rules:
- Work only on this task.
- Do not broaden scope.
- Do not commit.
- Do not invoke subagents.
- Return Completion Receipt.
```

## Worker Fix

```text
Executor Dispatch: Worker Fix

Brain Dispatch Contract:
Slice Contract:
Failed Slice / Gate:
Covered Tasks:
Fix Mode: repair | diagnose
Verifier Failure:
Original Task Constraints:
Allowed File Scope:
Required Skills:
Verification Method:
Stop Conditions:

Rules:
- Fix only the listed defect.
- Preserve original contract.
- Do not broaden scope.
```

## Worker Evidence Backfill

```text
Executor Dispatch: Worker Evidence Backfill

Change:
Task ID:
Task Name:
Required Evidence:
Verification Commands:
Allowed File Scope:

Rules:
- Do not edit product code.
- Do not change task checkbox state.
- May rerun verification commands.
- Return only structured evidence.
```

## Code Verification

```text
Executor Dispatch: Code Verification

Brain Dispatch Contract:
Slice Contract:
Change:
Slice / Gate:
Covered Tasks:
PASS/FAIL Gate:
Worker Completion Receipts:
Task Diff Snapshot Receipts:
Files Changed In Slice:
Required Review Skills:
Executor Evidence Packet:

Evidence Ledger:
- path:
- assigned slice section:
- assignment mechanism: Executor 在 dispatch packet 中显式指定 slice ID 和对应的账本章节

Assigned Slice:
- slice ID:
- covered Task IDs:
- slice contract ref:
- worker completion receipt refs:

Return Contract:
- Slice verification passed
- Slice verification failed
- Slice verification blocked
```

## Executor Evidence Packet

```text
Executor Evidence Packet

Brain Dispatch Contract:
Slice Contract:
Covered Tasks:
Worker Completion Receipts:
Task Diff Snapshot Receipts:
Verification Commands:
Boundary Evidence:
CodeGraph Evidence:
Acceptance Evidence:
Residual Risks:

Evidence Ledger Path:
Contract Echo:
Skill Evidence:
Ledger Update Summary:
```

## Git Boundary

Use when Executor dispatches Committer.

```text
Executor Dispatch: Git Boundary

Boundary Type:
- run-preflight
- task-diff-snapshot
- slice-output
- stage-output
- archive-output

Boundary Policy:
- normal | audit

Expected Receipt Type:
- clean
- diff-snapshot
- commit
- blocked

Change:
Stage:
Slice:
Task ID:
Reason:
Allowed File Scope:
Expected Changed Paths:
Forbidden Paths:
Expected Commit Message:

Expected Action:
- inspect git status
- inspect name-only diff
- inspect diff stat
- inspect relevant diff when needed
- if Expected Receipt Type is commit, stage only relevant files and commit
- if Expected Receipt Type is diff-snapshot, do not stage or commit
- return boundary receipt
```

## Boundary receipt

Committer must return:

```text
Boundary closed | Boundary snapshot recorded | Boundary clean | Boundary blocked | Boundary failed

Boundary:
- Type:
- Policy:
- Change:
- Stage:
- Slice:
- Task:
- Reason:

Git State:
- Branch:
- Pre-boundary HEAD:
- Dirty before:
- Dirty after:

Scope:
- Allowed File Scope:
- Files changed:
- Files outside allowed scope:
- Scope check:

Diff Evidence:
- Name-only inspected:
- Diff stat inspected:
- Relevant diff inspected:

Commit:
- Created:
- Commit hash:
- Commit message:

Blocker:
- Reason:
- Required Brain action:
```

## Contract Echo trimming

Each subagent uses a trimmed Contract Echo in its receipt:

- **Worker**: `accepted` | `satisfied` | `not satisfied` | `conflicted`
- **Code Verifier**: `received` | `evidence present` | `evidence missing` | `conflicted`
- **Committer**: no Echo required (returns Boundary Receipt only)
