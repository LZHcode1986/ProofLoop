# Stage Gate Fixture

A Stage fixture designed to validate the full Runtime Proof lifecycle (Stage Gate) execution.

## Per-Slice Evidence

The single Slice S01-A has its own evidence file at `delivery/stages/S00-GATE/evidence/S01-A.md`,
referenced via the Manifest `evidence_path` model.

## Contents

- `delivery/stages/S00-GATE/tasks.md` — Stage with one Slice and a complete `## Stage Runtime Proof` YAML section
- `delivery/stages/S00-GATE/evidence/S01-A.md` — Slice evidence for the Runtime Proof Slice

## Runtime Proof Steps

| Step ID    | Type           | Purpose                          |
|------------|----------------|----------------------------------|
| `build`    | `command`      | Simulate build step              |
| `app-start`| `service_start`| Start a minimal HTTP server      |
| `smoke`    | `probe`        | Probe that the server responds   |
| `app-stop` | `service_stop` | Stop the server via service_ref  |

## Purpose

This fixture validates that a stage with a well-formed Runtime Proof compiles, passes topology validation, and can be executed by the Stage Gate runner (`run-stage.ts`).
