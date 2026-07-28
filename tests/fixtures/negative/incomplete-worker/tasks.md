# Stage S00-incomplete — Incomplete Worker Fixture

## Stage Goal

Demonstrate a stage where the Worker has only partially completed tasks.

## Observable Outcomes

- OUT-INC-01: Detect incomplete tasks in a slice
- OUT-INC-02: Detect missing evidence sections

## Architecture Work Item References

- AWI-002

## Authority References

None

## Dependencies

None

## Constraints

None

## Out of Scope

None

## Blocking Hard Parts

None

---

## Slice Graph

S1 → S2

---

## Slice S1 — Completed Work
<!-- SLICE:S1:BEGIN -->

### Goal

All tasks completed in this slice.

### Observable Outcome

OUT-INC-01

### Public Seam

Task checkboxes

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

None

### Architecture Work Item References

- AWI-002

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### Proof Plan

Check all tasks are checked off.

### Tasks

- [x] S1-T1: Complete first task
- [x] S1-T2: Complete second task

### Task → Slice Closure

S1-T1 + S1-T2 → OUT-INC-01

### Worker Status

- Status: complete

<!-- SLICE:S1:END -->

---

## Slice S2 — Incomplete Work
<!-- SLICE:S2:BEGIN -->

### Goal

One task still unchecked.

### Observable Outcome

OUT-INC-02

### Public Seam

Task checkboxes

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

None

### Architecture Work Item References

- AWI-002

### Dependency Outputs

S1: Completed tasks

### Dependencies

- S1

### Risk Facts

- none

### Proof Plan

Check for unchecked tasks.

### Tasks

- [x] S2-T1: Complete first task
- [ ] S2-T2: Second task — still incomplete

### Task → Slice Closure

S2-T1 + S2-T2 → OUT-INC-02

### Worker Status

- Status: in-progress

<!-- SLICE:S2:END -->

---

## Slice → Stage Closure

OUT-INC-01: validated by S1 completeness
OUT-INC-02: validated by S2 incompleteness
