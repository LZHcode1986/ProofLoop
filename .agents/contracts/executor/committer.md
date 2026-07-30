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
- **Manifest Digest** — SHA-256 digest of the compiled Stage Manifest
- **Verified Snapshot** — content snapshot from the CV PASS receipt (must match
  `CV receipt.snapshot`)
- **CV Receipt canonical path** — the absolute/resolved path to the CV PASS
  receipt file, already validated to be under the canonical receipt directory
- **Expected Committer Receipt root** — the canonical root directory for
  Committer receipts
  (`.proofloop/receipts/committer/<stage-id>/<slice-id>/`)
- **Pre-commit HEAD** — the 40-character Git commit SHA of HEAD before the
  slice-output commit

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
- **Committer does not authorize Slice COMPLETE.** A persisted
  `SliceCommitReceipt` written by the deterministic Runtime is required to
  advance the Slice past Committer. The structured return from Committer is
  the input to that Runtime writer; it is not itself a completion signal.

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
Manifest Digest: <SHA-256 of compiled Stage Manifest>
Verified Snapshot: <content snapshot from CV PASS receipt>
Expected Committer Receipt root: .proofloop/receipts/committer/<stage-id>/<slice-id>/
Pre-commit HEAD: <40-char sha>
Expected Result:
  result: BOUNDARY_CLOSED | BLOCKED
  stage_id: <Sxx>
  slice_id: <Sxx-Sx>
  pre_commit_head: <40-char sha>
  slice_commit_sha: <40-char sha>
  commit_message: "slice-output: <stage-id>-<slice-id>"
  changed_files:
    - <path>
  cv_receipt_ref: <CV receipt canonical path>
  verified_snapshot: <same as CV receipt snapshot>
  evidence_path: <manifest evidence_path for this slice>
  tasks_path: delivery/stages/<stage-id>/tasks.md
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
| Unrelated dirty files present and inseparable | `result: BLOCKED` |
| Git add/commit fails | `result: BLOCKED` with reason |
| Precondition not met (no CV PASS) | `result: BLOCKED` |
| Pre-execution check fails | `result: BLOCKED` with reason |
| Commit succeeds | structured YAML with `result: BOUNDARY_CLOSED` (see expected result) |
