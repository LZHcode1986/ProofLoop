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
- update mode: append repair note | update evidence

Checkbox Owner:
- Worker owns the original implementation task checkbox state and must not modify other task or verifier gate checkboxes.
- Code Verifier owns the assigned verifier gate checkbox and updates it only on Verification passed.

Required Skills:
- <explicit skill name>
- <explicit skill name>

Skill Instructions:
- Use Shared Worker Dispatch Rules.

Rules:
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
- If the fix changes implementation behavior or verification result, update the assigned Evidence Ledger Target.
- If the fix changes behavior, evidence, or the applicable proof profile, update the assigned Evidence Ledger section's `Proof Profile` and `Profile Evidence`.
- Preserve previous profile evidence when still relevant; append repair evidence instead of erasing history.
- Do not create a separate evidence backfill phase.
- Preserve original task evidence and add repair evidence / updated verification notes.
- Return evidence ledger section updated in the Worker Fix receipt.
