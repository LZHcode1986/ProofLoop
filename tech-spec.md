# Tech Spec

This document is a fill-in template for long-term, project-wide technical specifications.
After installing ProofLoop into a project, Brain owns and maintains that project's copy of this file and the `tech-spec/` directory.
Downstream agents read the filled project copy as an authoritative technical reference.

Fill in this file and the sub-files below for your project before using them as a development authority.
Leave a section as `<unspecified>` only if the project genuinely has no constraint for it yet.
Delete example placeholders once real project values exist.

This template is not the authority for ProofLoop's own workflow rules.
For this repository's workflow, follow `AGENTS.md`, `openspec/`, and the agent contracts.

---

## Index

- [Architecture](tech-spec/architecture.md) — layering, module boundaries, persistence, background jobs
- [API](tech-spec/api.md) — API principles, interfaces, contracts
- [State](tech-spec/state.md) — state model, canonical objects
- [Testing](tech-spec/testing.md) — testing posture, validation commands, test data policy

---

## Project Boundary

<!-- Define what this project is responsible for and what it explicitly does not own. -->

- Project name:
- Domain:
- Product boundary:
- Explicit non-goals:
- Supported environments:

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

## Shared Principles

<!-- List technical principles that all slices and stages must follow. -->

- <principle>: <brief description>

## Stable Working Names

<!-- List capability names, module names, or labels that must not drift without an authority update. -->

- <name>: <what it refers to>

## Authority Order

<!--
Define which document has the highest priority when conflicts arise in the installed project.
Adjust this order to match the target repository.
Do not let this section override ProofLoop/OpenSpec workflow rules unless the project deliberately owns those rules here.
-->

1. `openspec/` — change workflow, schema, proposal/design/spec/tasks format, apply, and archive rules
2. `AGENTS.md` — repository-wide operating rules not encoded by OpenSpec
3. `tech-spec.md` — long-term technical constraints, architecture, state model, canonical objects, and testing posture
4. `PRD.md` — product intent, stage plan, and acceptance criteria for the active product scope
5. `CLARIFY.md` — resolved clarifications and decision history, when present

## Decisions Log

<!-- Record durable technical decisions made during exploration or planning. Brain appends entries here, never rewrites. -->

<!-- Format:
### YYYY-MM-DD — <decision title>
- Context: <why this decision was needed>
- Decision: <what was decided>
- Alternatives considered: <what was rejected and why>
- Affected scope: <which modules, stages, or capabilities>
-->
