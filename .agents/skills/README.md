# Skills Guide

Skills are reusable procedures shared across multiple agents or owned by the
Brain's active phase loop. Agent-specific implementation behavior still belongs
in `.opencode/agents/*.md`; phase guidance may live in a named Skill when the
Brain must reuse the same protocol across planning, execution, and recovery.

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
| `proofloop-plan` | Brain | Planning guidance, candidate `tasks.md`, and vNext SPV dispatch |
| `proofloop-execute` | Brain | Stage delivery guidance and role dispatch templates |
| `test-driven-development` | Worker | RED/GREEN/REFACTOR TDD loop, proof profiles |
| `diagnose` | Worker | Disciplined debugging loop for hard bugs |
| `codebase-design` | Brain | Deep module principles, seam identification |
| `code-review-and-quality` | Stage Reviewer, General | Multi-axis code review |
| `security-and-hardening` | All (cross-role) | Security-first development practices |

## ProofLoop 2.0 responsibility model

1. Brain owns user intent, domain context, PRD, Tech Spec, progress, and global routing.
2. Direct bounded task goes to `general`.
3. Active pluginv2 Stage planning loads `proofloop-plan`; its Stage Plan Verifier dispatch uses the Skill reference template.
4. Active pluginv2 Stage execution loads `proofloop-execute`, which selects the Brain-owned role dispatch template for `worker`, `code-verifier`, or `committer`.
5. Technical unknowns go to `researcher` / `prototype`; only validated conclusions enter Tech Spec.
6. Stage review goes to `stage-reviewer`; all findings return to Brain.
7. Git boundaries are owned by `committer` — no agent commits directly.
8. Skills are loaded by agents on demand; agent files do not duplicate skill content.
9. Active Skill reference templates define complete vNext dispatch packets and allowed returns; they do not authorize Runtime state transitions.
10. Templates are selected by the active Skill and contain no authority claim beyond their declared dispatch scope.
11. Validators check mechanical facts; they do not judge semantics.
