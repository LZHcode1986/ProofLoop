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


