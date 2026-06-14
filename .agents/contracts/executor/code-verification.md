# Executor Code Verification Dispatch Contract

Use when Executor dispatches one explicit slice verifier gate to Code Verifier.

This contract has two modes:
- initial
- recheck

It does not define an Evidence Review phase.

Packet title:

Executor Dispatch: Code Verification

## Required fields

Required fields:
- Verification Mode
- Change
- Task ID
- Task Name
- Slice / Gate
- Covered Tasks
- Slice Acceptance Criteria
- Inspection Scope
- Inspection Content
- Out of Scope
- PASS/FAIL Gate
- Boundary Receipts
- Boundary Diff Requirements
- Original Task Packets
- Files Changed In Slice
- Task Required Skills
- Verification Lens
- Verification Required
- Checkbox Owner
- Return Contract

Required for recheck mode only:
- Previous Verification Failure
- Previous Failed Criteria
- Previous Verifier Evidence
- Minimal Repair Instruction
- Worker Fix Receipt
- New Boundary Receipt
- Repair Diff Scope
- Regression Scope

## Verification rules

- Verify only the assigned slice or verifier gate.
- Attempt to refute implementation against the Slice Contract and acceptance criteria.
- Use only the supplied gate fields, task packets, boundary receipts, changed files, diffs, and verification commands.
- Inspect boundary receipts and actual diffs for every covered Worker attempt.
- Treat missing required verification context as `Verification blocked` or `Verification failed` according to the dispatch packet.
- Do not perform a separate Evidence Review phase.
- Do not implement fixes.
- Do not commit.
- Do not update normal implementation task checkboxes.
- On `Verification passed`, update only the assigned x.V verifier gate checkbox in `tasks.md`.
- On `Verification failed`, leave the assigned x.V verifier gate checkbox unchecked.
- On `Verification blocked`, leave the assigned x.V verifier gate checkbox unchecked.

## Recheck rules

- Recheck continues the same verifier gate after Worker Fix.
- Verify only:
  - previous failed criteria;
  - Worker Fix changes;
  - new task-diff-snapshot boundary;
  - repair diff;
  - necessary regression scope.
- Do not restart full slice verification unless the repair changed:
  - slice boundary;
  - acceptance criteria mapping;
  - allowed / forbidden scope;
  - verification context.

## Verification Lens

- AC counterexample
- scope violation
- command failure
- boundary receipt mismatch
- diff regression
- declared risk counterexample

## Packet shape

Executor Dispatch: Code Verification

Verification Mode: initial | recheck
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
Files Changed In Slice:
Task Required Skills:
Verification Lens:
Verification Required:

Checkbox Owner:
- Code Verifier owns only the assigned x.V verifier gate checkbox.
- On Verification passed, update only that checkbox.
- Include checkbox confirmation in the receipt.
- On Verification failed or blocked, leave the checkbox unchecked.

For recheck mode only:
Previous Verification Failure:
Previous Failed Criteria:
Previous Verifier Evidence:
Minimal Repair Instruction:
Worker Fix Receipt:
New Boundary Receipt:
Repair Diff Scope:
Regression Scope:

Return Contract:
- Verification passed
- Verification failed
- Verification blocked

On pass, include:
- x.V checkbox confirmation
- inspected boundary receipts
- inspected diffs
- verification commands or inspection method
- residual risk, if any

On failure, include:
- Severity
- Failed criteria
- Evidence
- Minimal repair instruction

On blocked, include:
- missing context
- runtime blocker details
- smallest additional context required
