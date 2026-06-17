# Skills Guide

Skills are reusable procedures. Agents load them only when needed.

## Important boundary

Do not rewrite canonical or shared skill files as part of ProofLoop flow changes unless explicitly approved.

ProofLoop workflow constraints belong in:

```text
.opencode/agents/*.md
.agents/contracts/*.md
openspec/schemas/proofloop-spec-driven/**
openspec/config.yaml
```

## OpenSpec canonical skills

Keep these names and files stable for OpenSpec compatibility:

- `openspec-propose/SKILL.md`
- `openspec-explore/SKILL.md`
- `openspec-apply-change/SKILL.md`
- `openspec-archive-change/SKILL.md`

## Shared implementation skills

- `test-driven-development/SKILL.md`

Do not patch this file for ProofLoop worker behavior.  
Use `.opencode/agents/worker.md`.

## Workflow orchestration skills

- `ai-structured-prd/SKILL.md` — core PRD skill: Intent/Context/Draft/Review modes with PRD Context
- `prd-to-tech-design-prep/SKILL.md` — post-PRD technical handoff and clarification
- `prd-to-ai-architecture/SKILL.md` — post-technical-clarification architecture package generator. Produces `tech-spec.md` plus AI coding architecture package (`ai-coding-architecture.md`, `contract-state-matrix.md`, `hard-parts-register.md`, `task-acceptance-matrix.md`). Use after PRD confirmation. If technical design input is missing or uncertain, Brain should load `prd-to-tech-design-prep` first.

## v3.3 responsibility model

1. Brain owns user-facing intent and dispatch.
2. Direct Task goes to `general`.
3. Formal OpenSpec Change goes to `propose`.
4. `propose` loads `openspec-propose`.
5. `propose` dispatches `planning-contract-verifier`, not active `spec-verifier`.
6. `reality-verifier` is no longer a default agent; use CodeGraph Tool Protocol.
7. `executor` loads `openspec-apply-change`.
8. `executor` dispatches `worker`, `code-verifier`, and `committer` using contracts under `.agents/contracts/executor/`.
9. `implementation-reviewer` loads `openspec-archive-change` only after Brain authorizes archive.
10. Brain loads `prd-to-tech-design-prep` when PRD-confirmed work needs user-facing technical clarification; `@general` only persists Brain-confirmed output.
11. Brain loads `prd-to-ai-architecture` when implementation preparation needs architecture constraints; `@general` only writes or updates `tech-spec.md` and the four architecture package files.
