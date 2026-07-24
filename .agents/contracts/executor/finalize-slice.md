# Executor Finalize Slice Dispatch Contract

Dispatches a Worker to finalize a Slice when all Tasks are checked but Evidence is incomplete.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## When to use

All Tasks are checked off but the Evidence section is incomplete or missing. Worker must run the Slice TDD and write Evidence.

## Required fields

- Slice ID
- Current Slice Packet
- Current evidence.md Region

## Rules

- Worker runs the full Slice TDD suite
- Worker overwrites the Evidence section
- Worker does NOT modify Tasks or code
- Worker returns READY_FOR_CV

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/finalize-slice.md
Slice ID: <same>
Current Slice Packet: <original>
Current evidence.md Region: <markers>
Expected Result: READY_FOR_CV | BLOCKED
```