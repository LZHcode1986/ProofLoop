# Executor Committer Dispatch Contract

Dispatches a slice-output commit to Committer.

## Target Agent

- **Agent route:** `committer`

## Mode

This contract supports only one Mode: `slice-output`.

## When to use

A Slice has passed CV and is ready to be committed.

Preconditions (all must be true):

- Current CV Verdict = `PASS`
- CV PASS receipt contains `scope_violations: []` (the receipt-backed scope
  outcome is validated as part of Committer and Integration/post-merge closure;
  there is no standalone scope action)
- `derive-next-action` returns `committer`
- Changed files are identified
- Slice Evidence is finalized
- No other slice commit is in progress

## Required fields

- **Slice ID**
- **Stage ID**
- **Mode**: `slice-output`
- **Contract Ref**: `.agents/contracts/executor/committer.md`
- **Current CV Verdict**: `PASS`
- **Scope Outcome**: receipt-backed `PASS` (`scope_violations: []`), to be
  validated against the changed-file boundary during Committer and
  Integration/post-merge closure
- **Changed Files** (list of file paths to be committed)
- **Verification Result Reference** (CV receipt path or reference)

## Commit scope

Committer stages and commits exactly:

1. **Changed code and tests** — files modified by the Worker that are in scope
2. **`tasks.md`** — the stage tasks file, with the current Slice's checkbox(es)
   checked and Worker Status updated
3. **Slice Evidence** — the current Slice Evidence file at its Manifest-declared
   `evidence_path`
4. **CV Receipt** — the immutable CV receipt JSON for this verification round

Evidence committed for a slice-output:

- Updated `tasks.md` with this Slice's checked boxes
- Updated Slice Evidence with final Task Evidence and Current Slice Evidence
- CV Receipt reference (included as a committed receipt file)

## Rules

- Stage only files relevant to the verified Slice
- Include `tasks.md` changes only for the current Slice region
- Include the Slice Evidence file at its Manifest-declared `evidence_path`
- Fail if unrelated dirty files are present and cannot be separated
- Commit message: `slice-output: <stage-id>-<slice-id>`

## Packet shape

```yaml
Target Agent: committer
Contract Ref: .agents/contracts/executor/committer.md
Mode: slice-output
Stage ID: <Sxx>
Slice ID: <Sxx-Sx>
Current CV Verdict: PASS
Scope Outcome: receipt-backed PASS (`scope_violations: []`)
Changed Files: <list>
Evidence Path: <manifest evidence_path for this slice>
CV Receipt Path: <path to CV receipt JSON>
Expected Result: Boundary closed (returns commit hash) | Boundary blocked
```

## Session continuation rule

Session IDs are runtime relay information only; they are not Contract fields and
must not be persisted in manifests, tasks, Evidence, receipts, progress, or Git
history.

Committer is fresh for each new slice-output boundary. Continuation is allowed
only when the same unchanged Git boundary suffers a pure runtime interruption:
HEAD, index, worktree, and changed-file list must all be unchanged. Any other
interruption or any Git/input change requires a fresh Committer.

## Error handling

| Condition | Result |
|---|---|
| Unrelated dirty files present and inseparable | `Boundary blocked` |
| Git add/commit fails | `Boundary blocked` with reason |
| Precondition not met (no CV PASS) | `Boundary blocked` |
| Commit succeeds | `Boundary closed (commit hash: <hash>)` |
