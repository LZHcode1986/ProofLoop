# Negative Fixture: Missing Observable Outcomes

A fixture that simulates a stage created without defining Observable Outcomes in the tasks.md header.

## What it tests

- The Stage heading has no `## Observable Outcomes` section
- Slice S1 has an intentionally blank Observable Outcome
- Evidence.md exists but has no traceable OUT-* references

## Expected detection

A validity validator should flag this stage because:
- The Stage header is missing the `## Observable Outcomes` section
- Slice S1 has no observable outcome defined
- No OUT-* identifiers exist anywhere in the stage
