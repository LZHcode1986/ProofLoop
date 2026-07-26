# Executor Code Verification Dispatch Contract

Dispatches adversarial verification to Code Verifier.

## Verification Type

| Type | When to use |
|---|---|
| `initial` | Worker has completed a Slice and returned READY_FOR_CV |
| `recheck` | Worker has repaired or diagnosed after CV FAIL |

## Required fields (all types)

- Slice ID
- Verification Type
- Slice Contract
- Covered Tasks
- Proof Plan
- Actual Diff
- Changed Code / Tests
- Verification Commands
- Authority Excerpts
- Out of Scope
- Evidence Location
- Evidence Region Marker

## Recheck additional fields

- Previous Failed Criterion
- Concrete Counterexample
- Failure Signature
- Repair Diff
- Required Regression Scope

## Allowed results

```
Verification passed
Verification failed
Verification blocked
```

## Runtime Recovery Continuation

Use only when the original CV Session failed to return a final verdict.

Required continuation fields:

- Continuation Type: status-and-resume
- Previous Result: no final verdict due to interruption
- Changed Inputs: none | <list>
- Required Next Action

The CV must return either:

1. A final verification result:
   - Verification passed
   - Verification failed
   - Verification blocked

or:

2. A restart request:
   - VERIFICATION_RESTART_REQUIRED

VERIFICATION_RESTART_REQUIRED must include:
   - Interruption Reason
   - Current Verification Checkpoint
   - State Reliability: reliable | unreliable
   - Whether Worker Evidence Was Read
   - Why Resume Is Unsafe

VERIFICATION_RESTART_REQUIRED is not a verification verdict.
It is allowed only as a response to status-and-resume continuation and causes
Executor to create a fresh CV.
