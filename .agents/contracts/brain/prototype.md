# Brain Prototype Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a local technical experiment to Prototype.

## Use when

A technical question requires local validation in an isolated worktree before it can be accepted into Tech Spec.

## Target-specific required fields

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
- External Research Status:
  - not-required
  - already-provided
  - return-research-required

## Expected results

VALIDATED, REJECTED, INCONCLUSIVE, or RESEARCH_REQUIRED.

When RESEARCH_REQUIRED is returned, Brain dispatches Researcher, validates result, then continues the original Prototype session.

## Stop routing

- TECHNICAL_UNKNOWN → Brain dispatches Researcher, continues original task_id
- PROTOTYPE_BLOCKED → Brain evaluates whether to defer Hard Part

## Packet

```text
Target Agent: prototype
Contract Ref: .agents/contracts/brain/prototype.md
Objective: <validate technical question>
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
External Research Status: not-required
Allowed Scope: <prototype/ experiment/ throwaway/>
Forbidden Scope: <production code paths>
Acceptance Criteria: <clear result>
Verification Method: <run experiment>
Expected Evidence: <experiment results>
Authoritative Inputs: <refs>
Constraints: <limits>
Stop Conditions: <when to stop>
Expected Result: <VALIDATED | REJECTED | INCONCLUSIVE | RESEARCH_REQUIRED | BLOCKED>
```
