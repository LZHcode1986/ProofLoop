# Tech Spec

This document captures long-term, project-wide technical specifications.
Brain owns and maintains this file. Downstream agents read it as an authoritative technical reference.

Fill in the sections below for your project. Leave a section as `<unspecified>` only if the project genuinely has no constraint for it yet.

---

## Tech Stack

<!-- List the primary languages, frameworks, runtimes, and key dependencies. -->

- Language:
- Runtime:
- Framework:
- Package manager:
- Key dependencies:

## Architecture

<!-- Describe the system's layering, module boundaries, and deployment shape. -->

- Style: <e.g., monolith, modular monolith, microservices, serverless, CLI, library>
- Layers:
- Entry points:
- Deployment target:

## Core Roles

<!-- List the system participants, actors, or user roles. -->

- <role>: <brief description>

## State Model

<!-- Define the authoritative state machine or lifecycle model. List state names that must not drift. -->

- States:
- Transitions:
- Authority source:

## Canonical Objects

<!-- List the authoritative data structures or domain objects. -->

- <object name>: <brief description, key fields>

## API Principles

<!-- Define the contract principles for APIs, interfaces, or public surfaces. -->

- Style: <e.g., REST, GraphQL, RPC, CLI flags, library API>
- Versioning:
- Error handling:
- Authentication:

## Testing Posture

<!-- Define the testing strategy and what is expected for each change type. -->

- Strategy: <e.g., TDD-first, contract tests, integration tests, E2E>
- Required test types:
- Coverage expectations:

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

<!-- Define which document has the highest priority when conflicts arise. -->

1. `tech-spec.md` — long-term technical constraints
2. `PRD.md` — product intent and stage plan
3. `openspec/config.yaml` — workflow configuration
4. `AGENTS.md` — repo-wide operating rules

## Decisions Log

<!-- Record durable technical decisions made during exploration or planning. Brain appends entries here, never rewrites. -->

<!-- Format:
### YYYY-MM-DD — <decision title>
- Context: <why this decision was needed>
- Decision: <what was decided>
- Alternatives considered: <what was rejected and why>
- Affected scope: <which modules, stages, or capabilities>
-->
