# Worker Fix Dispatch Contract

Use when Executor dispatches a bounded repair or diagnose loop to Worker after verifier failure.

## Dispatch Envelope Mode

This contract is read by `@worker` only when Executor supplies this path as the `Contract Ref` in a Worker Fix Dispatch Envelope.

Executor does not expand this contract into a completed packet.

Worker resolves fix context from the Dispatch Envelope, failed verifier receipt, task source, Evidence Ledger, changed files, and receipt refs.

If required fix context cannot be resolved, Worker returns the contract-defined blocked receipt.

Packet title:

Executor Dispatch: Worker Fix

Required fields:
- Task ID
- Continuation
- Previous Worker Task ID
- Failed Gate
- Attempt
- Failed Attempts, only for diagnose
- Change
- Failed Slice / Gate
- Covered Tasks
- Fix Mode
- Work Request
- Verifier Failure
- Original Task Constraints
- Context Files
- Evidence Ledger Target
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

Resolved Execution Context:

Executor Dispatch: Worker Fix

Task ID: <original implementation task-id>
Continuation: true
Previous Worker Task ID: <same task-id>
Failed Gate: <failed verifier gate>
Attempt: repair-1 | repair-2 | diagnose
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

Evidence Ledger Target:
- path: proofloop/evidence-ledger.md
- section: ## 3. Worker Hypothesis Verification Sections > Task <task-id>
- update mode: update existing Task section and append Repair History

Checkbox Owner:
- Worker owns the original implementation task checkbox state and must not modify other task or verifier gate checkboxes.
- Code Verifier owns the assigned verifier gate checkbox and updates it only on Verification passed.

Required Skills:
- <explicit skill name>
- <explicit skill name>

Skill Instructions:
- Use Shared Worker Dispatch Rules.

Rules:
- Worker Fix is a continuation of the original implementation Task ID.
- Worker Fix must repair only the assigned Task ID.
- Worker Fix must not repair multiple Task IDs in one dispatch.
- If Fix Mode is diagnose, Required Skills must include diagnose.
- If diagnose is listed, Worker must load diagnose before implementation.
- Fix only the listed verifier failure.
- Do not commit.
- Do not invoke subagents.
- Do not broaden scope.
- If required context is missing, return the contract-defined blocked receipt.
- Required Skills must be a final explicit list in the dispatch envelope (do not send inherited skill formulas). If none, write None.
- Skill instructions require loading every listed skill before implementation and reporting evidence of its use.
- Context files must include only the minimum files or excerpts needed; do not include broad repository background.
- Allowed file scope must be explicit and narrow enough to prevent unrelated work.
- Preserve original acceptance criteria and allowed file scope.
- Do not introduce unrelated refactors or new behavior.
- If diagnose is listed, use it to reproduce, minimize, hypothesize, instrument, fix, and regression-test.
- Evidence Ledger rules:
  - Worker Fix must update the existing Task evidence section for the assigned Task ID in the Evidence Ledger.
  - Worker Fix must not create another top-level Task evidence section for the same Task ID.
  - Worker Fix must keep Worker Verification fields as the current task state.
  - Worker Fix must append a concise Repair History entry for each repair or diagnose attempt.
  - Worker Fix must preserve previous evidence when still relevant.
  - Worker Fix must not erase prior repair history.
- Do not create a separate evidence backfill phase.
- Return evidence ledger section updated in the Worker Fix receipt.
