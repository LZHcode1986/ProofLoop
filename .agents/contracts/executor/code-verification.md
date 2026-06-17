# Code Verification Dispatch Contract

Use when Executor dispatches one explicit slice verifier gate to Code Verifier.

## Dispatch Envelope Mode

This contract is read by `@code-verifier` only when Executor supplies this path as the `Contract Ref` in a Dispatch Envelope.

Executor does not expand this contract into a completed packet.

Code Verifier resolves required verification context from:
- the Dispatch Envelope;
- `Task Source`;
- OpenSpec apply `contextFiles`;
- Slice Contract and verifier gate in `tasks.md`;
- Evidence Ledger Worker sections;
- Worker receipts;
- boundary receipts;
- changed files and diffs.

If required verification context cannot be resolved, Code Verifier returns the contract-defined blocked/failed receipt.

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
- Worker Evidence Sections
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
- Start from Slice Contract, covered tasks, changed files, diffs, boundary receipts, and declared verification method.
- Before reading Worker Evidence Ledger sections, identify and attempt likely counterexamples against the implemented slice behavior.
- Read Worker Evidence Ledger sections only after refutation planning/execution.
- Treat Worker evidence as claims to compare against refutation results, not as the starting proof.
- If any required refutation succeeds, return `Verification failed`.
- If all required refutations fail, return `Verification passed`.
- If a required refutation cannot be attempted because required context or runtime is unavailable, return `Verification blocked`.
- Use only the supplied gate fields, task packets, boundary receipts, changed files, diffs, and verification commands.
- Do not perform a separate Evidence Review phase.
- Do not implement fixes.
- Do not broaden scope.
- Do not commit.
- Do not update normal implementation task checkboxes.
- On `Verification passed`, update only the assigned x.V verifier gate checkbox in `tasks.md`.
- On `Verification failed`, leave the assigned x.V verifier gate checkbox unchecked.
- On `Verification failed`, Code Verifier must identify impacted Task ID(s) when possible.
- If attribution is uncertain, mark the task as uncertain instead of guessing.
- On `Verification blocked`, leave the assigned x.V verifier gate checkbox unchecked.

## Proof Profile Refutation

Profile-specific refutation is a second-pass refutation.

Code Verifier first performs independent refutations from Slice Contract, covered tasks, changed files, diffs, boundary receipts, and declared verification method before reading Worker Evidence Ledger sections.

After Worker Evidence Ledger sections are read, Code Verifier uses the Worker Proof Profile declaration to add the matching profile-specific refutation.

Profile-specific refutation does not override the adversarial-first rule and does not make Worker evidence the starting proof.

If a Worker Evidence Ledger section declares:

```text
Proof Profile: <profile-name>
```

Code Verifier must read `.agents/contracts/proof-profiles.md` and apply the matching `Verifier refutation` template.

If the section declares:

```text
Proof Profile: None
```

Code Verifier uses the normal Verification Lens.

If the declared profile does not exist, or required `Profile Evidence` is missing, Code Verifier returns `Verification failed`.

Proof Profile is execution evidence, not a `tasks.md` field.

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

## Resolved Execution Context

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
Worker Evidence Sections:
- task:
- section:
- expected evidence:
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
- x.V checkbox confirmation;
- attacked Worker claims or slice behaviors;
- refutations attempted;
- refutation result for each attempt: failed-to-refute;
- proof-profile refutations attempted, or None;
- why the failed refutations do not invalidate the slice;
- commands or inspections used as supporting evidence;
- residual risk, if any.

On failure, include:
- successful refutation;
- concrete counterexample;
- contradicted Worker claim or evidence, if any;
- failed Slice Contract / AC;
- minimal repair instruction;
- Impacted Tasks:
  - <task-id>: primary | secondary | uncertain
- Failure Signature:
  - <stable short signature for repeated-failure detection>
- Recommended Recheck Scope:
  - previous failed criteria
  - repair diff
  - necessary regression scope

On blocked, include:
- required refutation that could not be attempted;
- missing context or runtime blocker;
- smallest additional context required.

### Receipt Structure Template

Code Verifier should structure the return receipt as follows:

```text
Verification passed | Verification failed | Verification blocked

Refutation Summary:
- Overall: all required refutations failed | one or more refutations succeeded | required refutation blocked

Refutation Attempts:
- Target:
  - Source: Slice Contract / AC / changed behavior / diff / Proof Profile
  - Attempt:
  - Result: succeeded | failed-to-refute | blocked
  - Evidence:

Worker Evidence Comparison:
- Read after refutation attempts: yes
- Worker evidence contradicted by refutation: yes/no
- Worker evidence omitted attacked case: yes/no
- Missing critical evidence:
- Consequence: failed | blocked | none

Verdict Basis:
- If passed: why no attempted refutation invalidated the slice
- If failed: concrete counterexample and contradicted claim
- If blocked: smallest missing context needed

Impacted Tasks: (only for failure)
- <task-id>: primary | secondary | uncertain

Failure Signature: (only for failure)
- <stable short signature for repeated-failure detection>

Recommended Recheck Scope: (only for failure)
- previous failed criteria
- repair diff
- necessary regression scope
```