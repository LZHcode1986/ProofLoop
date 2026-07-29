# Stage S00-CV — CV Risk Fact Fixture

## Stage Goal

Validate that CV level computation correctly maps Risk Facts to lite / standard / enhanced.

## Observable Outcomes

- OUT-CV-01: Slice with `none` risk fact maps to lite
- OUT-CV-02: Slice with `authorization` (enhanced-level) risk fact maps to enhanced
- OUT-CV-03: Slice with `public_api_change` (standard-level only) risk fact maps to standard

## Architecture Work Item References

- AWI-CV-001

## Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

## Dependencies

None

## Constraints

None

## Out of Scope

- Runtime Proof execution
- Evidence content

## Blocking Hard Parts

None

---

## Slice Graph

S01-A, S01-B, S02-A

---

## Slice S01-A — No Risk (Lite)
<!-- SLICE:S01-A:BEGIN -->

### Goal

Demonstrate that a slice with `none` as its only Risk Fact gets CV level `lite`.

### Observable Outcome

OUT-CV-01

### Public Seam

CV level computation

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-CV-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### Proof Obligations

- PO-S01-A-01
  - Behavior: validated
  - Public Seam: CV level API
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: CV level computation
Required Success Behaviors: computeCvLevel(['none']) returns 'lite'

### Evidence

Per-Slice evidence file: `evidence/S01-A.md`

### Tasks

- [ ] S01-A-T01: Verify CV level is lite for slice with no risk facts

### Task → Slice Closure

S01-A-T01 → OUT-CV-01

### Worker Status

- Status: planned

<!-- SLICE:S01-A:END -->

---

## Slice S01-B — Enhanced Risk
<!-- SLICE:S01-B:BEGIN -->

### Goal

Demonstrate that a slice with `persistent_state` and `authorization` gets CV level `enhanced` (authorization is an enhanced-level risk fact).

### Observable Outcome

OUT-CV-02

### Public Seam

CV level computation

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-CV-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- persistent_state
- authorization

### Proof Obligations

- PO-S01-B-01
  - Behavior: validated
  - Public Seam: CV level API
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: CV level computation
Required Success Behaviors: computeCvLevel(['persistent_state', 'authorization']) returns 'enhanced'

### Evidence

Per-Slice evidence file: `evidence/S01-B.md`

### Tasks

- [ ] S01-B-T01: Verify CV level is enhanced for slice with authorization risk fact

### Task → Slice Closure

S01-B-T01 → OUT-CV-02

### Worker Status

- Status: planned

<!-- SLICE:S01-B:END -->

---

## Slice S02-A — Standard Risk
<!-- SLICE:S02-A:BEGIN -->

### Goal

Demonstrate that a slice with `public_api_change` (standard-level only) gets CV level `standard`.

### Observable Outcome

OUT-CV-03

### Public Seam

CV level computation

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-CV-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- public_api_change

### Proof Obligations

- PO-S02-A-01
  - Behavior: validated
  - Public Seam: CV level API
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: CV level computation
Required Success Behaviors: computeCvLevel(['public_api_change']) returns 'standard'

### Evidence

Per-Slice evidence file: `evidence/S02-A.md`

### Tasks

- [ ] S02-A-T01: Verify CV level is standard for slice with public_api_change

### Task → Slice Closure

S02-A-T01 → OUT-CV-03

### Worker Status

- Status: planned

<!-- SLICE:S02-A:END -->

---

## Slice → Stage Closure

OUT-CV-01: validated by S01-A correctness
OUT-CV-02: validated by S01-B correctness
OUT-CV-03: validated by S02-A correctness
