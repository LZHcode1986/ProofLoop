# Executor Worker Fix Dispatch Contract

Use when Executor dispatches a bounded repair or diagnose loop to Worker after verifier failure.

Also read:
- .agents/contracts/executor/shared-worker-rules.md

Packet title:

Executor Dispatch: Worker Fix

Required fields:
- Change
- Failed Slice / Gate
- Covered Tasks
- Fix Mode
- Work Request
- Verifier Failure
- Original Task Constraints
- Context Files
- Checkbox Owner
- Required Skills
- Skill Instructions
- Rules

Fix mode rules:
- repair fixes only the listed verifier failure.
- diagnose finds root cause and implements the minimal fix.
- diagnose requires diagnose in Required Skills.
- Preserve original acceptance criteria and allowed file scope.
- Do not introduce unrelated refactors or behavior.

Packet shape:

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
- Worker owns the original implementation task checkbox state and must not modify other task or verifier gate checkboxes.
- Code Verifier owns the assigned verifier gate checkbox and updates it only on Verification passed.

Required Skills:
- <explicit skill name>
- <explicit skill name>

Skill Instructions:
- Use Shared Worker Dispatch Rules.

Rules:
- Apply Shared Worker Dispatch Rules.
- Fix only the listed verifier failure.
- Preserve original acceptance criteria and allowed file scope.
- Do not introduce unrelated refactors or new behavior.
- If diagnose is listed, use it to reproduce, minimize, hypothesize, instrument, fix, and regression-test.
