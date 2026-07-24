# Brain Stage Review Dispatch Contract

Dispatch a Stage review to Stage Reviewer.

## When to use

A Stage execution is complete and needs goal-first review against the Stage Goal, Observable Outcomes, and authority documents.

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

## Required review fields

- Stage ID
- Stage Goal
- Observable Outcomes
- PRD References
- Tech Spec References
- Stage branch ref

## Packet shape

```text
Route: stage-reviewer
Objective: <review Stage>
Continuation: <task_id | none>
Stage ID: <Sxx>
Stage Goal: <one sentence>
Observable Outcomes: <list>
PRD References: <refs>
Tech Spec References: <refs>
Stage branch ref: <branch>
Allowed Scope: <Stage branch and authority docs>
Forbidden Scope: <other Stage branches>
Acceptance Criteria: <Stage Goal met, Observable Outcomes achieved, authority docs consistent>
Verification Method: <goal-first review>
Expected Evidence: <review verdict>
Authoritative Inputs: <tasks.md, evidence.md, code, tests, tech-spec/*>
Constraints: <read-only, goal-first, no implementation>
Stop Conditions: <GOAL_MISMATCH, AUTHORITY_VIOLATION, INCOMPLETE_EVIDENCE>
Expected Result: <ACCEPTED | REJECTED | BLOCKED>
```