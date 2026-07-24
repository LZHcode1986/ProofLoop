# Executor Execute Slice Dispatch Contract

Dispatches a Worker to implement one Slice.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## Required fields

- Slice ID
- Slice Goal
- Observable Outcome
- Public Seam
- Authority Excerpts
- Dependency Output Summaries
- TDD Proof Plan
- Tasks
- Editable tasks.md Region
- Editable evidence.md Region
- Allowed Code Scope
- Forbidden Scope
- Stop Conditions

## Rules

- Worker receives only the Slice Packet, not the Stage Goal
- Worker must check off each Task immediately after implementation
- Worker must run full Slice TDD before writing Evidence
- Worker must overwrite Evidence (not append)

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/execute-slice.md
Slice ID:
Slice Goal:
Observable Outcome:
Public Seam:
Authority Excerpts: <refs>
Dependency Output Summaries: <summaries>
TDD Proof Plan:
  Primary Seam:
  Required Success Behaviors:
  Required Failure Behaviors:
  State Assertions:
  Mocks Allowed:
  Mocks Forbidden:
  Verification Commands:
  Proof Profiles:
Tasks:
  - [ ] Sx-T1
  - [ ] Sx-T2
Editable tasks.md Region: <markers>
Editable evidence.md Region: <markers>
Allowed Code Scope: <paths>
Forbidden Scope: <paths>
Stop Conditions: <blocker types>
Expected Result: READY_FOR_CV | <blocker>
```