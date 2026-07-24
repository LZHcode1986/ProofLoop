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
- Relevant Task Acceptance Matrix Items
- Matrix Item IDs
- Matrix Acceptance Requirements
- Dependencies
- Constraints
- Out of Scope
- Blocking Hard Parts
- Existing tasks.md path, if present
- Existing evidence.md path, if present
- Latest Validator Result, if present
- Latest SPV Findings, if present

## Expected results

PLAN_READY — Stage decomposed into Slices with tasks.md and evidence.md.
Plan blocked with stop condition if unresolved.

## Stop routing

- PLAN_GAP
  → Brain evaluates the cause:
    - missing planning detail → continue Planner with new information
    - invalid or oversized Stage boundary → return to STAGE_SELECTION / REPARTITION_REQUIRED
    - missing architecture authority → AUTHORITY_GAP
    - unresolved technical assumption → Researcher / Prototype
- AUTHORITY_GAP → Brain updates authority, re-dispatch
- TECHNICAL_DISCOVERY_REQUIRED → route to Researcher / Prototype

## Packet

```text
Target Agent: planner
Contract Ref: .agents/contracts/brain/plan-stage.md
Objective: <create Stage plan>
Stage ID: <Sxx>
Stage Goal: <one sentence>
Observable Outcomes: <list>
Primary Domain Capability: <capability>
Expected Public Seam: <interface>
PRD References: <refs>
Tech Spec References: <refs>
Relevant Task Acceptance Matrix Items: <refs>
Matrix Item IDs: <ids>
Matrix Acceptance Requirements: <requirements>
Dependencies: <list>
Constraints: <limits>
Out of Scope: <what not to plan>
Blocking Hard Parts: <list>
Existing tasks.md path: <path | none>
Existing evidence.md path: <path | none>
Latest Validator Result: <result | none>
Latest SPV Findings: <findings | none>
Allowed Scope: <delivery/stages/<stage-id>/>
Forbidden Scope: <authority documents>
Acceptance Criteria: <PLAN_READY>
Verification Method: <Planner internal SPV validation>
Expected Evidence: <tasks.md + evidence.md>
Authoritative Inputs: <CONTEXT.md, PRD.md, tech-spec/*, task-acceptance-matrix.md>
Constraints: <no file path prediction, vertical Slices only>
Stop Conditions: <PLAN_GAP, AUTHORITY_GAP, TECHNICAL_DISCOVERY_REQUIRED>
Expected Result: <Plan ready (SPV validated) | Plan blocked>
```
