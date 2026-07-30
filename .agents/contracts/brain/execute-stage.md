# Brain Execute Stage Dispatch Contract

This contract is self-contained.

Dispatch a Stage execution to Executor.

## Use when

A Stage plan is ready (SPV PLAN_READY), all blocking Hard Parts are VALIDATED or explicitly DEFERRED with Brain acceptance, and the Stage Manifest has been compiled and validated.

## Target-specific required fields

- Stage ID
- Stage Goal
- tasks.md path
- Slice DAG
- Stage Plan Commit / Base Ref
- Integration Branch
- Blocking Hard Parts status (VALIDATED / DEFERRED)

**New required fields for Stage Gate:**

- **Manifest path** — path to the compiled Stage Manifest (`.proofloop/manifests/<stage-id>.json`). The Manifest declares per-Slice `evidence_path` entries and `cv_minimum_level`. CV PASS receipt refs, commit SHAs, and integration refs are supplied via Slice COMPLETE facts (a separate JSON array passed to `run-stage.js`), not embedded in the Manifest itself.
- **Manifest digest** — SHA-256 digest of the Manifest file, for integrity verification against tasks.md
- **CV Risk Policy version** — version identifier of the Risk Policy used to determine CV minimum levels
- **Stage Runtime Proof structured plan** — the array of `RuntimeProofStep` objects from the Manifest, defining the Stage Gate execution sequence
- **Expected Stage Gate Receipt path** — output path where the Stage Gate Receipt will be written after execution

### Stage Validator PASS Reference

Validator must confirm:
- tasks.md is well-formed
- All slice markers are balanced and valid
- DAG has no cycles
- Each slice has Risk Facts and Proof Obligations with oracle sources

### SPV PLAN_READY Reference

SPV must confirm:
- Every Slice Goal is bounded and testable
- Every Observable Outcome is measurable
- Every Public Seam identifies a real interface boundary
- Proof Obligations are sufficient for the Slice's CV level
- Risk Facts are complete and actionable
- Manifest has been compiled and its digest matches tasks.md content

## Derive Next Action

After each step, the Executor deterministically derives the next action:

| Condition | Next action |
|---|---|
| All Slices integrated and CV PASS | Execute Stage Gate runtime proof sequence |
| Persisted Stage Gate Receipt validates PASS | Return `STAGE_GATE_PASSED` with receipt path |
| Slice CV verdict `REPAIR` | Only `REPAIR` enters repair: re-dispatch the Worker in repair mode |
| Slice CV verdict `REPLAN` | Return to Brain/planner per the rectification plan |
| Slice CV verdict `BLOCKED` | Return to Brain per the rectification plan |
| Slice CV verdict `ESCALATION_REQUIRED` | Return to Brain/human per the rectification plan |
| Stage Gate step FAIL (non-zero exit) | Return `IMPLEMENTATION_DEFECT` / `STAGE_GATE_STEP_FAILED` |
| Missing step or invalid step definition | Return `PLAN_GAP` / `STAGE_GATE_MISSING_STEP` |
| Observation mismatch vs Manifest outcomes | Return `EVIDENCE_GAP` / `STAGE_GATE_OBSERVATION_FAILURE` |
| Environment precondition unmet | Return `RUNTIME_BLOCKER` / `STAGE_GATE_ENV_FAILURE` |
| Cleanup failure after Gate execution | Return `RUNTIME_BLOCKER` / `STAGE_GATE_CLEANUP_FAILURE` |

## Committer and Integration boundary closure

Receipt-backed scope validation is closed through the existing slice boundary:
Committer validates the CV receipt and changed-file boundary, then Integration
and post-merge checks validate the resulting Stage boundary. No standalone scope
action is dispatched.

## Stage Gate receipt and review boundary

Executor runs the Stage Gate and must verify that its persisted Stage Gate
Receipt exists and validates the Stage ID, Manifest digest, integrated snapshot,
and every Manifest Slice before returning `STAGE_GATE_PASSED`. A transient or
in-memory PASS is not sufficient. After that return, Brain alone dispatches a
fresh Stage Reviewer; Executor never dispatches Stage Reviewer.

## Expected results

All Slices integrated, all required CV Gates passed, the persisted Stage Gate
Receipt shows PASS on the integrated snapshot, and `STAGE_GATE_PASSED` is
returned with the receipt path.

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
