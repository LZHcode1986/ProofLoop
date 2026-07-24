# Brain Execute Stage Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a Stage execution to Executor.

## Use when

A Stage plan is ready (SPV PLAN_READY) and all blocking Hard Parts are VALIDATED.

## Target-specific required fields

- Stage ID
- Stage Goal
- tasks.md path
- evidence.md path
- Slice DAG
- Blocking Hard Parts status

## Expected results

All Slices complete with CV PASS. Execution Handoff returned to Brain.

## Stop routing

- UNRESOLVED_IMPLEMENTATION_DEFECT → continuation to Executor
- PLAN_GAP → route to Planner
- AUTHORITY_GAP → Brain updates authority
- TECHNICAL_UNKNOWN → route to Researcher / Prototype

## Packet

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
