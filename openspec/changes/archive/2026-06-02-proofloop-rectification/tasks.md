# Non-goal Reminder
No modifications to the OpenSpec core CLI, and no changes to backend data models.

## Recommended MVP Scope
Fix the 4 critical gaps and archive the rectification change to provide visible trace alignment.

## Proof Posture
Proof Posture: P0 Fast Proof

## Stage Acceptance Coverage Map

| Stage AC ID | Criterion Summary | Covered By | Proof Source |
| --- | --- | --- | --- |
| SAC-1 | P0 verifier bypass verification | Slice 1 verifier | Self-check and command verification |
| SAC-2 | Metadata rules for Slice Contract | Slice 1 verifier | Self-check and task verification |
| SAC-3 | opencode.json instruction loading | Slice 1 verifier | Self-check and file check |
| SAC-4 | Archive rectification change | Reconciliation | openspec archive command |

## Task Order

### 1. Setup
- [x] 1.1 Configure proofloop-spec-driven schema for project config.yaml
  - **Allowed File Scope:** ["openspec/config.yaml"]
  - **Verification:** "git diff openspec/config.yaml"

### 2. Blocking
- [x] 2.1 Set up the proofloop-rectification change directory
  - **Allowed File Scope:** ["openspec/changes/proofloop-rectification/*"]
  - **Verification:** "openspec status --change proofloop-rectification"

### 3. Slice 1: Rectify ProofLoop Gaps

#### Slice Contract
- **Slice Goal:** Rectify all 4 residual gaps identified in ProofLoop governance v2.
- **Acceptance Criteria:**
  - AC-S1-1: P0 Fast Proof bypasses independent verifiers.
  - AC-S1-2: Tasks inherit from Slice Contract, removing redundant task metadata.
  - AC-S1-3: opencode.json is created and lazy loading is defined in AGENTS.md.
- **Default Allowed File Scope:**
  - [".agents/skills/openspec-propose/SKILL.md", "AGENTS.md", "opencode.json"]
- **TDD Contract:** not-applicable
- **TDD Test Files:**
  - []
- **RED Command:** ""
- **GREEN Command:** ""
- **Additional Verification Commands:**
  - "git diff"
- **Boundary Mode:** final
- **Verifier Gate:** 3.V

#### Tasks
- [x] 3.1 [Slice-1] Fix P0 Fast Proof verifier conflict in openspec-propose skill
  - **Uses Slice Contract:** yes
  - **Overrides:** none
- [x] 3.2 [Slice-1] Modify metadata requirements to support Slice Contract
  - **Uses Slice Contract:** yes
  - **Overrides:** none
- [x] 3.3 [Slice-1] Implement opencode.json rules lazy loading and add rules to AGENTS.md
  - **Uses Slice Contract:** yes
  - **Overrides:** none
- [x] 3.V [Slice-1] Verify all rectification local edits against plan checklist
  - **Covered Tasks:** 3.1, 3.2, 3.3
  - **Evidence Packet Required:** yes
  - **Inspection Scope:** Slice 1 artifacts + changed files
  - **PASS/FAIL Gate:** all Slice 1 ACs pass; no scope violation; no critical regression

### 4. Reconciliation
- [x] 4.1 Verify OpenSpec validation and complete change archive
  - **Allowed File Scope:** ["*"]
  - **Verification:** "openspec archive --change proofloop-rectification"
