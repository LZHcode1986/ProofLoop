# ProofLoop Install

This installer copies ProofLoop workflow assets into a target project.

## Parameters

| Parameter | Default | Description |
|---|---|---|
| `-TargetProjectPath` | (required) | Path to the target project |
| `-EnableCodeGraph` | off | Show CodeGraph initialization guidance after install |
| `-InstallGeneralAgent` | off | Install optional `general.md` agent (not installed by default) |
| `-InstallDeprecatedAliases` | off | Install deprecated `spec-verifier.md` compatibility alias |
| `-OverwriteCanonicalSkills` | off | Overwrite canonical skills (default: skip with warning) |
| `-Force` | off | Skip version detection confirmation and dirty worktree check |

## Usage

```powershell
# Default install (core agents + contracts + schema, skip existing skills)
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project"

# Install with general agent and force past dirty worktree
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project" -InstallGeneralAgent -Force

# Full install including deprecated aliases and skill overwrite
.\install\install-proofloop.ps1 -TargetProjectPath "C:\path\to\project" -InstallDeprecatedAliases -OverwriteCanonicalSkills
```

## Rollback

If installation fails, the script automatically rolls back to the pre-installation state: existing files are restored from backup, newly created files are deleted, and empty directories are cleaned up.

## Important

Do not overwrite OpenSpec canonical skills or shared TDD skill unless explicitly requested with `-OverwriteCanonicalSkills`.

## Default installed files

```text
AGENTS.md
README.md
openspec/QUALITY-GATE.md
openspec/config.yaml.example
openspec/schemas/proofloop-spec-driven/**
.opencode/agents/brain.md
.opencode/agents/propose.md
.opencode/agents/executor.md
.opencode/agents/worker.md
.opencode/agents/code-verifier.md
.opencode/agents/planning-contract-verifier.md
.opencode/agents/implementation-reviewer.md
.opencode/agents/committer.md
.opencode/agents/web-scraper.md
.agents/contracts/dispatch-packets.md
.agents/contracts/executor-dispatch-packets.md
.agents/contracts/codegraph-tool-protocol.md
.agents/contracts/proofloop-skill-usage.md
```

## Default NOT installed

```text
.opencode/agents/general.md              (use -InstallGeneralAgent)
.opencode/agents/reality-verifier.md     (deprecated)
.opencode/agents/reality-verifier-codegraph.md (deprecated)
.opencode/agents/spec-verifier.md        (use -InstallDeprecatedAliases)
.agents/skills/**                        (use -OverwriteCanonicalSkills)
```

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
        -> Implementation Reviewer
        -> Brain archive authorization
        -> Executor -> Committer archive-output
```
