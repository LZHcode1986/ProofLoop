# Executor Worker Implementation Dispatch Contract

Use when Executor dispatches one implementation-ready task to Worker.

## Dispatch Envelope Mode

This contract is read by `@worker` only when Executor supplies this path as the `Contract Ref` in a Dispatch Envelope.

Executor does not expand this contract into a completed packet.

Worker resolves required execution context from:
- the Dispatch Envelope;
- `Task Source`;
- OpenSpec apply `contextFiles`;
- Slice Contract in `tasks.md`;
- Evidence Ledger path;
- receipt refs, when supplied.

If required context cannot be resolved, Worker returns `Implementation blocked: insufficient task context`.

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
- Evidence Ledger Target
- Boundary Receipt Required
- Verification Commands
- Checkbox Owner
- Rules

Worker-specific rules:
- Work only on this task.
- Do not broaden scope to satisfy future slice or stage concerns.
- Update only the assigned Evidence Ledger Target before marking the task complete.
- When updating the assigned Evidence Ledger section, include `Proof Profile: <profile-name | None>` and `Profile Evidence`.
- Select the proof profile from `.agents/contracts/proof-profiles.md` based on the actual assigned task and produced evidence.
- Do not broaden implementation scope merely to satisfy a proof profile.
- Do not write final slice/stage verdicts.
- Return evidence ledger section updated in the Worker receipt.
- Update the assigned implementation task checkbox only after assigned work, required checks, evidence ledger update, and receipt are complete.
- Code Verifier owns only verifier gate checkboxes.

Resolved Execution Context:

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

Evidence Ledger Target:
- path: proofloop/evidence-ledger.md
- section: ## 3. Worker Hypothesis Verification Sections > Task <task-id>
- expected evidence:
  - Proof Profile: <profile-name | None>
  - Profile Evidence:
    - <evidence item>

Boundary Receipt Required:
- commit receipt
- no-op receipt
- failed receipt

Verification Commands:

Checkbox Owner:
- Worker owns the assigned implementation task checkbox.
- Worker updates only the assigned checkbox after implementation, required local checks, evidence ledger update, and receipt are complete.
- Code Verifier does not update normal implementation task checkboxes.
- Code Verifier owns only its assigned verifier gate checkbox and updates it only on Verification passed.
- If Code Verifier fails, normal implementation task checkboxes stay as Worker self-check evidence; the slice verifier gate remains unchecked until pass.

Rules:
- Work only on this task.
- Do not commit.
- Do not invoke subagents.
- Do not broaden scope.
- If required context is missing, return Implementation blocked: insufficient task context.
- Required Skills must be a final explicit list in the dispatch envelope (do not send inherited skill formulas). If none, write None.
- Skill instructions require loading every listed skill before implementation and reporting evidence of its use.
- Context files must include only the minimum files or excerpts needed; do not include broad repository background.
- Allowed file scope must be explicit and narrow enough to prevent unrelated work.
- Do not broaden scope to satisfy future slice or stage concerns.
- Update only the assigned Evidence Ledger Target before marking the task complete.
- When updating the assigned Evidence Ledger section, include `Proof Profile: <profile-name | None>` and `Profile Evidence`.
- Select the proof profile from `.agents/contracts/proof-profiles.md` based on the actual assigned task and produced evidence.
- Do not broaden implementation scope merely to satisfy a proof profile.
- Do not write final slice/stage verdicts.
- Return evidence ledger section updated in the Worker receipt.
- Update the assigned implementation task checkbox only after assigned work, required checks, evidence ledger update, and receipt are complete.
