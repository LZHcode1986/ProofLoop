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


