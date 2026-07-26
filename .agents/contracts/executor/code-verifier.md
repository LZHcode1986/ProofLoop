# Executor Code Verification Dispatch Contract

Dispatches adversarial verification to Code Verifier — two-phase: initial-refutation then evidence-comparison.

## Modes

| Mode | When to use |
|---|---|
| `initial-refutation` | Worker has completed a Slice and returned READY_FOR_CV; first phase, no Evidence content |
| `evidence-comparison` | Continuation of the same CV session after Phase A returns REFUTATION_COMPLETE |
| `recheck-refutation` | Worker has repaired a Slice after CV FAIL; first phase of fresh recheck |
| `recheck-evidence-comparison` | Continuation of same recheck CV session after recheck-refutation |

## initial-refutation specific fields

- Slice ID
- Slice Contract
- Covered Tasks
- Proof Plan
- Actual Diff
- Changed Code/Tests
- Verification Commands
- Authority Excerpts
- Out of Scope
- Evidence Location
- Evidence Region Marker
- Expected Result: REFUTATION_COMPLETE | Verification blocked

Must NOT include:
- Worker Evidence content
- Worker Statement
- Worker interpretation of results

## evidence-comparison specific fields

- Phase A Refutation Result
- Worker Evidence Full Content
- Worker Proof Profile Declarations
- Required Profile Evidence
- Expected Result: Verification passed | Verification failed | Verification blocked

## Recheck modes

Both recheck modes use the same field structure as their initial counterparts.

Executor supplies additionally:
- Previous Failed Criteria
- Concrete Counterexample
- Failure Signature
- Worker Fix
- Repair Diff
- Necessary Regression Scope

## Packet shape templates

### initial-refutation

```
Target Agent: code-verifier
Contract Ref: .agents/contracts/executor/code-verifier.md
Mode: initial-refutation
Slice ID: <same>
Slice Contract: <refs>
Covered Tasks: <list>
Proof Plan: <plan>
Actual Diff: <diff>
Changed Code/Tests: <paths>
Verification Commands: <commands>
Authority Excerpts: <refs>
Out of Scope: <scope>
Evidence Location: <location>
Evidence Region Marker: <marker>
Expected Result: REFUTATION_COMPLETE | Verification blocked
```

### evidence-comparison

```
Target Agent: code-verifier
Contract Ref: .agents/contracts/executor/code-verifier.md
Mode: evidence-comparison
Slice ID: <same>
Phase A Refutation Result: <result>
Worker Evidence Full Content: <evidence>
Worker Proof Profile Declarations: <profiles>
Required Profile Evidence: <evidence>
Expected Result: Verification passed | Verification failed | Verification blocked
```

## Fresh Agent rule

CV Phase A is always fresh. Executor must create a new CV session for every initial-refutation and recheck-refutation dispatch. CV sessions are never continued across different Slice verification cycles. Phase B uses continuation of the same session created in Phase A.
