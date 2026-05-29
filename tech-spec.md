# Tech Spec

This document is a fill-in template for long-term, project-wide technical specifications.
After installing ProofLoop into a project, Brain owns and maintains that project's copy of this file.
Downstream agents read the filled project copy as an authoritative technical reference.

Fill in the sections below for your project before using this file as a development authority.
Leave a section as `<unspecified>` only if the project genuinely has no constraint for it yet.
Delete example placeholders once real project values exist.

This template is not the authority for ProofLoop's own workflow rules.
For this repository's workflow, follow `AGENTS.md`, `openspec/`, and the agent contracts.

## When to Split

When `tech-spec.md` exceeds 200 lines, create a `tech-spec/` directory and move domain-specific sections into separate files:

```text
tech-spec.md              ← navigation, project boundary, shared principles, authority order, decisions log
tech-spec/architecture.md ← architecture, module boundaries, persistence
tech-spec/api.md          ← API principles, interfaces, contracts
tech-spec/state.md        ← state model, canonical objects
tech-spec/testing.md      ← testing posture, validation commands, test data policy
```

Keep `tech-spec.md` as the entry point with links to each sub-file. Brain maintains the split structure the same way it maintains the single-file version.

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

## Architecture

<!-- Describe the system's layering, module boundaries, and deployment shape. -->

- Style: <e.g., monolith, modular monolith, microservices, serverless, CLI, library>
- Layers:
- Module boundaries:
- Entry points:
- Deployment target:
- Persistence:
- Background jobs:

## Core Roles

<!-- List the system participants, actors, or user roles. -->

- <role>: <brief description>

## State Model

<!-- Define the authoritative state machine or lifecycle model. List state names that must not drift. -->

- States:
- Transitions:
- Authority source:
- Invalid states:

## Canonical Objects

<!-- List the authoritative data structures or domain objects. -->

- <object name>: <brief description, key fields>

## API Principles

<!-- Define the contract principles for APIs, interfaces, or public surfaces. -->

- Style: <e.g., REST, GraphQL, RPC, CLI flags, library API>
- Versioning:
- Error handling:
- Authentication:
- Backward compatibility:

## Testing Posture

<!-- Define the testing strategy and what is expected for each change type. -->

- Strategy: <e.g., TDD-first, contract tests, integration tests, E2E>
- Required test types:
- Required validation commands:
- Coverage expectations:
- Test data policy:

## Shared Principles

<!-- List technical principles that all slices and stages must follow. -->

- <principle>: <brief description>

## Runtime Artifacts

<!-- Define the trace, audit, snapshot, or delivery artifacts that prove execution. -->

- <artifact>: <what it proves, where it lives>

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
