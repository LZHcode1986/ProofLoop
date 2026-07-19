# ProofLoop Install

This installer copies ProofLoop workflow assets into a target project.

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `-TargetProjectPath` | (required) | Path to the target project |
| `-EnableCodeGraph` | off | Show CodeGraph initialization guidance after install |
| `-InstallDeprecatedAliases` | off | Install deprecated `spec-verifier.md` compatibility alias |
| `-InstallCanonicalSkills` | off | Install missing canonical skills (default: skip all) |
| `-OverwriteCanonicalSkills` | off | Overwrite existing canonical skills (default: skip) |
| `-Force` | off | Skip version detection confirmation and dirty worktree check |

## Usage

```powershell
# Default install (core agents + contracts + schema, skip all canonical skills)
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project"

# Install missing canonical skills without overwriting existing ones
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project" -InstallCanonicalSkills

# Force past dirty worktree
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project" -Force

# Full install including deprecated aliases and skill overwrite
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project" -InstallDeprecatedAliases -OverwriteCanonicalSkills
```

## Rollback

If installation fails, the script automatically rolls back to the pre-installation state: existing files are restored from backup, newly created files are deleted, and empty directories are cleaned up.

## Important

Do not overwrite OpenSpec canonical skills or shared TDD skill unless explicitly requested with `-OverwriteCanonicalSkills`.

## Default installed files

```text
AGENTS.md.example
tech-spec.md.example
openspec/config.yaml.example
openspec/schemas/proofloop-spec-driven/**
scripts/local-check.sh
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

## Default NOT installed
```text
.omp/skills/**                            (use -InstallCanonicalSkills for missing, -OverwriteCanonicalSkills to overwrite)
```

ProofLoop now ships with `.omp/` configuration. `general.md` and `designer.md` are included as standard agents.

## Installed workflow

```text
Direct Task:
  Brain -> general -> Completion Receipt -> Brain self-check

OpenSpec Change:
  Brain -> Evidence Ledger Seed
        -> Propose (materialize ledger)
        -> Planning Contract Verifier
        -> Executor
        -> Worker
        -> Committer task-diff-snapshot
        -> Code Verifier per slice
        -> Committer slice-output
        -> Reconciliation Worker records Execution Summary
        -> Implementation Reviewer
        -> Brain archive authorization
        -> Executor -> Committer archive-output
```
