# Continuation Fixture

A Stage fixture designed to simulate a partial-execution state for testing Agent Continuation Semantics.

## Contents

- `tasks.md` — Stage with two Slices representing Planner completion and mid-Worker execution
- `evidence.md` — Empty placeholder template

## Slice Map

| Slice | Worker Status   | Meaning                          |
|-------|-----------------|----------------------------------|
| S01-A | `ready-for-scv` | Work complete, awaiting SCV      |
| S01-B | `executing`     | Worker is actively implementing  |

## Purpose

This fixture validates that continuation logic (per AGENTS.md) correctly identifies slices by their Worker Status to determine whether a new or original Worker session is required.
