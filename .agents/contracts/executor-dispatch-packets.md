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
OpenSpec Artifacts:
OpenSpec source refs:
Allowed File Scope:
Forbidden File Scope:
Required Skills:
Verification Method:
Expected Evidence:
CodeGraph Anchors:
Stop Conditions:
Checkbox Owner:

Rules:
- Use OpenSpec / Slice Contract as authority.
- Do not read Evidence Ledger AC hypothesis.
- Do not use AC hypothesis as implementation authority.
- Work only on this task.
- Do not broaden scope.
- Do not commit.
- Do not invoke subagents.
- Update assigned task checkbox after local verification.
- Return Implementation Receipt.
```

## Worker Hypothesis Verification

```text
Executor Dispatch: Worker Hypothesis Verification

Completed Implementation Receipt:
OpenSpec source refs:
Slice Contract:
Assigned AC Hypotheses:
- id:
- source:
- text:
- expected evidence:

Evidence Ledger:
- path:
- assigned section:
- update mode: worker writes assigned section only

Rules:
- Do not edit implementation.
- Do not repair failures.
- Do not update task checkbox.
- Verify each hypothesis against completed implementation and OpenSpec source.
- Treat hypothesis as a claim to verify, not as authority.
- Write only assigned Evidence Ledger section.
- Return Hypothesis Verification Receipt.
```

## Worker Fix

```text
Executor Dispatch: Worker Fix

Brain Dispatch Contract:
Slice Contract:
OpenSpec Artifacts:
OpenSpec source refs:
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
- Use OpenSpec / Slice Contract as authority.
- Treat Verifier Failure as a defect report, not as implementation authority.
- Fix only the listed defect.
- Preserve original OpenSpec contract.
- Do not broaden scope.
```

## Worker Evidence Backfill

```text
Executor Dispatch: Worker Evidence Backfill

Change:
Task ID:
Task Name:
OpenSpec source refs:
Slice Contract:
Hypothesis ID:
Required Evidence:
Verification Commands:
Allowed File Scope:

Evidence Ledger:
- path:
- assigned section:
- update mode: worker writes assigned section only

Rules:
- Do not edit implementation.
- Do not repair failures.
- Do not update task checkbox.
- May rerun verification commands.
- May inspect completed implementation.
- Write only assigned Evidence Ledger section.
- Backfill only evidence for assigned task / hypothesis.
- Return Evidence Backfill Receipt.
```

## Code Verification - Blind Refutation

```text
Executor Dispatch: Code Verification - Blind Refutation

Brain Dispatch Contract:
Slice Contract:
Change:
Slice / Gate:
Covered Tasks:
OpenSpec Artifacts:
OpenSpec source refs:
Files Changed In Slice:
Required Review Skills:
Allowed File Scope:
Forbidden File Scope:
Checkbox Owner:

Rules:
- Do not inspect Worker evidence.
- Do not inspect Evidence Ledger worker sections.
- Do not inspect Worker Completion Receipts.
- Do not inspect Worker Hypothesis Verification Receipts.
- Use OpenSpec / Slice Contract as authority.
- Try to construct a real counterexample for the slice.
- Prefer runtime/API/UI paths over structural inspection.
- Do not PASS solely because tests pass.
- Every Slice AC must have a refutation attempt; if any AC is unchallenged, verdict is inconclusive.
- Return Blind Slice Refutation Receipt.
```

## Code Verification - Evidence Review

```text
Executor Dispatch: Code Verification - Evidence Review

Blind Slice Refutation Receipt:
Worker Implementation Receipts:
Worker Hypothesis Verification Receipts:
Task Diff Snapshot Receipts:
Evidence Ledger worker task/hypothesis sections for covered tasks:
Files Changed In Slice:
Required Review Skills:
Checkbox Owner: Code Verifier

Rules:
- If blind refutation is refuted, slice fails.
- If blind refutation is not-refuted, inspect Worker evidence.
- If evidence is sufficient, slice passes.
- If evidence is insufficient, slice is blocked.
- If blind refutation is inconclusive, slice is blocked.
- If slice fails or blocks, perform task-level attribution.
- Final Slice Verdict goes in Code Verifier Receipt, not in Evidence Ledger.
- Worker evidence is a claim to challenge, not a fact to trust.
- After Final Slice Verdict = pass, open tasks.md and mark the verifier gate checkbox [x].
- Return Code Verifier Receipt with Final Slice Verdict.
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
