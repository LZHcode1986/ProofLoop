# Executor Code Verification Initial Dispatch Contract

Dispatches initial adversarial verification to Code Verifier.

## Dispatch Envelope Mode

This contract is read by Code Verifier only when Executor supplies the path as `Contract Ref`.

## When to use

A Worker has completed a Slice and returned READY_FOR_CV. Initial verification is needed.

## Required fields

- Slice ID
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

## Verification flow

1. Read Slice Contract, covered Tasks, TDD Proof Plan, actual code, tests, diff
2. Before reading Worker Evidence, independently identify likely counterexamples
3. Execute refutation attempts
4. Then read Worker Evidence and Proof Profile declarations
5. Add profile-specific refutation
6. Compare Worker claims against actual results
7. Return verdict

## Packet shape

```text
Target Agent: code-verifier
Contract Ref: .agents/contracts/executor/code-verification-initial.md
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
Mode: initial
Expected Result: Verification passed | Verification failed | Verification blocked
```