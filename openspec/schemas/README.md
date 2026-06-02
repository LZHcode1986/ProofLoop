# OpenSpec Schemas

The active ProofLoop schema is:

```text
openspec/schemas/proofloop-spec-driven
```

New projects should use:

```yaml
schema: proofloop-spec-driven
```

## v3.3 schema direction

The schema supports:

- Brain Dispatch Contract preservation
- Slice Contracts
- per-slice Code Verifier gates
- CodeGraph anchors
- Required Review Skills
- task-diff-snapshot receipts
- slice-output commits
- archive-output commits

It does not use:

- P0/P1/P2 workflow levels
- default Reality Verifier
- document-completeness gates as implementation blockers

## Skill boundary

Schema instructions may add ProofLoop-specific artifact requirements, but should not rewrite OpenSpec canonical skill files.
