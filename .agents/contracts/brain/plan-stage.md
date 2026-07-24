# Brain Plan Stage Dispatch Contract

Dispatch a Stage planning task to Planner.

## When to use

A Stage Goal is selected and needs to be decomposed into Slices and Tasks.

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

## Required planning fields

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

## Packet shape

```text
Route: planner
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
Acceptance Criteria: <SPV PLAN_READY>
Verification Method: <SPV reverse validation>
Expected Evidence: <tasks.md + evidence.md>
Authoritative Inputs: <CONTEXT.md, PRD.md, tech-spec/*>
Constraints: <no file path prediction, vertical Slices only>
Stop Conditions: <PLAN_GAP, AUTHORITY_GAP, TECHNICAL_DISCOVERY_REQUIRED>
Expected Result: <Plan ready | Plan blocked>
```