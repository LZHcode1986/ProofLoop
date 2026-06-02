# Executor Subagent Dispatch Packets

This file defines fixed packet shapes that `@executor` uses when dispatching `@worker`, `@code-verifier`, and `@committer`.

`@executor` owns the decision to dispatch. This file owns the packet format.

## Rules

- Use the exact packet title for the target flow.
- Fill every field that is known.
- Write `None` only when the field is genuinely not applicable.
- Keep packets bounded. Put detailed background in referenced files, not in the packet body.
- Preserve task, slice, and verifier gate text from `tasks.md` verbatim.

## Evidence Protocol

- Dedicated evidence documents/files are not required by default.
- The canonical execution evidence channels are:
  - Worker `Required skills evidence:` and `TDD evidence:` response fields
  - verification command outputs
  - git boundary receipts
  - diff inspection results
- If persistent evidence artifacts are produced in addition to the canonical channels, store them under `output/changes/<change-name>/`.

## Git Boundary

Use when `@executor` closes a run checkpoint or Worker output boundary through `@committer`.

```text
Executor Dispatch: Git Boundary

Boundary Type: run-checkpoint | worker-output
Boundary Mode: final | slice | per-task | no-op
Expected Receipt Type: commit | no-op | diff-snapshot
Change:
Task ID: <none for run-checkpoint>
Attempt: initial | repair-1 | repair-2 | diagnose | none
Reason:
- run-checkpoint: preserve pre-existing dirty worktree before apply execution.
- worker-output: close the completed Worker attempt before any next Worker or verifier.
Allowed File Scope:
Expected Changed Paths:
Forbidden Paths:
Boundary Receipt Required:
- commit hash (or `none` for diff-snapshot/no-op), diff-snapshot receipt, or no-op receipt
- branch
- pre-commit HEAD
- parent hash
- files staged
- files outside allowed scope
- scope check
- diff evidence availability

Expected Action:
- Inspect git status.
- If Expected Receipt Type is commit, stage only changes relevant to this boundary and commit.
- If Expected Receipt Type is diff-snapshot, do not stage or commit; only inspect status and diff to record a snapshot receipt.
- Return the required first line and the boundary receipt (commit, diff-snapshot, no-op, or failure).
```

## Shared Worker Packet Components

Apply these conventions to every packet dispatched to `@worker`:

- `Required Skills:` must be the final explicit skill list for this dispatch. Do not send formulas such as "original skills plus diagnose".
- `Context Files:` must include only the minimum files or excerpts needed for the current task or fix.
- `Allowed File Scope:` and `Verification Commands:` must be explicit for the current dispatch.

### Shared Skill Instructions

Use this block in Worker packets unless the current dispatch needs a stricter skill-specific addition:

- Load every listed skill before implementation or fixing.
- Report evidence that each required skill was used for Executor decision-making.
- Evidence is not user-facing by default; Executor will not relay full evidence unless blocked, failed, or explicitly asked.
- If `diagnose` is listed, load `diagnose` and follow its disciplined diagnosis loop.
- If `Required Skills` is `None`, do not load build skills unnecessarily.

### Shared Checkbox Ownership Blocks

Use one of these blocks verbatim:

Implementation task ownership:

- Worker owns the assigned implementation task checkbox.
- Worker updates only the assigned checkbox after implementation and required local checks pass.
- Code Verifier does not update normal implementation task checkboxes.
- Code Verifier owns only its assigned verifier gate checkbox and updates it only on `Verification passed`.
- If Code Verifier fails, normal implementation task checkboxes stay as Worker self-check evidence; the slice verifier gate remains unchecked until PASS.

Fix dispatch ownership:

- Worker owns the original implementation task checkbox state and must not modify other task or verifier gate checkboxes.
- Code Verifier owns the assigned verifier gate checkbox and updates it only on `Verification passed`.

### Shared Worker Rules

Apply these rules to every Worker packet:

- Do not commit.
- Do not invoke subagents.
- Do not broaden scope.
- If required context is missing, return `Implementation blocked: insufficient task context` with the missing files and reason.

Add these rules when the dispatch is `Worker Implementation`:

- Work only on this task.
- Do not broaden scope to satisfy future slice or stage concerns.

Add these rules when the dispatch is `Worker Fix`:

- Fix only the listed verifier failure.
- Preserve original acceptance criteria and allowed file scope.
- Do not introduce unrelated refactors or new behavior.
- If `diagnose` is listed, use it to reproduce, minimize, hypothesize, instrument, fix, and regression-test.

## Shared Code Verification Components

Apply these conventions to every packet dispatched to `@code-verifier`:

- `Task Required Skills:` must reflect the explicit `Required Skills` declared for each covered task in `tasks.md`.
- `Boundary Receipts:` and `Boundary Diff Requirements:` must cover every Worker attempt included in `Covered Tasks`.
- `Original Task Packets:` and `Worker Summaries:` must be limited to the current assigned slice or reconciliation gate.

### Shared Review Skills Default

Use this block unless the current gate explicitly requires a narrower review posture:

- code-review-and-quality
- security-and-hardening, if user input/auth/storage/external integration is touched

### Shared Verification Requirements

Use this block in Code Verification packets:

- Verify the assigned slice / verifier gate according to `code-verifier.md`.
- Use only the supplied gate fields and covered Worker evidence.
- Inspect the boundary receipts and actual diffs for every covered Worker attempt.
- Follow the repository `Evidence Protocol`; do not require dedicated evidence documents/files unless the task packet explicitly names a persistent artifact.
- Do not implement fixes.
- Do not commit.
- Do not update normal implementation task checkboxes.
- On pass, update only the assigned verifier gate checkbox.

