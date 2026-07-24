# Brain General Direct Task Dispatch Contract

Dispatch a bounded, non-authority task to General.

## When to use

A bounded local task that does not require specialist ownership and does not affect authority documents.

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

## Rules

- General does not make specialist judgments
- General does not commit
- If the task exceeds General scope, General returns GENERAL_SCOPE_EXCEEDED

## Packet shape

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