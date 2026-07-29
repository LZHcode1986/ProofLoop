# Negative Fixture: Incomplete Worker

A fixture that simulates a Worker who has only partially completed the assigned tasks.

## Per-Slice Evidence

Each Slice has its own evidence file under `delivery/stages/S00-INCOMPLETE/evidence/<slice-id>.md`:
- `delivery/stages/S00-INCOMPLETE/evidence/S01-A.md` — Completed slice S01-A
- `delivery/stages/S00-INCOMPLETE/evidence/S01-B.md` — Partially completed slice S01-B

## What it tests

- Slice S01-A is fully complete (all tasks checked)
- Slice S01-B has one unchecked task (`S01-B-T2`)

## Expected detection

A completeness validator should flag S01-B as incomplete because:
- Task `S01-B-T2` is not checked off
- Worker Status is `in-progress` rather than `complete`