### Shared Verification Return Contract

Code Verification packets must require:

- Return exactly:
  - `Verification passed`
  - `Verification failed`
  - `Verification blocked`
- Category must be one of:
  - `PASS`
  - `IMPLEMENTATION DEFECT`
  - `EVIDENCE DEFECT`
  - `PROTOCOL DEFECT`
  - `PLANNING DEFECT`
- Severity:
  - `Critical | Normal | Warning`
- If failed or blocked, include:
  - `Failed criteria`
  - `Evidence`
  - `Minimal repair instruction`
- Rules:
  - Missing Evidence Packet => `Verification blocked`, `EVIDENCE DEFECT`
  - Executor failed to pass Worker evidence that exists => `Verification blocked`, `PROTOCOL DEFECT`
  - Code does not satisfy slice AC => `Verification failed`, `IMPLEMENTATION DEFECT`
  - tasks/proposal lacks executable contract => `Verification blocked`, `PLANNING DEFECT`

## Worker Implementation

Use when `@executor` dispatches one implementation-ready task to `@worker`.

```text
Executor Dispatch: Worker Implementation

Change:
Task ID:
Task Name:
Task Classification: Proof Task | Normal Task | Slice Gate Support | Reconciliation
Work Request: implement the assigned task

Task Text:

Task Acceptance Criteria:

Slice Goal:

Slice Acceptance Criteria:

Workflow Constraints:

Execution Type:

Required Skills:

Skill Instructions:
- Use `Shared Skill Instructions`.

Context Files:

Allowed File Scope:

Boundary Receipt Required:
 - commit receipt
 - no-op receipt
 - failed receipt

Verification Commands:

Checkbox Owner:
- Use `Implementation task ownership` from `Shared Checkbox Ownership Blocks`.

Rules:
- Apply `Shared Worker Rules` plus the `Worker Implementation` additions.
```

## Worker Fix

Use when `@executor` dispatches a bounded repair or diagnose loop to `@worker` after verifier failure.

```text
Executor Dispatch: Worker Fix

Change:
Failed Slice / Gate:
Covered Tasks:
Fix Mode: repair | diagnose
Work Request:
- repair: fix the verifier failure listed below
- diagnose: find the root cause of the verifier failure and implement the minimal fix

Verifier Failure:
- Failed criteria:
- Evidence:
- Minimal repair instruction:
- Failed attempts: <only include when Fix Mode is diagnose; otherwise None>

Original Task Constraints:
- Task Acceptance Criteria:
- Slice Acceptance Criteria:
- Workflow Constraints:
- Allowed File Scope:
- Verification Commands:

Context Files:

Checkbox Owner:
- Use `Fix dispatch ownership` from `Shared Checkbox Ownership Blocks`.

Required Skills:
- <explicit skill name>
- <explicit skill name>

Skill Instructions:
- Use `Shared Skill Instructions`.

Rules:
- Apply `Shared Worker Rules` plus the `Worker Fix` additions.
```

## Worker Evidence Backfill

Use when implementation is already complete but required evidence was missing.

```text
Executor Dispatch: Worker Evidence Backfill

Change:
Task ID:
Task Name:
Work Request: recreate or backfill the required evidence for this completed task

Required Evidence:
- RED / GREEN / REFACTOR command outputs, expected/observed results, and excerpts

Context Files:

Allowed File Scope:

Verification Commands:

Rules:
- Do not edit product code.
- Do not change completed implementation checkbox state.
- May rerun verification commands.
- Return only structured evidence.
- If evidence cannot be reconstructed, explain why.
```

## Code Verification

Use when `@executor` dispatches one explicit slice or reconciliation verifier gate to `@code-verifier`.

```text
Executor Dispatch: Code Verification

Change:
Task ID:
Task Name:
Slice / Gate:
Covered Tasks:
Slice Acceptance Criteria:
Inspection Scope:
Inspection Content:
Out of Scope:
PASS/FAIL Gate:
Boundary Receipts:
Boundary Diff Requirements:
Original Task Packets:
Worker Summaries:
Files Changed In Slice:
Task Required Skills:
- <skill name>
Required Review Skills:
- Use `Shared Review Skills Default`.

Verification Required:
- Apply `Shared Verification Requirements`.

Return Contract:
- Apply `Shared Verification Return Contract`.
```

## Executor Evidence Packet

Use when `@executor` dispatches `@code-verifier`. This packet contains all structural evidence collected from Worker executions, git boundaries, and verification commands.

```text
Executor Evidence Packet

Change:
Stage:
Slice / Gate:
Proof Posture:

Covered Tasks:
- Task ID:
  Task Text:
  Execution Type:
  Required Skills:
  Worker Status:
  Worker Summary Excerpt:
  Checkbox Updated:
  Updated Checkbox Line:

TDD Evidence:
- Task ID:
  RED Command:
  RED Expected:
  RED Observed:
  RED Output Excerpt:
  GREEN Command:
  GREEN Observed:
  GREEN Output Excerpt:
  REFACTOR Changed:
  REFACTOR Evidence:

Verification Commands:
- Command:
  Result:
  Output Excerpt:

Boundary Evidence:
- Boundary Mode:
  Receipt Type:
  Commit Hash:
  Files Changed:
  Scope Check:
  Diff Evidence:

Acceptance Evidence:
- Stage AC ID:
  Slice AC ID:
  Evidence:
```

