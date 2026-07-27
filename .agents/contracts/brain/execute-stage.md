# Brain Execute Stage Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a Stage execution to Executor.

## Use when

A Stage plan is ready (SPV PLAN_READY) and all blocking Hard Parts are VALIDATED or explicitly DEFERRED with Brain acceptance.

## Target-specific required fields

- Stage ID
- Stage Goal
- tasks.md path
- evidence.md path
- Slice DAG
- Stage Plan Commit / Base Ref
- Stage Validator PASS Reference
- SPV PLAN_READY Reference
- Integration Branch
- Blocking Hard Parts status

## Expected results

All Slices complete with CV PASS. Execution Handoff returned to Brain.

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


