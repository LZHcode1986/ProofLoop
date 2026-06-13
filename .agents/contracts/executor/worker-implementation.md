# Executor Worker Implementation Dispatch Contract

Use when Executor dispatches one implementation-ready task to Worker.

Also read:
- .agents/contracts/executor/shared-worker-rules.md

Packet title:

Executor Dispatch: Worker Implementation

Required fields:
- Change
- Task ID
- Task Name
- Task Classification
- Work Request
- Task Text
- Task Acceptance Criteria
- Slice Goal
- Slice Acceptance Criteria
- Workflow Constraints
- Execution Type
- Required Skills
- Skill Instructions
- Context Files
- Allowed File Scope
- Boundary Receipt Required
- Verification Commands
- Checkbox Owner
- Rules

Worker-specific rules:
- Work only on this task.
- Do not broaden scope to satisfy future slice or stage concerns.
- Update only the assigned implementation task checkbox after implementation and required checks pass.
- Code Verifier owns only verifier gate checkboxes.

Packet shape:

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
- Use Shared Worker Dispatch Rules.

Context Files:

Allowed File Scope:

Boundary Receipt Required:
- commit receipt
- no-op receipt
- failed receipt

Verification Commands:

Checkbox Owner:
- Worker owns the assigned implementation task checkbox.
- Worker updates only the assigned checkbox after implementation and required local checks pass.
- Code Verifier does not update normal implementation task checkboxes.
- Code Verifier owns only its assigned verifier gate checkbox and updates it only on Verification passed.
- If Code Verifier fails, normal implementation task checkboxes stay as Worker self-check evidence; the slice verifier gate remains unchecked until pass.

Rules:
- Apply Shared Worker Dispatch Rules.
- Work only on this task.
- Do not broaden scope to satisfy future slice or stage concerns.
