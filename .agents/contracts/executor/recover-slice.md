# Executor Recover Slice Dispatch Contract

Creates a Recovery Worker for a Slice when the original context is lost.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## When to use

Original Worker context is lost and cannot be resumed. A new Worker must verify checked Tasks and continue.

## Required fields

- Slice ID
- Current Slice Packet
- Current tasks/evidence regions
- Current code/tests
- Checked Tasks
- Unchecked Tasks
- Recent Diff
- Interruption Description

## Rules

- Recovery Worker checks checked Tasks against code reality
- Recovery Worker does NOT redo checked work by default
- Recovery Worker continues from first unchecked Task
- If checked Tasks are inconsistent with code, return BLOCKED

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/recover-slice.md
Slice ID: <same>
Current Slice Packet: <original>
Current tasks.md Region: <markers>
Current evidence.md Region: <markers>
Checked Tasks: <list>
Unchecked Tasks: <list>
Recent Diff: <diff>
Interruption Description: <what happened>
Expected Result: READY_FOR_CV | BLOCKED | <blocker>
```