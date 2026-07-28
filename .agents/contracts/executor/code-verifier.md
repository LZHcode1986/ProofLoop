# Executor SCV Dispatch Contract

Dispatches adversarial verification to Slice Challenge Verifier (SCV).

## Verification Type

| Type | When to use |
|---|---|
| `initial` | Worker has completed a Slice and returned READY_FOR_CV |
| `recheck` | Worker has repaired after SCV REPAIR verdict (or replanned after REPLAN) |

## Required fields (all types)

- Slice ID
- Verification Type
- SCV Level (Lite | Standard | Enhanced)
- Manifest Digest
- Snapshot
- Slice Contract
- Covered Tasks
- Proof Plan
- Proof Obligations
- Risk Facts
- mandatory Profiles
- PO Coverage Matrix
- Scope Gate result
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

**Mandatory initial SCV on structural change**: If the Contract, Goal, Seam, PO, or Authority has changed since the previous verification, the Executor MUST dispatch an initial SCV (not a narrow recheck). A narrow recheck is only valid when the only changes are the repair itself and the previous failure context.

## Allowed results

```
PASS
REPAIR
REPLAN
BLOCKED
ESCALATION_REQUIRED
```

## Runtime Recovery Continuation

Continuation is only allowed when ALL of the following hold:
- the original SCV Session inputs are completely unchanged;
- the interruption was a pure runtime interruption (no input change);
- the independent refutation ordering is still known and trustworthy.

If any condition is not met, dispatch a fresh initial SCV instead.

### Step 1: status-and-resume

Use when the original SCV Session failed to return a final verdict due to pure runtime interruption.

Required continuation fields:

- Continuation Type: status-and-resume
- Previous Result: no final verdict due to interruption
- Changed Inputs: none
- Required Next Action

The SCV must return one of:

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

VERIFICATION_RESUMABLE and VERIFICATION_RESTART_REQUIRED are not SCV verdicts.
They are allowed only as responses to status-and-resume when continuation conditions are met.

### Step 2: resume-verification

Use only after receiving VERIFICATION_RESUMABLE.

Required continuation fields:

- Continuation Type: resume-verification
- Previous Result: VERIFICATION_RESUMABLE
- Required Next Action: resume from the reported checkpoint and return a final verdict

The SCV must return one of:

1. PASS
2. REPAIR
3. REPLAN
4. BLOCKED
5. ESCALATION_REQUIRED
6. VERIFICATION_RESTART_REQUIRED
