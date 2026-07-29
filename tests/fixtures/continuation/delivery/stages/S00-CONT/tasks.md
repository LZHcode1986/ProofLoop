# Stage S00-CONT — Continuation Fixture

## Stage Goal

Simulate a partially-completed Stage where the Planner has finished and the Worker is mid-execution.

## Observable Outcomes

- OUT-CONT-01: Slice with Worker Status `ready-for-cv` is detectable
- OUT-CONT-02: Slice with Worker Status `executing` is detectable

## Architecture Work Item References

- AWI-CONT-001

## Authority References

None

## Dependencies

None

## Constraints

None

## Out of Scope

- Completed stages
- Runtime Proof

## Blocking Hard Parts

None

---

## Slice Graph

S01-A → S01-B

---

## Slice S01-A — Ready for CV
<!-- SLICE:S01-A:BEGIN -->

### Goal

Simulate a completed slice that is ready for Code Verification.

### Observable Outcome

OUT-CONT-01

### Public Seam

Worker Status field

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

None

### Architecture Work Item References

- AWI-CONT-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### Proof Obligations

- PO-S01-A-01
  - Behavior: completed
  - Public Seam: Worker Status
  - Oracle Source: manual inspection
  - Success / Failure: Status is ready-for-cv
  - Required Observation: N/A

### Proof Plan

Primary Seam: Worker Status marker
Required Success Behaviors: Status field reads 'ready-for-cv'

### Evidence

Per-Slice evidence file: `evidence/S01-A.md`

### Tasks

- [x] S01-A-T01: Complete first slice work

### Task → Slice Closure

S01-A-T01 → OUT-CONT-01

### Worker Status

- Status: ready-for-cv

<!-- SLICE:S01-A:END -->

---

## Slice S01-B — Executing
<!-- SLICE:S01-B:BEGIN -->

### Goal

Simulate a slice that is currently being executed by the Worker.

### Observable Outcome

OUT-CONT-02

### Public Seam

Worker Status field

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

None

### Architecture Work Item References

- AWI-CONT-001

### Dependency Outputs

S01-A: Completed slice

### Dependencies

- S01-A

### Risk Facts

- none

### Proof Obligations

- PO-S01-B-01
  - Behavior: in-progress
  - Public Seam: Worker Status
  - Oracle Source: manual inspection
  - Success / Failure: Status is executing
  - Required Observation: N/A

### Proof Plan

Primary Seam: Worker Status marker
Required Success Behaviors: Status field reads 'executing'

### Evidence

Per-Slice evidence file: `evidence/S01-B.md`

### Tasks

- [ ] S01-B-T01: Start second slice work

### Task → Slice Closure

S01-B-T01 → OUT-CONT-02

### Worker Status

- Status: executing

<!-- SLICE:S01-B:END -->

---

## Slice → Stage Closure

OUT-CONT-01: validated by S01-A Worker Status
OUT-CONT-02: validated by S01-B Worker Status
