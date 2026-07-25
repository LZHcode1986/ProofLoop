# Executor Committer Dispatch Contract

Dispatches a slice-output commit to Committer.

## Mode

This contract supports only one Mode: `slice-output`.

## When to use

A Slice has passed CV and scope check, and is ready to be committed.

## Required fields

- Slice ID
- Stage ID
- Mode: slice-output
- Current CV Verdict: PASS
- Scope Check Result: PASS
- Scope Check Base Ref
- Changed Files
- Verification Result Reference

## Rules

- Stage only files relevant to the verified Slice
- Include tasks.md and evidence.md changes for the Slice region
- Fail if unrelated dirty files are present and cannot be separated
- Commit message: `slice-output: <stage-id>-<slice-id>`

## Packet shape

```
Target Agent: committer
Contract Ref: .agents/contracts/executor/committer.md
Mode: slice-output
Stage ID: <Sxx>
Slice ID: <Sxx-Sx>
Current CV Verdict: PASS
Scope Check Result: PASS
Scope Check Base Ref: <ref>
Changed Files: <list>
Verification Result Reference: <ref>
Expected Result: Boundary closed (returns commit hash) | Boundary blocked
```

## Fresh Agent rule

Committer is always fresh for each slice-output commit. Executor must create a new Committer for every dispatch.
