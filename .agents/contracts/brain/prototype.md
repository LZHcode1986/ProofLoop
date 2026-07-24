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
- Prototype ID: <proto-xxx>
- Base Ref: <git ref to branch from>
- Branch Name: prototype/<hard-part-id>
- Worktree Path: .proofloop/worktrees/prototype-<hard-part-id>
- Tech Spec Refs: <refs>
- Validation Question
- Success Criteria
- Failure Criteria
- Environment
- Cleanup Continuation: <auto | manual>
- Checkpoint Commit: <on-success | always | never>
- Research Delegation: allowed | denied

## Packet shape

```text
Route: prototype
Objective: <validate technical question>
Continuation: <task_id | none>
Prototype ID: <proto-xxx>
Hard Part ID: <HP-xxx>
Base Ref: <git ref to branch from>
Branch Name: prototype/<hard-part-id>
Worktree Path: .proofloop/worktrees/prototype-<hard-part-id>
Tech Spec Refs: <refs>
Validation Question: <specific question>
Success Criteria: <what must be true>
Failure Criteria: <what would disprove>
Environment: <local config>
Cleanup Continuation: <auto | manual>
Checkpoint Commit: <on-success | always | never>
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