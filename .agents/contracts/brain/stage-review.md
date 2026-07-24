# Brain Stage Review Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a Stage review to Stage Reviewer.

## Use when

A Stage execution is complete and needs goal-first review against the Stage Goal, Observable Outcomes, and authority documents.

## Target-specific required fields

- Stage ID
- Stage Goal
- Observable Outcomes
- PRD References
- Tech Spec References
- Stage branch ref

## Expected results

ACCEPTED, REJECTED, or BLOCKED verdict returned to Brain.

## Stop routing

- GOAL_MISMATCH → Brain evaluates whether to accept deviation or repartition
- AUTHORITY_VIOLATION → Brain resolves authority inconsistency
- INCOMPLETE_EVIDENCE → Brain may re-dispatch to Executor for gap fill

## Packet

```text
Target Agent: stage-reviewer
Contract Ref: .agents/contracts/brain/stage-review.md
Objective: <review Stage>
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
