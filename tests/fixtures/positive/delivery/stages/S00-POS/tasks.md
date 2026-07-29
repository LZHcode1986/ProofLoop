# Stage S00-POS — Positive Fixture

## Stage Goal

Verify that a minimal but complete Stage workspace is valid.

## Observable Outcomes

- OUT-POS-01: Tasks.md follows the current template format
- OUT-POS-02: Per-Slice Evidence files match Manifest declarations

## Architecture Work Item References

- AWI-001 — Minimal acceptance criteria met

## Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

## Dependencies

None

## Constraints

None

## Out of Scope

- Real implementation logic

## Blocking Hard Parts

None

---

## Slice Graph

S00-A

---

## Slice S00-A — Positive Smoke
<!-- SLICE:S00-A:BEGIN -->

### Goal

Provide a valid Slice with one task.

### Observable Outcome

OUT-POS-01

### Public Seam

CLI exit codes

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### Proof Obligations

- PO-S00-A-01
  - Behavior: fixture files exist
  - Public Seam: File existence
  - Oracle Source: fixture checker
  - Success / Failure: required files are present
  - Required Observation: evidence skeleton is accepted

### Proof Plan

Primary Seam: File existence
Required Success Behaviors: tasks.md and evidence/<slice-id>.md exist
Required Failure Behaviors: Missing per-Slice evidence files are detected

### Tasks

- [ ] S00-A-T1: Verify fixture files exist
- [ ] S00-A-T2: Confirm YAML structure is valid

### Task → Slice Closure

S00-A-T1 + S00-A-T2 → OUT-POS-01

### Worker Status

- Status: planned

<!-- SLICE:S00-A:END -->

---

## Slice → Stage Closure

OUT-POS-01: validated by fixture existence
OUT-POS-02: validated by per-Slice evidence completeness
