# Executor Code Verification Dispatch Contract

Dispatches adversarial verification to Code Verifier — initial or recheck.

## Modes

| Mode | When to use |
|---|---|
| `initial` | Worker has completed a Slice and returned READY_FOR_CV |
| `recheck` | Worker has repaired a Slice after CV FAIL |

## Common fields

Both Modes include:

- Slice ID
- Mode
- Expected Result: Verification passed | Verification failed | Verification blocked

## Initial-specific fields

- Slice Contract
- Covered Tasks
- TDD Proof Plan
- Actual Diff
- Changed Code/Tests
- Verification Commands
- Authority Excerpts
- Proof Profiles
- Worker Evidence
- Out of Scope

## Recheck-specific fields (additional)

- Previous Failed Criteria
- Concrete Counterexample
- Failure Signature
- Worker Fix
- Repair Diff
- Necessary Regression Scope

## Verification flow (initial)

1. Read Slice Contract, covered Tasks, TDD Proof Plan, actual code, tests, diff
2. Before reading Worker Evidence, independently identify likely counterexamples
3. Execute refutation attempts
4. Then read Worker Evidence and Proof Profile declarations
5. Add profile-specific refutation
6. Compare Worker claims against actual results
7. Return verdict

## Recheck rules

- CV is fresh for every invocation (no context reuse)
- Verify only: previous failed criteria, repair changes, necessary regression
- Do NOT restart full Slice verification unless the repair changed Slice boundary, authority refs, or verification context
- If orchestration session is lost, rerun initial CV (no receipt file)

## Packet shape templates

### initial

```
Target Agent: code-verifier
Contract Ref: .agents/contracts/executor/code-verifier.md
Mode: initial
Slice ID: <same>
Slice Contract: <refs>
Covered Tasks: <list>
TDD Proof Plan: <plan>
Actual Diff: <diff>
Changed Code/Tests: <paths>
Verification Commands: <commands>
Authority Excerpts: <refs>
Proof Profiles: <profiles>
Worker Evidence: <evidence>
Out of Scope: <scope>
Expected Result: Verification passed | Verification failed | Verification blocked
```

### recheck

```
Target Agent: code-verifier
Contract Ref: .agents/contracts/executor/code-verifier.md
Mode: recheck
Slice ID: <same>
Previous Failed Criteria: <list>
Concrete Counterexample: <description>
Failure Signature: <signature>
Worker Fix: <description>
Repair Diff: <diff>
Necessary Regression Scope: <scope>
Expected Result: Verification passed | Verification failed | Verification blocked
```
