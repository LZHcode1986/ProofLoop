# Executor Code Verification Recheck Dispatch Contract

Dispatches a narrow recheck to Code Verifier after Worker repair.

## Dispatch Envelope Mode

This contract is read by Code Verifier only when Executor supplies the path as `Contract Ref`.

## When to use

A Worker has repaired a Slice after CV FAIL. A fresh narrow recheck is needed.

## Required fields

- Slice ID
- Previous failed criteria
- Concrete counterexample
- Failure signature
- Worker Fix
- Repair diff
- Necessary regression scope

## Recheck rules

- CV is fresh for every invocation (no context reuse)
- Verify only: previous failed criteria, repair changes, necessary regression
- Do NOT restart full Slice verification unless the repair changed Slice boundary, authority refs, or verification context
- If orchestration session is lost, rerun initial CV (no receipt file)

## Packet shape

```text
Target Agent: code-verifier
Contract Ref: .agents/contracts/executor/code-verification-recheck.md
Slice ID: <same>
Previous Failed Criteria: <list>
Concrete Counterexample: <description>
Failure Signature: <signature>
Worker Fix: <description>
Repair Diff: <diff>
Necessary Regression Scope: <scope>
Mode: recheck
Expected Result: Verification passed | Verification failed | Verification blocked
```