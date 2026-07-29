# Continuation Fixture

A Stage fixture designed to simulate a partial-execution state for testing Agent Continuation Semantics.

## Per-Slice Evidence

Each Slice has its own evidence file under `delivery/stages/S00-CONT/evidence/<slice-id>.md`, referenced
via the Manifest `evidence_path` model. There is no shared stage-wide evidence file.

## Contents

- `delivery/stages/S00-CONT/tasks.md` — Stage with two Slices representing Planner completion and mid-Worker execution
- `delivery/stages/S00-CONT/evidence/` — Per-Slice evidence files:
  - `S01-A.md` — Completed slice, awaiting CV
  - `S01-B.md` — Worker is actively implementing

## Slice Map

| Slice | Worker Status   | Meaning                          |
|-------|-----------------|----------------------------------|
| S01-A | `ready-for-cv`  | Work complete, awaiting CV       |
| S01-B | `executing`     | Worker is actively implementing  |

## Purpose

This fixture validates that continuation logic (per AGENTS.md) correctly identifies slices by their Worker Status to determine whether a new or original Worker session is required.
