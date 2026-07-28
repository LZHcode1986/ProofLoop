# Stage S00-positive — Positive Fixture

## Stage Goal

Verify that a minimal but complete Stage workspace is valid.

## Observable Outcomes

- OUT-POS-01: Tasks.md follows the current template format
- OUT-POS-02: Evidence.md matches all slices

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

S1

---

## Slice S1 — Positive Smoke
<!-- SLICE:S1:BEGIN -->

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

### Proof Plan

Primary Seam: File existence
Required Success Behaviors: tasks.md and evidence.md exist
Required Failure Behaviors: Missing files are detected

### Tasks

- [ ] S1-T1: Verify fixture files exist
- [ ] S1-T2: Confirm YAML structure is valid

### Task → Slice Closure

S1-T1 + S1-T2 → OUT-POS-01

### Worker Status

- Status: planned

<!-- SLICE:S1:END -->

---

## Slice → Stage Closure

OUT-POS-01: validated by fixture existence
OUT-POS-02: validated by evidence.md completeness
