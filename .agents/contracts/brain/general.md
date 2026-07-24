# Brain General Direct Task Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a bounded, non-authority task to General.

## Use when

A bounded local task that does not require specialist ownership and does not affect authority documents.

## Target-specific required fields

- Objective
- Allowed Scope
- Forbidden Scope
- Acceptance Criteria
- Verification Method

## Rules

- General does not make specialist judgments
- General does not commit
- If the task exceeds General scope, General returns GENERAL_SCOPE_EXCEEDED

## Expected results

Edit complete, Edit blocked, or GENERAL_SCOPE_EXCEEDED.

## Stop routing

- GENERAL_SCOPE_EXCEEDED → Brain re-evaluates, dispatches appropriate specialist
- AUTHORITY_IMPACT → Brain handles authority update
- TECHNICAL_UNKNOWN → Brain dispatches Researcher / Prototype

## Packet

```text
Route: general
Objective: <what to accomplish>
Continuation: <task_id | none>
Allowed Scope: <file paths>
Forbidden Scope: <file paths>
Acceptance Criteria: <how to verify>
Verification Method: <how to check>
Expected Evidence: <what to return>
Authoritative Inputs: <refs>
Constraints: <limits>
Stop Conditions: <when to stop>
Expected Result: <Edit complete | Edit blocked | GENERAL_SCOPE_EXCEEDED>
```
