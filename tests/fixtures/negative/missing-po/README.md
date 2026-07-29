# Negative Fixture: Missing Proof Obligation

A fixture that simulates a slice created without defining a Proof Obligation in tasks.md.

## Per-Slice Evidence

The single Slice S01-A has its own evidence file at `delivery/stages/S00-NOPO/evidence/S01-A.md`.

## What it tests

- Slice S01-A has no `## Proof Obligations` section
- Evidence exists with an empty Proof Obligation Coverage table

## Expected detection

A validity validator should flag this stage because:
- Slice S01-A is missing the Proof Obligation declaration
- The fixture checker reports `MISSING_PROOF_OBLIGATION`
