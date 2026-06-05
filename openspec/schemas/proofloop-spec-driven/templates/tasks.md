# Tasks

## Brain Acceptance Coverage Map

| Brain AC ID | Criterion Summary | Covered By | Proof Source |
| --- | --- | --- | --- |
| AC-1 |  | Slice 1 verifier | Evidence Packet + command |

## Global Stop Conditions

- Acceptance criterion not testable.
- Required change exceeds allowed scope.
- CodeGraph impact exceeds allowed scope.
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
- **Required Review Skills:**
  - code-review-and-quality
- **CodeGraph Anchors:**
  - 
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

- [ ] 3.V [Slice-1] Code Verifier gate
  - **Covered Tasks:** 3.1
  - **Evidence Packet Required:** yes
  - **Inspection Scope:** Slice 1 artifacts + changed files + task snapshot receipts + tests + commands + CodeGraph evidence
  - **PASS/FAIL Gate:** all Slice 1 ACs pass; no scope violation; required review skills applied
  - **On PASS:** Committer creates slice-output commit

### 4. Reconciliation

- [ ] 4.1 Final repo gate
  - **Allowed File Scope:** <paths required for evidence only, if any>
  - **Verification Method:** `bash scripts/local-check.sh`
  - **Expected Evidence:** command exits 0; output summary captured
  - **Boundary Receipt:** task-diff-snapshot | stage-output if not part of a slice

<!-- Additional Reconciliation rules:
  - Frontend files touched: Reconciliation must include `cd frontend && npm run build`.
  - Backend or pipeline behavior changed: Reconciliation must include targeted `uv run pytest ...`.
  - Interactive change: Reconciliation must include full acceptance proof after all slices complete.
-->

## Readiness Checklist

- [ ] Brain ACs mapped.
- [ ] Every slice has verifiable ACs.
- [ ] Every slice has a Code Verifier gate.
- [ ] Tasks are mechanically executable.
- [ ] Allowed File Scope is explicit.
- [ ] Verification Method is explicit.
- [ ] Expected Evidence is explicit.
- [ ] Stop Conditions are explicit.
- [ ] Required Review Skills are explicit.
- [ ] CodeGraph anchors are included when needed.
- [ ] Git boundary plan is explicit.
- [ ] Task output uses task-diff-snapshot.
- [ ] Slice output is committed only after verifier PASS.
- [ ] Blocking section exists (Proof Task for interactive changes).
- [ ] Reconciliation includes `bash scripts/local-check.sh`.

## Evidence Ledger Section

Expected Evidence must be concrete enough for ledger recording.

| Slice | Evidence Section | Task Receipt Section |
| --- | --- | --- |
| Slice 1 | 4. Execution Evidence > Slice 1 | Task 3.1 |
