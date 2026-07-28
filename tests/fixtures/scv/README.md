# SCV Risk Fact Fixture

A Stage fixture designed to validate the SCV (Slice Code Verification) level computation.

## Contents

- `tasks.md` — Stage with three Slices that each test a different SCV level outcome
- `evidence.md` — Empty placeholder template

## Slice Map

| Slice   | Risk Facts                          | Expected SCV Level |
|---------|-------------------------------------|--------------------|
| S01-A   | `none`                              | `lite`             |
| S01-B   | `persistent_state`, `authorization` | `enhanced`         |
| S02-A   | `public_api_change`                 | `standard`         |

## Purpose

This fixture validates that `computeScvLevel()` in `compute-scv-level.ts` correctly maps Risk Facts to their corresponding SCV levels per the contract-state-matrix.
