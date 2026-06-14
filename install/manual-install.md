# Manual Install

Copy files into the target project preserving paths.

## Do not overwrite canonical skills

Do not overwrite these files unless explicitly approved:

```text
.agents/skills/openspec-propose/SKILL.md
.agents/skills/openspec-apply-change/SKILL.md
.agents/skills/openspec-archive-change/SKILL.md
.agents/skills/test-driven-development/SKILL.md
```

## Required root files

```text
AGENTS.md
README.md
openspec/config.yaml.example
```

## Required agents

```text
.opencode/agents/brain.md
.opencode/agents/propose.md
.opencode/agents/executor.md
.opencode/agents/worker.md
.opencode/agents/code-verifier.md
.opencode/agents/planning-contract-verifier.md
.opencode/agents/implementation-reviewer.md
.opencode/agents/committer.md
.opencode/agents/web-scraper.md
```

## Optional agents

```text
.opencode/agents/spec-verifier.md        # -InstallDeprecatedAliases (deprecated)
```

ProofLoop does not ship a general agent. Direct Task uses the host runtime's general agent constrained by Brain Dispatch Contract and Completion Receipt format.

Do not install as active default:

```text
.opencode/agents/reality-verifier.md
.opencode/agents/reality-verifier-codegraph.md
```

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
.agents/contracts/codegraph-tool-protocol.md
.agents/contracts/proofloop-skill-usage.md
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
