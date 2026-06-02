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

### 2. Slice 1: <slice-name>

#### Slice Contract

- **Slice Goal:** 
- **Acceptance Criteria:**
  - AC-S1-1:
- **Default Allowed File Scope:**
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
- **Verifier Gate:** 2.V

#### Tasks

- [ ] 2.1 [Slice-1] <task>
  - **Uses Slice Contract:** yes
  - **Overrides:** none
  - **Boundary Receipt:** task-diff-snapshot

- [ ] 2.V [Slice-1] Code Verifier gate
  - **Covered Tasks:** 2.1
  - **Evidence Packet Required:** yes
  - **Inspection Scope:** Slice 1 artifacts + changed files + task snapshot receipts + tests + commands + CodeGraph evidence
  - **PASS/FAIL Gate:** all Slice 1 ACs pass; no scope violation; required review skills applied
  - **On PASS:** Committer creates slice-output commit

### 3. Reconciliation

- [ ] 3.1 <task>
  - **Allowed File Scope:** <paths>
  - **Verification Method:** <command/inspection>
  - **Expected Evidence:** <evidence>
  - **Boundary Receipt:** task-diff-snapshot | stage-output if not part of a slice

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
