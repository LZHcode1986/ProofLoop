# Tasks

## Brain Acceptance Coverage Map

| Brain AC ID | Criterion Summary | Covered By | Proof Source |
| --- | --- | --- | --- |
| AC-1 |  | Slice 1 verifier | Evidence Packet + command |

## Global Stop Conditions

- Acceptance criterion not testable.
- Required change exceeds allowed scope.
- Required code reality impact exceeds allowed scope.
- Required OpenSpec spec change discovered during execution.
- Security/data/migration risk outside contract.

## Git Boundary Plan

Default:

```text
After each Worker task:
  task-diff-snapshot receipt

After each slice verifier PASS:
  slice-output commit

After archive execution:
  archive-output commit if archive changed files
```

Do not create implementation commits before slice verification passes unless Brain explicitly requests audit boundary behavior.

## Dependencies

<!-- List dependencies between tasks or slices. -->

## Parallel Opportunities

<!-- List tasks or task groups that can be done in parallel. `[P]` means parallel candidate, not mandatory parallel execution. -->

## Task Order

### 1. Setup

- [ ] 1.1 <task>
  - **Allowed File Scope:** <paths>
  - **Verification Method:** <command/inspection>
  - **Expected Evidence:** <evidence>
  - **Boundary Receipt:** task-diff-snapshot

### 2. Blocking

- [ ] 2.1 <blocking/proof task or explicitly documented none>
  - **Execution Type:** proof
  - **Allowed File Scope:** <paths>
  - **Verification Method:** <command>
  - **Expected Evidence:** baseline proof before implementation
  - **Boundary Receipt:** task-diff-snapshot

<!-- For interactive changes, the first Blocking task MUST be Proof Task. -->

### 3. Slice 1: <slice-name>

#### Slice Contract

- **Source Spec Requirements:**
  - REQ-...
- **Binding Behavior Summary:**
  - 
- **Slice Goal:** 
- **Acceptance Criteria:**
  - AC-S1-1:
- **Default Allowed File Scope:**
  - 
- **Forbidden File Scope:**
  - 
- **Verification Method:**
  - 
- **Expected Evidence:**
  - 
- **Required Skills:**
  - test-driven-development | None
- **Stop Conditions:**
  - 
- **Task Boundary Receipt:** task-diff-snapshot
- **Slice Commit Boundary:** slice-output after verifier PASS
- **Verifier Gate:** 3.V

#### Tasks

- [ ] 3.1 [Slice-1] <task>
  - **Uses Slice Contract:** yes
  - **Overrides:** none
  - **Boundary Receipt:** task-diff-snapshot

- [ ] 3.2 [P] [Slice-1] <parallel-candidate-task>
  - **Uses Slice Contract:** yes
  - **Overrides:** none
  - **Boundary Receipt:** task-diff-snapshot

- [ ] 3.V [Slice-1] Code Verifier gate
  - **Covered Tasks:** 3.1, 3.2
  - **Evidence Packet Required:** yes
  - **Inspection Scope:** Slice 1 artifacts + Worker evidence sections + changed files + task snapshot receipts + tests + commands + code reality evidence, when used
  - **PASS/FAIL Gate:** all Slice 1 ACs pass; no scope violation; adversarial verification completed
  - **On PASS:** Committer creates slice-output commit

### 4. Reconciliation

- [ ] 4.1 Record Execution Summary
  - **Execution Type:** evidence-summary
  - **Allowed File Scope:** proofloop/evidence-ledger.md
  - **Work Request:** fill `## 4. Execution Summary` in `proofloop/evidence-ledger.md`
  - **Inputs:** Worker receipts, task-diff-snapshot receipts, Code Verifier receipts, slice-output commit receipts, residual risks
  - **Verification Method:** inspect receipt refs and commit hashes only; do not re-run stage verification
  - **Expected Evidence:** `proofloop/evidence-ledger.md` contains complete `## 4. Execution Summary`
  - **Boundary Receipt:** task-diff-snapshot

<!-- Reconciliation records evidence only.
     Additional build/test requirements must appear in slice Verification Method,
     Code Verifier gate, or Brain/IR stage review expectations, not here. -->

## Readiness Checklist

- [ ] Dependencies are explicit.
- [ ] Parallel opportunities are marked where safe.
- [ ] Brain ACs mapped.
- [ ] Every slice has verifiable ACs.
- [ ] Every slice has a Code Verifier gate.
- [ ] Tasks are mechanically executable.
- [ ] Allowed File Scope is explicit.
- [ ] Verification Method is explicit.
- [ ] Expected Evidence is explicit.
- [ ] Stop Conditions are explicit.
- [ ] Git boundary plan is explicit.
- [ ] Task output uses task-diff-snapshot.
- [ ] Slice output is committed only after verifier PASS.
- [ ] Blocking section exists (Proof Task for interactive changes).
- [ ] Reconciliation records Execution Summary in Evidence Ledger.

## Evidence Ledger Section

Expected Evidence must be concrete enough for ledger recording.

| Slice | Evidence Section | Task Receipt Section |
| --- | --- | --- |
| Slice 1 | 3. Worker Hypothesis Verification Sections + 4. Execution Summary | Task 3.1 / Slice 1 |
