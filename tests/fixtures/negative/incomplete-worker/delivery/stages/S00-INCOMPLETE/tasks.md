# Stage S00-INCOMPLETE — Incomplete Worker Fixture

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

S01-A → S01-B

---

## Slice S01-A — Completed Work
<!-- SLICE:S01-A:BEGIN -->

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

### Proof Obligations

- PO-S01-A-01
  - Behavior: task completeness validated
  - Public Seam: Task checkboxes
  - Oracle Source: fixture checker
  - Success / Failure: all tasks checked
  - Required Observation: completion status is reported

### Proof Plan

Check all tasks are checked off.

### Tasks

- [x] S01-A-T1: Complete first task
- [x] S01-A-T2: Complete second task

### Task → Slice Closure

S01-A-T1 + S01-A-T2 → OUT-INC-01

### Worker Status

- Status: complete

<!-- SLICE:S01-A:END -->

---

## Slice S01-B — Incomplete Work
<!-- SLICE:S01-B:BEGIN -->

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

### Proof Obligations

- PO-S01-B-01
  - Behavior: incomplete task detected
  - Public Seam: Task checkboxes
  - Oracle Source: fixture checker
  - Success / Failure: incomplete Worker status is reported
  - Required Observation: unchecked task is reported

### Proof Plan

Check for unchecked tasks.

### Tasks

- [x] S01-B-T1: Complete first task
- [ ] S01-B-T2: Second task — still incomplete

### Task → Slice Closure

S01-B-T1 + S01-B-T2 → OUT-INC-02

### Worker Status

- Status: in-progress

<!-- SLICE:S01-B:END -->

---

## Slice → Stage Closure

OUT-INC-01: validated by S1 completeness
OUT-INC-02: validated by S2 incompleteness
