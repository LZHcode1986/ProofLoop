# Manual Install

Copy files into the target project preserving paths.

## Do not overwrite canonical skills

Do not overwrite these files unless explicitly approved:

```text
.omp/skills/openspec-propose/SKILL.md
.omp/skills/openspec-apply-change/SKILL.md
.omp/skills/openspec-archive-change/SKILL.md
.omp/skills/test-driven-development/SKILL.md
```

## Required root files

```text
AGENTS.md.example
tech-spec.md.example
openspec/config.yaml.example
```

## Required agents

```text
.omp/agents/code-verifier.md
.omp/agents/committer.md
.omp/agents/designer.md
.omp/agents/executor.md
.omp/agents/general.md
.omp/agents/implementation-reviewer.md
.omp/agents/planning-contract-verifier.md
.omp/agents/propose.md
.omp/agents/web-scraper.md
.omp/agents/worker.md
```

ProofLoop now ships with `.omp/` configuration. All agent files are in `.omp/agents/`.

ProofLoop no longer includes deprecated agents (`spec-verifier`, `reality-verifier`, `reality-verifier-codegraph`).

## Required contracts

```text
.agents/contracts/brain/external-research.md
.agents/contracts/brain/general-edit.md
.agents/contracts/brain/propose.md
.agents/contracts/brain/execute.md
.agents/contracts/brain/stage-review.md
.agents/contracts/executor/git-boundary.md
.agents/contracts/executor/worker-implementation.md
.agents/contracts/executor/worker-fix.md
.agents/contracts/executor/code-verification.md
.agents/contracts/executor/shared-worker-rules.md
.agents/contracts/proof-profiles.md
```

## Required schema

```text
openspec/schemas/proofloop-spec-driven/**
```

Set:

```yaml
schema: proofloop-spec-driven
```

## Rollback behavior

The PowerShell installer (`install-proofloop.ps1`) automatically rolls back on failure:

- Files that existed before installation are restored from backup.
- Files that were newly created during installation are deleted.
- Empty directories created by the installer are cleaned up.

If you install manually and need to roll back, delete the files listed in the "Required" sections above that did not exist before installation.

## Direct Task without physical ledger

When using Direct Task without `Evidence Ledger: required: yes`, the Completion Receipt should include:

```text
AC coverage:
Files changed:
Commands run:
Verification result:
Acceptance evidence:
Stop conditions:
Upgrade required:
Residual risk:
```
