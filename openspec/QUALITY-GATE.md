# ProofLoop Quality Gate

ProofLoop quality gates verify intent preservation, mechanical executability, evidence sufficiency, git boundary integrity, and delivery acceptance.

They do not exist to enforce document prettiness.

## 1. Intent Preservation Gate

Used by Propose and Planning Contract Verifier.

Checks:

- Brain Dispatch Contract is preserved.
- Brain acceptance criteria are mapped.
- Scope and Out of Scope do not drift.
- User Goal is not rewritten.
- Stop Conditions are represented.
- Risk Profile and Required Review Skills are carried forward.

## 2. Mechanical Executability Gate

Used by Propose and Planning Contract Verifier.

Checks:

- Each slice has verifiable acceptance criteria.
- Each task has clear allowed scope.
- Each task has verification method.
- Executor and Worker do not need to guess.
- Required CodeGraph anchors are resolvable or explicitly blocked.
- Stop conditions are clear.
- Each implementation slice has a Code Verifier gate.

## 3. Evidence Sufficiency Gate

Used by Executor and Code Verifier.

A gate checks declared contract against available evidence.
Tests passing alone is not sufficient for PASS.
Gate must not invent requirements outside declared contract.
Evidence Ledger is a transport and index, not a source of new requirements.

Checks:

- Worker Completion Receipts cover assigned criteria.
- Task diff snapshot receipts exist for covered tasks.
- Evidence Packet includes command output, scope, diff, and CodeGraph evidence where applicable.
- Required skills evidence is present (skill name alone is not evidence).
- Required Review Skills were applied.
- Evidence defects are separated from implementation defects.

### R4. Evidence Sufficiency Rule

Code Verifier PASS only when all 7 conditions are satisfied:

1. Declared slice acceptance is covered.
2. Required Verification Method was executed.
3. Expected Evidence is present.
4. Required Skill Evidence is present (structured format, not just skill name).
5. Boundary receipts are present where required.
6. No unresolved contract conflict remains.
7. Scope and CodeGraph rules are satisfied.

### R5. Gate Classification Rule

```text
IMPLEMENTATION DEFECT:
- implementation contradicts declared contract.

EVIDENCE DEFECT:
- implementation may be correct, but required evidence is missing or too weak.

CONTRACT DEFECT:
- upstream contract is ambiguous, inconsistent, omitted, or unmapped.

PROTOCOL DEFECT:
- agent skipped required receipt, ledger update, skill evidence, or boundary protocol.
```

### R6. No Invention Rule

Verifier only checks:

- Brain Dispatch Contract
- Slice Contract
- tasks
- declared Verification Method
- declared Expected Evidence
- Required Skills / Required Review Skills
- Evidence Ledger entries
- boundary receipts
- CodeGraph evidence where applicable

Verifier must not introduce project-specific requirements not declared upstream.

## 4. Git Boundary Gate

Used by Executor, Code Verifier, Committer, and Implementation Reviewer.

Checks:

- Direct Task does not auto-commit unless Brain/user requested commit.
- Worker task output receives task-diff-snapshot receipt.
- Implementation output is committed after slice verification passes.
- Slice-output commit includes only verified slice work.
- Archive output is committed separately.
- Unrelated dirty worktree blocks execution unless Brain authorizes.
- Committer never decides task completion or archive readiness.

Default:

```text
task -> diff snapshot receipt
slice verifier PASS -> slice-output commit
archive output -> archive-output commit
```

## 5. Delivery Acceptance Gate

Used by Implementation Reviewer and Brain.

Checks:

- Stage delivery satisfies Brain Dispatch Contract.
- Slice results compose into the intended closed loop.
- Slice-output commits are available when expected.
- Residual risks are known and acceptable.
- Archive readiness is established.
- Remaining decisions are routed to Brain or user.

## Classification

Use:

```text
BLOCKER
WARNING
NOTE
```

Only BLOCKER stops the flow.

Formatting issues, naming improvements, optional extra tests, and non-critical prose gaps are not blockers.
