# Stage Gate Fixture

A Stage fixture designed to validate the full Runtime Proof lifecycle (Stage Gate) execution.

## Contents

- `tasks.md` — Stage with one Slice and a complete `## Stage Runtime Proof` YAML section
- `evidence.md` — Empty placeholder template

## Runtime Proof Steps

| Step ID    | Type           | Purpose                          |
|------------|----------------|----------------------------------|
| `build`    | `command`      | Simulate build step              |
| `app-start`| `service_start`| Start a minimal HTTP server      |
| `smoke`    | `probe`        | Probe that the server responds   |
| `app-stop` | `service_stop` | Stop the server via service_ref  |

## Purpose

This fixture validates that a stage with a well-formed Runtime Proof compiles, passes topology validation, and can be executed by the Stage Gate runner (`run-stage.ts`).
