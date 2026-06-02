# ProofLoop Technical Spec v3.3

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

## OpenSpec Change

Used for formal SDD changes.

```text
Brain -> Propose
      -> Planning Contract Verifier
      -> Executor
      -> Worker
      -> Committer task-diff-snapshot
      -> Code Verifier per slice
      -> Committer slice-output
      -> Implementation Reviewer
      -> Archive
```

## Skill boundary

OpenSpec canonical skills and TDD skill are not modified by ProofLoop v3.3.

ProofLoop-specific usage rules live in:

```text
.agents/contracts/proofloop-skill-usage.md
```

## CodeGraph

CodeGraph is a tool protocol, not an agent.

## Git boundaries

Commit at verified boundaries.

```text
task -> receipt
slice -> commit after verifier PASS
archive -> separate commit
```
