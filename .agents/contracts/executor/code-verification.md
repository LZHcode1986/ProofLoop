# Executor Code Verification Dispatch Contract

Use when Executor dispatches one explicit slice verifier gate to Code Verifier.

This contract has two modes:
- initial
- recheck

It does not define an Evidence Review phase.

Also read:
- .agents/contracts/executor/shared-code-verification-rules.md

Packet title:

Executor Dispatch: Code Verification

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
- Required Review Skills
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

Rules:
- Verify only the assigned slice or verifier gate.
- Attempt to refute implementation against the Slice Contract and acceptance criteria.
- Inspect actual diffs for every covered Worker boundary.
- Treat missing required verification context as Verification blocked or Verification failed according to the dispatch packet.
- Do not perform a separate Evidence Review phase.
- Do not implement fixes.
- Do not commit.
- On Verification passed, update only the assigned x.V verifier gate checkbox in tasks.md.
- On Verification failed, do not update x.V.
- On recheck, verify only previous failed criteria, repair diff, and necessary regression scope.
- Do not restart full verification unless the repair changed the slice boundary, acceptance criteria mapping, allowed scope, or invalidated the original verification context.

Packet shape:

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
Required Review Skills:
Verification Required:
Checkbox Owner:
- Code Verifier owns only the assigned x.V verifier gate checkbox.
- On Verification passed, update only that checkbox.
- Include checkbox confirmation in the receipt.

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
