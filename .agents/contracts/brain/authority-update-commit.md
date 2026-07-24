# Brain Authority Update Commit Dispatch Contract

Dispatch a Git boundary for authority document updates to Committer.

## When to use

Authority documents (tech-spec/*) have been updated after Prototype validation or other authority changes.

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

## Required boundary fields

- Boundary Type: authority-update
- Description
- Changed Files

## Packet shape

```text
Route: committer
Objective: <commit authority update>
Continuation: <task_id | none>
Boundary Type: authority-update
Description: <what changed>
Changed Files: <list>
Allowed Scope: <tech-spec/>
Forbidden Scope: <delivery/, .opencode/, .agents/>
Acceptance Criteria: <commit created>
Verification Method: <git log>
Expected Evidence: <commit hash>
Authoritative Inputs: <none>
Constraints: <authority documents only>
Stop Conditions: <dirty worktree, scope violation>
Expected Result: <Boundary closed | Boundary blocked>
```