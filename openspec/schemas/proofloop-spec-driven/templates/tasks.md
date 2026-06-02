# Non-goal Reminder
<!-- State what is not included in this change to prevent scope drift. -->

## Recommended MVP Scope
<!-- State the smallest deliverable slice that still forms a closed loop. -->

## Proof Posture
Proof Posture: P0 Fast Proof | P1 Stage Proof | P2 Audit Proof

## Stage Acceptance Coverage Map

| Stage AC ID | Criterion Summary | Covered By | Proof Source |
| --- | --- | --- | --- |
| SAC-1 | [summary] | Slice 1 verifier | Evidence Packet S1 + command |

## Task Order

### 1. Setup
- [ ] 1.1 [task]
  - **Allowed File Scope:** [paths]
  - **Verification:** [command]

### 2. Blocking
- [ ] 2.1 [task]
  - **Allowed File Scope:** [paths]
  - **Verification:** [command]

### 3. Slice 1: [slice-name]

#### Slice Contract
- **Slice Goal:** [goal]
- **Acceptance Criteria:**
  - AC-S1-1: [criterion]
- **Default Allowed File Scope:**
  - [paths]
- **TDD Contract:** required | not-applicable
- **TDD Test Files:**
  - [test files]
- **RED Command:** [command]
- **GREEN Command:** [command]
- **Additional Verification Commands:**
  - [command]
- **Boundary Mode:** final | slice | per-task
- **Verifier Gate:** 3.V

#### Tasks
- [ ] 3.1 [Slice-1] [task]
  - **Uses Slice Contract:** yes
  - **Overrides:** none
- [ ] 3.V [Slice-1] [verifier]
  - **Covered Tasks:** 3.1
  - **Evidence Packet Required:** yes
  - **Inspection Scope:** Slice 1 artifacts + changed files + TDD test files + command excerpts
  - **PASS/FAIL Gate:** all Slice 1 ACs pass; no scope violation; no critical regression

### 4. Reconciliation
- [ ] 4.1 [task]
  - **Allowed File Scope:** [paths]
  - **Verification:** [command]
