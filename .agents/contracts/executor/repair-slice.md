# Executor Repair Slice Dispatch Contract

Dispatches a Worker to repair a Slice after CV FAIL.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## When to use

CV returned Verification failed. Worker must fix the specific failure.

## Required fields

- Slice ID
- Failed CV criteria
- Concrete counterexample
- Failure signature
- Original Slice Packet
- Fix Mode: repair

## Rules

- Worker fixes only the listed failure
- Worker runs full Slice TDD again
- Worker overwrites Evidence (does not append history)
- Tasks remain checked (CV FAIL does not uncheck)
- Worker returns READY_FOR_CV

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/repair-slice.md
Slice ID: <same>
Fix Mode: repair
Failed Criteria: <list>
Concrete Counterexample: <description>
Failure Signature: <signature>
Original Slice Packet: <original>
Expected Result: READY_FOR_CV | <blocker>
```