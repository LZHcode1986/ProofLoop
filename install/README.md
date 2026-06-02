# ProofLoop Install

This installer copies ProofLoop workflow assets into a target project.

## Important

Do not overwrite OpenSpec canonical skills or shared TDD skill unless explicitly requested.

Do not overwrite:

```text
.agents/skills/openspec-propose/SKILL.md
.agents/skills/openspec-apply-change/SKILL.md
.agents/skills/openspec-archive-change/SKILL.md
.agents/skills/test-driven-development/SKILL.md
```

Install ProofLoop overlay instead:

```text
.opencode/agents/*.md
.agents/contracts/*.md
openspec/QUALITY-GATE.md
openspec/schemas/proofloop-spec-driven/**
```

## v3.3 installed workflow

```text
Direct Task:
  Brain -> general -> Completion Receipt -> Brain self-check

OpenSpec Change:
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

## Installed active agents

```text
brain
propose
executor
worker
code-verifier
planning-contract-verifier
implementation-reviewer
committer
web-scraper
```

Do not install as active default:

```text
reality-verifier
reality-verifier-codegraph
```

`spec-verifier` may be installed only as a deprecated compatibility alias.

## Installed contracts

```text
.agents/contracts/dispatch-packets.md
.agents/contracts/executor-dispatch-packets.md
.agents/contracts/codegraph-tool-protocol.md
.agents/contracts/proofloop-skill-usage.md
```
