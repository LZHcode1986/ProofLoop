# ProofLoop Evidence Ledger

Change:
Stage:
Ledger Path:
Last Updated:

Ledger Owners:
- planning seed: Propose
- worker proof sections: Worker
- execution summary: Reconciliation task writes Section 5
- verifier receipts: indexed in Execution Summary; authoritative in Code Verifier Receipt
- committer receipts: indexed in Execution Summary; authoritative in Committer Receipt
- stage review: outside ledger (Implementation Reviewer Output)
- archive result: outside ledger (Implementation Reviewer Output + Committer archive-output receipt)

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
Code Reality Check:
Git Boundary Plan:

Findings:
- BLOCKER:
- WARNING:
- NOTE:

Minimal Next Action:

---

## 4. Worker Hypothesis Verification Sections

<!-- Worker writes only assigned sections. Each section corresponds to one task/hypothesis. -->
<!-- Do NOT write final verdicts (PASS/FAIL/blocked/confirmed) in this ledger. -->
<!-- Final slice verdict lives in Code Verifier Receipt. -->
<!-- Code Verifier Receipt remains authoritative for slice verdicts. -->
<!-- Committer Receipt remains authoritative for git boundary results. -->
<!-- Section 5 indexes execution receipts so Brain and Implementation Reviewer do not depend on chat context transfer. -->

### Task <task-id> / Hypothesis <hypothesis-id>

Source:
- OpenSpec:
- Slice Contract:
- Task:

Hypothesis:
<text>

Worker Verification:
- status: supported | refuted | unproven | contract-mismatch
- implementation files:
- tests/assertions:
- commands:
- runtime/manual check:
- fixture/source:
- residual risk:

Worker Category:
- none
- implementation-defect
- contract-defect
- evidence-defect
- protocol-defect

Worker Notes:
<notes>

---

## 5. Execution Summary

<!-- Reconciliation task writes this section after all slice-output commits are complete. -->
<!-- This section indexes execution evidence. It does not reinterpret specialist verdicts. -->

Result:
- Execution complete | Execution blocked | Verification failed

Change:
Stage:

Worker Receipts:
- task:
- receipt ref:
- checkbox:

Git Boundary Receipts:
- boundary:
- receipt ref:
- commit hash or no-op:

Code Verification Receipts:
- slice:
- verification mode:
- receipt ref:
- verdict:
- x.V checkbox:

Slice Routing:
- slice:
- verdict:
- next action:

Slice Commits:
- slice:
- commit hash:

Residual Risks:

Next Action:
- return to Brain
- Worker Fix required
- blocked

---

<!-- The following sections are NOT part of this ledger.
     They live in separate receipts/outputs:

     Slice Verdict:    Code Verifier Receipt
     Stage Verdict:    Implementation Reviewer Output
     Archive Result:   Implementation Reviewer Output + Committer archive-output receipt
     Slice Commit:     Committer boundary receipt
-->
