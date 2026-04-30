# Proposed `propose` Redesign

This document explains how to upgrade OpenSpec `propose` from repeated coverage checks into a proofability-first planning flow.

## Goal

- Make `propose` complete `proofability check` before `design`.
- Keep the real entry point, user path, authority source, false-completion definition, and proof method explicit.
- Prevent proposal, design, specs, and tasks from drifting apart.

## Recommended changes

1. Run `proofability check` immediately after `proposal.md`.
2. The check should confirm:
   - real entry point
   - user action order
   - authority source
   - explicit non-completion evidence
   - final validation method
3. Do not keep proposal coverage or design coverage as separate gates.
4. Run `tasks readiness check` after `tasks.md` is written to confirm apply readiness.
5. By default, run `tasks readiness check` with an independent `verifier` sub-agent.
6. Make the `propose` output state clearly show:
   - what is already satisfied
   - what must be written back into proposal / design / specs / tasks

## Recommended execution order

1. Read `config.yaml`
2. Read proposal
3. Run `proofability check`
4. Continue with design / specs / tasks
5. Run `tasks readiness check`
6. Enter `apply` only after the gate passes

## What to replace during migration

- the exact command names or skill names used by OpenSpec
- the project-specific document paths
- the project-specific authority names
- the project-specific verification commands

