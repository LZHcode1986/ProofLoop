# Negative Fixture: Incomplete Worker

A fixture that simulates a Worker who has only partially completed the assigned tasks.

## What it tests

- Slice S1 is fully complete (all tasks checked)
- Slice S2 has one unchecked task (`S2-T2`)

## Expected detection

A completeness validator should flag S2 as incomplete because:
- Task `S2-T2` is not checked off
- Worker Status is `in-progress` rather than `complete`
