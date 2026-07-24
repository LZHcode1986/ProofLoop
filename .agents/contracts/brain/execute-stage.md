# Brain Execute Stage Dispatch Contract

Dispatch a Stage execution to Executor.

## When to use

A Stage plan is ready (SPV PLAN_READY) and all blocking Hard Parts are VALIDATED.

## Required Core Packet fields

- Route
- Objective / Brain Intent
- Continuation
- Allowed Scope
- Forbidden Scope / Out of Scope
- Acceptance Criteria
- Verification Method
- Expected Evidence
- Authoritative Inputs
- Constraints
- Stop Conditions
- Expected Result

## Required execution fields

- Stage ID
- Stage Goal
- tasks.md path
- evidence.md path
- Slice DAG
- Blocking Hard Parts status

## Packet shape

```text
Route: executor
Objective: <execute Stage>
Continuation: <task_id | none>
Stage ID: <Sxx>
Stage Goal: <one sentence>
tasks.md: <path>
evidence.md: <path>
Slice DAG: <dependencies>
Blocking Hard Parts: <VALIDATED>
Allowed Scope: <Stage branch>
Forbidden Scope: <other Stage branches, authority docs>
Acceptance Criteria: <all Slices complete + CV PASS>
Verification Method: <Executor reconciliation>
Expected Evidence: <Execution Handoff>
Authoritative Inputs: <tasks.md, evidence.md, tech-spec/*>
Constraints: <one Stage at a time>
Stop Conditions: <UNRESOLVED_IMPLEMENTATION_DEFECT, PLAN_GAP, AUTHORITY_GAP, TECHNICAL_UNKNOWN>
Expected Result: <Execution complete | Execution blocked>
```