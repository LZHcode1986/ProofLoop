# Brain Prototype Dispatch Contract

Dispatch a local technical experiment to Prototype.

## When to use

A technical question requires local validation in an isolated worktree before it can be accepted into Tech Spec.

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

## Required prototype fields

- Hard Part ID
- Validation Question
- Success Criteria
- Failure Criteria
- Environment
- Research Delegation: allowed | denied

## Packet shape

```text
Route: prototype
Objective: <validate technical question>
Continuation: <task_id | none>
Hard Part ID: <HP-xxx>
Validation Question: <specific question>
Success Criteria: <what must be true>
Failure Criteria: <what would disprove>
Environment: <local config>
Research Delegation: allowed
Allowed Scope: <prototype/ experiment/ throwaway/>
Forbidden Scope: <production code paths>
Acceptance Criteria: <clear result>
Verification Method: <run experiment>
Expected Evidence: <experiment results>
Authoritative Inputs: <refs>
Constraints: <limits>
Stop Conditions: <when to stop>
Expected Result: <VALIDATED | REJECTED | INCONCLUSIVE | BLOCKED>
```