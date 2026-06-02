## Purpose
Define the behavioral standards for ProofLoop's rectified agent rules, supporting Proof Posture conditional verifier gating and rules lazy loading config.

## ADDED Requirements

### Requirement: Proof Posture conditional verifier gating
The `openspec-propose` skill and propose agents MUST respect the Proof Posture when verifying changes.
For P0 Fast Proof, it MUST NOT dispatch independent verifier subagents and MUST rely on self-check verification.

#### Scenario: P0 proposal verification
- **WHEN** Proof Posture is P0
- **THEN** Do not spawn spec-verifier or reality-verifier subagents.

### Requirement: Rules Lazy Loading config
The repository root MUST contain `opencode.json` with an instructions array that lists rules and quality gates to be lazy-loaded on demand.

#### Scenario: Agent loads rules
- **WHEN** Agent initialized
- **THEN** Context-heavy rules files are deferred and loaded on-demand per lazy loading rules in `AGENTS.md`.
