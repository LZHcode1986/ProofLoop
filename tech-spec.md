# Tech Spec

This document is a fill-in template for long-term, project-wide **technical specifications only**.
After installing ProofLoop into a project, Brain owns and maintains that project's copy of this file and the `tech-spec/` directory.
Downstream agents read the filled project copy as an authoritative technical reference.

Fill in this file and the sub-files below for your project before using them as a development authority.
Leave a section as `<unspecified>` only if the project genuinely has no constraint for it yet.
Delete example placeholders once real project values exist.

This template is not the authority for ProofLoop's own workflow rules.
For this repository's workflow, follow `AGENTS.md`, `openspec/`, and the agent contracts.

## What Belongs Here

`tech-spec.md` and `tech-spec/` hold **technical specs** that describe how the system is built:

- Tech stack, languages, frameworks, dependencies
- Architecture, layering, module boundaries
- API contracts, interface principles
- State model, canonical objects, data structures
- Testing strategy, validation commands

**Do not** put the following here. These belong in `AGENTS.md`:

- Workflow rules, agent ownership, dispatch protocols
- Operating principles (simplicity, surgical changes, goal-driven execution)
- Authority order, document priority
- Project boundary, product scope, non-goals
- Design philosophy, stage planning rules

If a section looks like a process or governance rule, it belongs in `AGENTS.md`, not here.

---

## Index

- [Architecture](tech-spec/architecture.md) — layering, module boundaries, persistence, background jobs
- [API](tech-spec/api.md) — API principles, interfaces, contracts
- [State](tech-spec/state.md) — state model, canonical objects, runtime artifacts
- [Testing](tech-spec/testing.md) — testing posture, validation commands, test data policy

---

## Tech Stack

<!-- List the primary languages, frameworks, runtimes, and key dependencies. -->

- Language:
- Runtime:
- Framework:
- Package manager:
- Key dependencies:
- External services:

## Core Roles

<!-- List the system participants, actors, or user roles. -->

- <role>: <brief description>

## Stable Working Names

<!-- List capability names, module names, or labels that must not drift without an authority update. -->

- <name>: <what it refers to>

## Decisions Log

<!-- Record durable technical decisions made during exploration or planning. Brain appends entries here, never rewrites. -->

<!-- Format:
### YYYY-MM-DD — <decision title>
- Context: <why this decision was needed>
- Decision: <what was decided>
- Alternatives considered: <what was rejected and why>
- Affected scope: <which modules, stages, or capabilities>
-->
