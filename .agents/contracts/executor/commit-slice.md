# Executor Commit Slice Dispatch Contract

Dispatches a slice-output commit to Committer.

## Dispatch Envelope Mode

This contract is read by Committer only when Executor supplies the path as `Contract Ref`.

## When to use

A Slice has passed CV and scope check, and is ready to be committed.

## Required fields

- Slice ID
- Stage ID
- Changed files
- Current CV Verdict: PASS
- Scope Check Result: PASS
- Scope Check Base Ref:
- Verification Result Reference:

## Rules

- Stage only files relevant to the verified Slice
- Include tasks.md and evidence.md changes for the Slice region
- Fail if unrelated dirty files are present and cannot be separated
- Commit message: `slice-output: <stage-id>-<slice-id>`

## Packet shape

```text
Target Agent: committer
Contract Ref: .agents/contracts/executor/commit-slice.md
Boundary Type: slice-output
Stage ID: <Sxx>
Slice ID: <Sxx-Sx>
Changed Files: <list>
Verification Result Reference: <ref>
Expected Result: Boundary closed | Boundary blocked
```