## Why
Fix the residual gap of ProofLoop rectification plan (P0 verifier conflict, Slice Contract metadata conflict, opencode.json lazy loading) and complete the OpenSpec change lifecycle for rectification alignment.

## Minimum Closed Loop
Make the local changes, complete the self-check verification, pass `openspec validate --strict`, and successfully archive the change to create visible closed loop proof.

## Scope

### In Scope
- Modify `openspec-propose` skill to respect Proof Posture (P0 self-check and no-dispatch).
- Update task metadata rules to support Slice Contract overrides and setup/blocking/reconciliation tasks.
- Create `opencode.json` with instructions lazy loading and document in `AGENTS.md`.
- Create and archive `proofloop-rectification` change to complete the lifecycle loop.

### Out of Scope
- Rewriting core OpenSpec CLI.
- Database migrations.

## Acceptance Criteria
- AC-1: P0 Fast Proof does not dispatch independent verifiers and relies on self-check.
- AC-2: Slice Contract metadata redundancy is removed; setup/blocking/reconciliation tasks only require basic scope and command.
- AC-3: `opencode.json` is present and instructions lazy loading is documented in `AGENTS.md`.
- AC-4: This change `proofloop-rectification` is successfully validated and archived.

## Risks
None.

## Reality Snapshot
Local testing through manual commands.

## Critical Runtime Assumptions
- [Assumption 1]: opencode.json configuration loads instructions: confirmed
  - Code Anchor: [opencode.json](file:///D:/software-dev/ProofLoop/opencode.json)
