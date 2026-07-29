# Positive Fixture

A minimal but complete Stage workspace that follows the current `tasks.md` and per-Slice `evidence/<slice-id>.md` templates.

## Per-Slice Evidence

The single Slice S00-A has its own evidence file at `delivery/stages/S00-POS/evidence/S00-A.md`,
referenced via the Manifest `evidence_path` model.

## Contents

- `delivery/stages/S00-POS/tasks.md` — Contains Stage Goal, Observable Outcomes, one Slice (S00-A) with one task
- `delivery/stages/S00-POS/evidence/S00-A.md` — Per-Slice evidence for Slice S00-A

## Purpose

This fixture validates that a correctly structured stage passes all structural validators.
It is the baseline "happy path" for ProofLoop stage acceptance.
