# ProofLoop Evidence Ledger

Change:
Stage:
Ledger Path:
Last Updated:

Ledger Owners:
- planning: Propose
- planning verification: Planning Contract Verifier
- execution: Executor
- slice verification: Code Verifier
- stage review: Implementation Reviewer
- archive execution: Implementation Reviewer

---

## 1. Brain Dispatch Snapshot

Route:
Task Type:
User Goal:
Brain Intent:
Scope:
Out of Scope:

Acceptance Criteria:
- AC-1:
- AC-2:

Verification Method:
Expected Evidence:
Risk Profile:
Required Skills:
Required Review Skills:
CodeGraph Use:
CodeGraph Anchors:
Stop Conditions:
Final Acceptance Owner: Brain

---

## 2. Planning Artifacts

Proposal:
Design:
Specs:
Tasks:

AC Mapping Summary:
- AC-1 -> Slice / Task / Verification / Evidence
- AC-2 -> Slice / Task / Verification / Evidence

Declared Deferrals:
- item:
- reason:
- approved by:

Planning Conflicts:
- item:
- status:

---

## 3. Planning Contract Result

Result:
- BLOCKED | READY_WITH_WARNINGS | READY

Intent Preservation:
Acceptance Mapping:
Mechanical Executability:
Stop Conditions:
CodeGraph Anchor Check:
Git Boundary Plan:

Findings:
- BLOCKER:
- WARNING:
- NOTE:

Minimal Next Action:

---

## 4. Execution Evidence

### Slice 1: <slice-name>

Slice Contract Ref:

#### Task 1.1

Task Contract:
- AC:
- Allowed File Scope:
- Forbidden File Scope:
- Verification Method:
- Expected Evidence:
- Required Skills:
- Stop Conditions:

Worker Completion Receipt:
- status:
- files changed:
- commands run:
- verification result:

Contract Echo:
- accepted:
- satisfied:
- not satisfied:
- conflicted:

Skill Evidence:
- required skills:
- evidence:
- deviation / not applicable reason:

- acceptance evidence:
- CodeGraph evidence:
- residual risk:
- stop conditions:

Boundary Receipt:
- type: task-diff-snapshot
- status:
- files changed:
- diff stat:
- files outside scope:
- receipt ref:

#### Slice Verification

Code Verifier Result:
- passed | failed | blocked

Category:
- PASS | IMPLEMENTATION DEFECT | EVIDENCE DEFECT | CONTRACT DEFECT | PROTOCOL DEFECT

Contract Echo Check:
- received:
- evidence present:
- evidence missing:
- conflicted:

Skill Evidence Check:
- Required Skills:
- Required Review Skills:
- evidence present:
- missing:

AC Coverage:
Evidence Sufficiency:
Scope Check:
Required Review Skills:
Boundary Check:
CodeGraph Impact Check:

Findings:
- BLOCKER:
- WARNING:
- NOTE:

Minimal Next Action:

Slice Commit:
- commit hash:
- commit message:

---

## 5. Stage Review

Implementation Reviewer Result:
- passed | failed | passed with warnings

Brain Dispatch Satisfaction:
- AC-1:
- AC-2:

Slice Composition:
Residual Risks:
Archive Recommendation:
Archive Boundary Needed:

---

## 6. Archive Result

Brain Archive Authorization:
- yes/no
- authorized by:
- timestamp:

Archive Execution:
- status:
- files changed:

Archive Commit:
- commit hash:
