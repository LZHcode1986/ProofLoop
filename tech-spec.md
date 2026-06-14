# ProofLoop Technical Spec v1 Evidence Ledger Edition

## Core architecture

ProofLoop has two active routes:

```text
direct-task
openspec-change
```

## Direct Task

Used for small changes that do not require formal OpenSpec artifacts.

```text
Brain -> general -> Completion Receipt -> Brain self-check
```

Direct Task does not use Evidence Ledger by default.
Only when Brain or user explicitly requires audit evidence.

## OpenSpec Change

Used for formal changes that require planning, execution, verification, and archive.

```text
Brain creates Evidence Ledger Seed.
Propose materializes proofloop/evidence-ledger.md.
Planning Contract Verifier checks artifact contract fidelity.
Executor dispatches Reconciliation to record execution evidence in the ledger.
Worker returns structured Completion Receipt (Contract Echo + Skill Evidence).
Committer records task-diff-snapshot after each Worker task.
Code Verifier checks assigned slice evidence (not just test green).
Committer commits slice-output after verifier PASS.
Implementation Reviewer performs stage acceptance from full ledger.
Brain authorizes archive.
Implementation Reviewer executes archive.
Committer commits archive-output if needed.
```

Evidence Ledger is the delivery evidence spine for OpenSpec Change.
It records contract snapshots, execution receipts, verification results, stage review, and archive result.
It does not introduce new requirements.

## Protocol rules

- R1. Declared Contract Rule: binding commitments must be mapped, verified, deferred, marked non-binding, or blocked.
- R2. Contract Echo Rule: every agent output echoes how it handled the upstream contract.
- R3. Skill Evidence Rule: required skills must produce structured evidence; skill name alone is not evidence.
- R4. Evidence Sufficiency Rule: Code Verifier PASS requires 7 conditions (AC covered, verification method executed, expected evidence present, skill evidence present, boundary receipts present, no unresolved conflicts, scope/CodeGraph satisfied).
- R5. Gate Classification Rule: IMPLEMENTATION / EVIDENCE / CONTRACT / PROTOCOL defects.
- R6. No Invention Rule: verifier must not invent upstream-undeclared requirements.

## Skill boundary

OpenSpec canonical skills and TDD skill are not modified by ProofLoop.

ProofLoop-specific usage rules live in:

```text
.agents/contracts/proofloop-skill-usage.md
```

## CodeGraph

CodeGraph is an optional code-reality lookup tool.

See `AGENTS.md` for usage guidance.

## Git boundaries

```text
task -> task-diff-snapshot receipt
slice verifier PASS -> slice-output commit
archive -> archive-output commit
```

Committer closes boundaries. Committer does not decide task completion.
