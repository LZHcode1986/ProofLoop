# AI-assisted ProofLoop Install Prompt

Install ProofLoop v3.3 into this project.

Do not overwrite OpenSpec canonical skills or shared TDD skill.

Do not overwrite:

```text
.agents/skills/openspec-propose/SKILL.md
.agents/skills/openspec-apply-change/SKILL.md
.agents/skills/openspec-archive-change/SKILL.md
.agents/skills/test-driven-development/SKILL.md
```

Install the ProofLoop overlay:

```text
AGENTS.md
README.md
.opencode/agents/**
.agents/contracts/**
openspec/QUALITY-GATE.md
openspec/schemas/proofloop-spec-driven/**
install/**
```

Use the following active workflow:

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
        -> Brain archive authorization
        -> Implementation Reviewer archive execution
        -> Committer archive-output if needed
```

Important rules:

- Do not use P0/P1/P2 workflow routing.
- Do not install Reality Verifier as default active flow.
- Use CodeGraph Tool Protocol for code reality.
- Use planning-contract-verifier instead of active spec-verifier.
- Keep spec-verifier only as deprecated compatibility alias if necessary.
- Direct Task goes to general.
- bugfix uses general with diagnose.
- Executor dispatch contracts live in `.agents/contracts/executor-dispatch-packets.md`.
- AGENTS.md must stay short and global.
- README.md must include the updated flowchart.
