# Executor Code Verification Dispatch Contract

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
- Attempt to refute Worker evidence, Worker claims, boundary receipts, actual diffs, and implementation against the Slice Contract and acceptance criteria.
- Use only the supplied gate fields, task packets, boundary receipts, changed files, diffs, and verification commands.
- Inspect assigned Worker Evidence Ledger sections, boundary receipts, actual diffs, changed files, and verification commands for every covered Worker attempt.
- Treat missing required verification context as `Verification blocked` or `Verification failed` according to the dispatch packet.
- Do not perform a separate Evidence Review phase.
- Do not implement fixes.
- Do not commit.
- Do not update normal implementation task checkboxes.
- On `Verification passed`, update only the assigned x.V verifier gate checkbox in `tasks.md`.
- On `Verification failed`, leave the assigned x.V verifier gate checkbox unchecked.
- On `Verification blocked`, leave the assigned x.V verifier gate checkbox unchecked.

## Proof Profile Refutation

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
- x.V checkbox confirmation
- inspected boundary receipts
- inspected diffs
- inspected worker evidence sections
- inspected Proof Profile declarations
- profile-specific refutations attempted, or None
- verification commands or inspection method
- residual risk, if any

On failure, include:
- Severity
- Failed criteria
- Evidence
- contradicted worker evidence, if any
- invalid proof profile, missing profile evidence, or failed profile refutation, if any
- Minimal repair instruction

On blocked, include:
- missing context
- runtime blocker details
- smallest additional context required
