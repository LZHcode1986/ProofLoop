# Design Summary

## Goals and Non-goals
**Goals:**
- Fix the logic inside `openspec-propose` skill to check Proof Posture before dispatching subagents.
- Simplify task templates metadata for Setup/Blocking/Reconciliation tasks and Slice tasks.
- Create `opencode.json` configuration and lazy loading description in `AGENTS.md`.

**Non-goals:**
- Refactoring the entire codebase.

## Authority Boundary & Interface Contracts
- Modifies `.agents/skills/openspec-propose/SKILL.md` to establish conditional logic based on Proof Posture.
- Modifies `AGENTS.md` and `opencode.json` to introduce rules lazy loading.

## Persistence & State Impact
None.

## Key Architecture Decisions
- Adopt P0 Fast Proof classification for this rectification work since it consists of documentation, config, and agent rules with no production side effects.
