# Executor Code Verification Dispatch Contract

Use when Executor dispatches one explicit slice or reconciliation verifier gate to Code Verifier.

Also read:
- .agents/contracts/executor/shared-code-verification-rules.md
- .agents/contracts/executor/evidence-protocol.md

Packet title:

Executor Dispatch: Code Verification

Required fields:
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
- Worker Summaries
- Files Changed In Slice
- Task Required Skills
- Required Review Skills
- Verification Required
- Return Contract

Rules:
- Verify only the assigned slice or gate.
- Inspect actual diffs for every covered Worker boundary.
- Treat missing evidence as Verification failed.
- Do not implement fixes.
- Do not commit.
- On pass, update only the assigned verifier gate checkbox.

Packet shape:

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
- Use Shared Code Verification Rules.

Verification Required:
- Apply Shared Code Verification Rules.
- Apply Evidence Protocol.

Return Contract:
- Apply Shared Code Verification Rules.
