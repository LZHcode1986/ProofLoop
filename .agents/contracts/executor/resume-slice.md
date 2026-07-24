# Executor Resume Slice Dispatch Contract

Resumes a Worker on an interrupted Slice where the same task_id is available.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## When to use

Worker tool call was interrupted but the same task_id and context are recoverable.

## Required fields

- Slice ID
- Current Slice Packet
- Checked Tasks
- Unchecked Tasks
- Current code/tests state
- Recent Diff

## Rules

- Worker resumes from the first unchecked Task
- Worker does not redo checked Tasks
- Worker verifies checked Tasks match code reality

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/resume-slice.md
Slice ID: <same>
Current Slice Packet: <original>
Checked Tasks: <list>
Unchecked Tasks: <list>
Current Code State: <diff>
Expected Result: READY_FOR_CV | <blocker>
```