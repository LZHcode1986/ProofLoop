# Brain Execute Stage Dispatch Contract

This contract is self-contained.

Dispatch a Stage execution to Executor.

## Use when

A Stage plan is ready (SPV PLAN_READY), all blocking Hard Parts are VALIDATED or explicitly DEFERRED with Brain acceptance, and the Stage Manifest has been compiled and validated.

## Target-specific required fields

- Stage ID
- Stage Goal
- tasks.md path
- evidence.md path
- Slice DAG
- Stage Plan Commit / Base Ref
- Integration Branch
- Blocking Hard Parts status (VALIDATED / DEFERRED)

**New required fields for Stage Gate:**

- **Manifest path** — path to the compiled Stage Manifest (`.proofloop/manifests/<stage-id>.json`)
- **Manifest digest** — SHA-256 digest of the Manifest file, for integrity verification against tasks.md
- **SCV Risk Policy version** — version identifier of the Risk Policy used to determine SCV minimum levels
- **Stage Runtime Proof structured plan** — the array of `RuntimeProofStep` objects from the Manifest, defining the Stage Gate execution sequence
- **Expected Stage Gate Receipt path** — output path where the Stage Gate Receipt will be written after execution

### Stage Validator PASS Reference

Validator must confirm:
- tasks.md and evidence.md are well-formed
- All slice markers are balanced and valid
- DAG has no cycles
- Each slice has Risk Facts and Proof Obligations with oracle sources
- Evidence file has matching markers

### SPV PLAN_READY Reference

SPV must confirm:
- Every Slice Goal is bounded and testable
- Every Observable Outcome is measurable
- Every Public Seam identifies a real interface boundary
- Proof Obligations are sufficient for the Slice's SCV level
- Risk Facts are complete and actionable
- Manifest has been compiled and its digest matches tasks.md content

## Expected results

All Slices integrated, all required SCV Gates passed, Stage Gate passed on integrated snapshot, `STAGE_GATE_PASSED` returned with full receipt.

## Return codes (unified route code format)

When execution is blocked or encounters issues, return with:

```yaml
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | EVIDENCE_GAP | RUNTIME_BLOCKER
subtype: <specific subtype>
affected_stage: <stage-id>
affected_outcomes: <list>
affected_artifacts: <list>
affected_work_items: <list>
affected_hard_parts: <list>
evidence: <summary>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id>
```

### Stage Gate failure subtypes

| Gate failure | route_code | subtype |
|---|---|---|
| Step execution failed (non-zero exit) | `IMPLEMENTATION_DEFECT` | `STAGE_GATE_STEP_FAILED` |
| Missing step or invalid step definition | `PLAN_GAP` | `STAGE_GATE_MISSING_STEP` |
| Environment precondition unmet | `RUNTIME_BLOCKER` | `STAGE_GATE_ENV_FAILURE` |
| Observation mismatch vs Manifest outcomes | `EVIDENCE_GAP` | `STAGE_GATE_OBSERVATION_FAILURE` |
| Cleanup failure after Gate execution | `RUNTIME_BLOCKER` | `STAGE_GATE_CLEANUP_FAILURE` |
