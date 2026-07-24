# Executor Diagnostic Repair Dispatch Contract

Dispatches a Worker to perform root-cause diagnosis and repair after standard repair fails.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## When to use

Standard repair failed. Worker must load `diagnose` skill, find root cause, and fix.

## Required fields

- Slice ID
- Previous CV failures (initial + recheck #1)
- Previous repair attempts
- Failure signature
- Original Slice Packet
- Fix Mode: diagnose

## Diagnostic repair requirements

1. Reproduce the failure
2. Find the minimum failure path
3. Distinguish symptoms from root cause
4. Check real production call chain
5. Check for workarounds
6. Explain why original test did not find the issue
7. Fix root cause
8. Add necessary regression proof
9. Update Evidence

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/diagnostic-repair.md
Slice ID: <same>
Fix Mode: diagnose
Failed Attempts:
  - repair-1: <action, result>
  - recheck-1: <result>
Failure Signature: <signature>
Original Slice Packet: <original>
Required Skills: <diagnose>
Expected Result: READY_FOR_CV | <blocker>
```