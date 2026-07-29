# CV (Code Verifier) Risk Fact Fixture

A Stage fixture designed to validate the CV (Code Verifier) level computation.

## Per-Slice Evidence

Each Slice has its own evidence file under `delivery/stages/S00-CV/evidence/<slice-id>.md`, referenced
via the Manifest `evidence_path` model. There is no shared stage-wide evidence file.

## Contents

- `delivery/stages/S00-CV/tasks.md` — Stage with three Slices that each test a different CV level outcome
- `delivery/stages/S00-CV/evidence/` — Per-Slice evidence files:
  - `S01-A.md` — No risk facts → `lite`
  - `S01-B.md` — `persistent_state`, `authorization` → `enhanced`
  - `S02-A.md` — `public_api_change` → `standard`

## Slice Map

| Slice   | Risk Facts                          | Expected CV Level |
|---------|-------------------------------------|--------------------|
| S01-A   | `none`                              | `lite`             |
| S01-B   | `persistent_state`, `authorization` | `enhanced`         |
| S02-A   | `public_api_change`                 | `standard`         |

## Purpose

This fixture validates that `computeCvLevel()` in `compute-cv-level.ts` correctly maps Risk Facts to their corresponding CV levels per the contract-state-matrix.
