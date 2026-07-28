# Stage S00-SCV — SCV Risk Fact Fixture

## Stage Goal

Validate that SCV level computation correctly maps Risk Facts to lite / standard / enhanced.

## Observable Outcomes

- OUT-SCV-01: Slice with `none` risk fact maps to lite
- OUT-SCV-02: Slice with `authorization` (enhanced-level) risk fact maps to enhanced
- OUT-SCV-03: Slice with `public_api_change` (standard-level only) risk fact maps to standard

## Architecture Work Item References

- AWI-SCV-001

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

Demonstrate that a slice with `none` as its only Risk Fact gets SCV level `lite`.

### Observable Outcome

OUT-SCV-01

### Public Seam

SCV level computation

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-SCV-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### Proof Obligations

- PO-S01-A-01
  - Behavior: validated
  - Public Seam: SCV level API
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: SCV level computation
Required Success Behaviors: computeScvLevel(['none']) returns 'lite'

### Tasks

- [ ] S01-A-T01: Verify SCV level is lite for slice with no risk facts

### Task → Slice Closure

S01-A-T01 → OUT-SCV-01

### Worker Status

- Status: planned

<!-- SLICE:S01-A:END -->

---

## Slice S01-B — Enhanced Risk
<!-- SLICE:S01-B:BEGIN -->

### Goal

Demonstrate that a slice with `persistent_state` and `authorization` gets SCV level `enhanced` (authorization is an enhanced-level risk fact).

### Observable Outcome

OUT-SCV-02

### Public Seam

SCV level computation

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-SCV-001

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
  - Public Seam: SCV level API
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: SCV level computation
Required Success Behaviors: computeScvLevel(['persistent_state', 'authorization']) returns 'enhanced'

### Tasks

- [ ] S01-B-T01: Verify SCV level is enhanced for slice with authorization risk fact

### Task → Slice Closure

S01-B-T01 → OUT-SCV-02

### Worker Status

- Status: planned

<!-- SLICE:S01-B:END -->

---

## Slice S02-A — Standard Risk
<!-- SLICE:S02-A:BEGIN -->

### Goal

Demonstrate that a slice with `public_api_change` (standard-level only) gets SCV level `standard`.

### Observable Outcome

OUT-SCV-03

### Public Seam

SCV level computation

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

- `tech-spec/contract-state-matrix.md#Workspace member`

### Architecture Work Item References

- AWI-SCV-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- public_api_change

### Proof Obligations

- PO-S02-A-01
  - Behavior: validated
  - Public Seam: SCV level API
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: SCV level computation
Required Success Behaviors: computeScvLevel(['public_api_change']) returns 'standard'

### Tasks

- [ ] S02-A-T01: Verify SCV level is standard for slice with public_api_change

### Task → Slice Closure

S02-A-T01 → OUT-SCV-03

### Worker Status

- Status: planned

<!-- SLICE:S02-A:END -->

---

## Slice → Stage Closure

OUT-SCV-01: validated by S01-A correctness
OUT-SCV-02: validated by S01-B correctness
OUT-SCV-03: validated by S02-A correctness
