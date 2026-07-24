# Brain Plan Stage Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a Stage planning task to Planner.

## Use when

A Stage Goal is selected and needs to be decomposed into Slices and Tasks.

## Target-specific required fields

- Stage ID
- Stage Goal
- Observable Outcomes
- Primary Domain Capability
- Expected Public Seam
- PRD References
- Tech Spec References
- Dependencies
- Constraints
- Out of Scope
- Blocking Hard Parts

## Expected results

PLAN_READY — Stage decomposed into Slices with tasks.md and evidence.md.
Plan blocked with stop condition if unresolved.

## Stop routing

- PLAN_GAP → route to Planner
- AUTHORITY_GAP → Brain updates authority, re-dispatch
- TECHNICAL_DISCOVERY_REQUIRED → route to Researcher / Prototype

## Packet

```text
Target Agent: planner
Contract Ref: .agents/contracts/brain/plan-stage.md
Objective: <create Stage plan>
Continuation: <task_id | none>
Stage ID: <Sxx>
Stage Goal: <one sentence>
Observable Outcomes: <list>
Primary Domain Capability: <capability>
Expected Public Seam: <interface>
PRD References: <refs>
Tech Spec References: <refs>
Dependencies: <list>
Constraints: <limits>
Out of Scope: <what not to plan>
Blocking Hard Parts: <list>
Allowed Scope: <delivery/stages/<stage-id>/>
Forbidden Scope: <authority documents>
Acceptance Criteria: <PLAN_READY>
Verification Method: <Planner internal SPV validation>
Expected Evidence: <tasks.md + evidence.md>
Authoritative Inputs: <CONTEXT.md, PRD.md, tech-spec/*>
Constraints: <no file path prediction, vertical Slices only>
Stop Conditions: <PLAN_GAP, AUTHORITY_GAP, TECHNICAL_DISCOVERY_REQUIRED>
Expected Result: <Plan ready (SPV validated) | Plan blocked>
```
