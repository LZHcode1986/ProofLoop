# Stage S00-GATE — Stage Gate Fixture

## Stage Goal

Provide a complete Stage with a full Runtime Proof lifecycle for gate validation.

## Observable Outcomes

- OUT-GATE-01: Build command executes successfully
- OUT-GATE-02: App starts and reports readiness
- OUT-GATE-03: Smoke probe confirms service is up
- OUT-GATE-04: App stops cleanly

## Architecture Work Item References

- AWI-GATE-001

## Authority References

None

## Dependencies

None

## Constraints

None

## Out of Scope

- Real application logic
- CV verification

## Blocking Hard Parts

None

---

## Slice Graph

S01-A

---

## Slice S01-A — Runtime Proof Slice
<!-- SLICE:S01-A:BEGIN -->

### Goal

Provide a minimal slice that validates the full Runtime Proof execution lifecycle.

### Observable Outcome

OUT-GATE-01, OUT-GATE-02, OUT-GATE-03, OUT-GATE-04

### Public Seam

CLI exit codes and service lifecycle signals

### Seam Status

PRE_AGREED

### Required Skills

- diagnose

### Authority References

None

### Architecture Work Item References

- AWI-GATE-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### Proof Obligations

- PO-S01-A-01
  - Behavior: verified
  - Public Seam: CLI exit codes
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

Primary Seam: CLI execution
Required Success Behaviors: Each step exits 0

### Tasks

- [ ] S01-A-T01: Verify build command
- [ ] S01-A-T02: Verify app starts
- [ ] S01-A-T03: Verify smoke probe
- [ ] S01-A-T04: Verify app stops

### Task → Slice Closure

S01-A-T01 + S01-A-T02 + S01-A-T03 + S01-A-T04 → OUT-GATE-01..04

### Worker Status

- Status: planned

<!-- SLICE:S01-A:END -->

---

## Slice → Stage Closure

OUT-GATE-01..04: validated by Runtime Proof execution

---

## Stage Runtime Proof

```yaml
steps:
  - id: build
    type: command
    executable: node
    args:
      - tests/fixtures/stage-gate/runtime/build.js
    timeout_ms: 30000
  - id: app-start
    type: service_start
    executable: node
    args:
      - tests/fixtures/stage-gate/runtime/app.js
    timeout_ms: 10000
    readiness_signal: ready
  - id: smoke
    type: probe
    executable: node
    args:
      - tests/fixtures/stage-gate/runtime/probe.js
    timeout_ms: 5000
    expected:
      exit_code: 0
  - id: app-stop
    type: service_stop
    executable: node
    args: []
    service_ref: app-start
    timeout_ms: 5000
```
