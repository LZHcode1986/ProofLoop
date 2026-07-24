# Skills Guide

Skills are reusable procedures shared across multiple agents.  
Agent-specific workflow belongs in `.opencode/agents/*.md`, not in skills.

## ProofLoop 2.0 skill policy

- Create a skill only when: reusable, used by multiple agents, not part of a single agent's role flow, and reduces catalog noise.
- Skills are loaded by agents on demand. Agents do not copy skill content into their own files.
- Agent role files under `.opencode/agents/` own the complete workflow; skills only supply shared methods.

## Canonical skills

| Skill | Used by | Purpose |
|---|---|---|
| `ai-structured-prd` | Brain | Converts product intent into structured PRD |
| `prd-to-tech-design-prep` | Brain | Post-PRD technical clarification and handoff |
| `prd-to-ai-architecture` | Brain | Generates architecture package under `tech-spec/` |
| `test-driven-development` | Worker | RED/GREEN/REFACTOR TDD loop, proof profiles |
| `diagnose` | Worker | Disciplined debugging loop for hard bugs |
| `codebase-design` | Brain/Planner | Deep module principles, seam identification |
| `code-review-and-quality` | Stage Reviewer, General | Multi-axis code review |
| `security-and-hardening` | All (cross-role) | Security-first development practices |

## Agent workflow ownership

These are NOT skills — they belong in the agent's own workflow file:

- Stage planning → `planner.md`
- Stage plan verification → `stage-plan-verifier.md`
- Stage execution orchestration → `executor.md`
- Slice implementation → `worker.md`
- Adversarial code verification → `code-verifier.md`
- Stage review → `stage-reviewer.md`
- External research → `researcher.md`
- Prototype experiments → `prototype.md`
- Git boundary closure → `committer.md`

## ProofLoop 2.0 responsibility model

1. Brain owns user intent, domain context, PRD, Tech Spec, progress, and global routing.
2. Direct bounded task goes to `general`.
3. Stage planning goes to `planner`; plan verification to `stage-plan-verifier`.
4. Stage execution goes to `executor`, which dispatches `worker`, `code-verifier`, and `committer`.
5. Technical unknowns go to `researcher` / `prototype`; only validated conclusions enter Tech Spec.
6. Stage review goes to `stage-reviewer`; all findings return to Brain.
7. Git boundaries are owned by `committer` — no agent commits directly.
8. Skills are loaded by agents on demand; agent files do not duplicate skill content.
9. Contracts define dispatch boundaries; they do not explain complete methods.
10. Templates define document shapes; they do not specify agent routing.
11. Validators check mechanical facts; they do not judge semantics.