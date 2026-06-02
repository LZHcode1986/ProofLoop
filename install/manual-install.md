# Manual Install

Copy files into the target project preserving paths.

## Do not overwrite canonical skills

Do not overwrite these files during v3.3 migration unless explicitly approved:

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
openspec/QUALITY-GATE.md
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

Optional compatibility alias:

```text
.opencode/agents/spec-verifier.md
```

Do not install as active default:

```text
.opencode/agents/reality-verifier.md
.opencode/agents/reality-verifier-codegraph.md
```

## Required contracts

```text
.agents/contracts/dispatch-packets.md
.agents/contracts/executor-dispatch-packets.md
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
