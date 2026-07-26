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

- Previous Failed Criterion (singular, not "criteria")
- Concrete Counterexample
- Failure Signature
- Repair Diff (not "repair diff" or "Worker Fix")
- Required Regression Scope (not "necessary regression scope")

## Allowed results

```
Verification passed
Verification failed
Verification blocked
```

## Runtime Recovery Continuation

### Step 1: status-and-resume

Use when the original CV Session failed to return a final verdict.

Required continuation fields:

- Continuation Type: status-and-resume
- Previous Result: no final verdict due to interruption
- Changed Inputs: none | <list>
- Required Next Action

The CV must return one of:

1. **VERIFICATION_RESUMABLE** — verification state is reliable and can continue
   - Interruption Reason
   - Current Verification Checkpoint
   - Completed Verification Work
   - State Reliability: reliable
   - Whether Worker Evidence Was Read
   - Resume Safety: safe

2. **VERIFICATION_RESTART_REQUIRED** — cannot safely resume
   - Interruption Reason
   - Current Verification Checkpoint
   - State Reliability: reliable | unreliable
   - Whether Worker Evidence Was Read
   - Why Resume Is Unsafe

VERIFICATION_RESUMABLE and VERIFICATION_RESTART_REQUIRED are not verification verdicts.
They are allowed only as responses to status-and-resume.

### Step 2: resume-verification

Use only after receiving VERIFICATION_RESUMABLE.

Required continuation fields:

- Continuation Type: resume-verification
- Previous Result: VERIFICATION_RESUMABLE
- Required Next Action: resume from the reported checkpoint and return a final verdict

The CV must return one of:

1. Verification passed
2. Verification failed
3. Verification blocked
4. VERIFICATION_RESTART_REQUIRED
