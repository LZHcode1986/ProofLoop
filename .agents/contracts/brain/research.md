# Brain Research Dispatch Contract

Dispatch external technical research to Researcher.

## When to use

A technical question requires external facts from official documentation, GitHub, or other public sources.

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

## Required research fields

- Research Goal
- Research Question
- Why It Matters
- Preferred Sources
- Out of Scope

## Packet shape

```text
Route: researcher
Objective: <research goal>
Continuation: <task_id | none>
Research Goal: <what to learn>
Research Question: <specific question>
Why It Matters: <context>
Preferred Sources: <official docs, GitHub, etc.>
Allowed Scope: <research sources>
Out of Scope: <what not to research>
Acceptance Criteria: <how to verify>
Verification Method: <source quality check>
Expected Evidence: <research findings>
Authoritative Inputs: <refs>
Constraints: <limits>
Stop Conditions: <when to stop>
Expected Result: <Research complete | Research blocked>
```