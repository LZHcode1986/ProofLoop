# AI-assisted ProofLoop Install Prompt

Install ProofLoop v3.3 into this project.

Do not overwrite OpenSpec canonical skills or shared TDD skill.

Do not overwrite:

```text
.omp/skills/openspec-propose/SKILL.md
.omp/skills/openspec-apply-change/SKILL.md
.omp/skills/openspec-archive-change/SKILL.md
.omp/skills/test-driven-development/SKILL.md
```

Install the ProofLoop overlay:

```text
AGENTS.md.example
tech-spec.md.example
.omp/agents/**
.agents/contracts/**
.omp/skills/**
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
        -> General archive execution
        -> Committer archive-output if needed
```

Important rules:

- Do not use P0/P1/P2 workflow routing.
- Use CodeGraph Tool Protocol for code reality.
- Direct Task goes to general.
- bugfix uses general with diagnose.
- Executor dispatch contracts live under `.agents/contracts/executor/`.
- Worker runtime and fail-fast policies live in `.agents/contracts/executor/shared-worker-rules.md`.
- AGENTS.md must stay short and global.
- README.md must include the updated flowchart.
- `.omp/` replaces `.opencode/` configuration. All agents live in `.omp/agents/`, skills in `.omp/skills/`.
- Brain has edit denied and acts as a pure governance control plane; all file modifications are performed through subagents.
- Brain routes in this order: continuation, specialist owner, committer boundary, general fallback.
- general is the general-purpose executor for Brain-bounded tasks after specialist and committer checks.
- implementation-reviewer performs stage review and archive-readiness review only, using code-review-and-quality as a stage-level quality lens (does not replace Code Verifier).
- Brain-authorized archive execution is dispatched to general.
- committer owns archive-output git boundary.
