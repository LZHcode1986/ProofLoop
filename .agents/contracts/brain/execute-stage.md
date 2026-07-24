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
- Stage Plan Commit / Base Ref
- Stage Validator PASS Reference
- SPV PLAN_READY Reference
- Integration Branch
- Blocking Hard Parts status
- Execution Continuation State

## Expected results

All Slices complete with CV PASS. Execution Handoff returned to Brain.

## Stop routing

- UNRESOLVED_IMPLEMENTATION_DEFECT → continuation to Executor
- PLAN_GAP → route to Planner
- AUTHORITY_GAP → Brain updates authority
- TECHNICAL_UNKNOWN → route to Researcher / Prototype
- SEMANTIC_CONFLICT → Brain

## Packet

```text
Target Agent: executor
Contract Ref: .agents/contracts/brain/execute-stage.md
Objective: <execute Stage>
Stage ID: <Sxx>
Stage Goal: <one sentence>
tasks.md: <path>
evidence.md: <path>
Slice DAG: <dependencies>
Stage Plan Commit / Base Ref: <ref>
Stage Validator PASS Reference: <ref>
SPV PLAN_READY Reference: <ref>
Integration Branch: <branch>
Blocking Hard Parts: <VALIDATED>
Allowed Scope: <Stage branch>
Forbidden Scope: <other Stage branches, authority docs>
Acceptance Criteria: <all Slices complete + CV PASS>
Verification Method: <Executor reconciliation>
Expected Evidence: <Execution Handoff>
Authoritative Inputs: <tasks.md, evidence.md, tech-spec/*>
Constraints: <one Stage at a time>
Stop Conditions: <UNRESOLVED_IMPLEMENTATION_DEFECT, PLAN_GAP, AUTHORITY_GAP, TECHNICAL_UNKNOWN, SEMANTIC_CONFLICT>
Expected Result: <Execution complete | Execution blocked>
```
