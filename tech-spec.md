# tech-spec.md Customization Guide

This file is a template for local project technical notes.

Use it only for concrete technical stack details and technical constraints that agents must follow while working in the repository.

## Technology stack

- language:
- runtime:
- framework:
- package manager:
- database:
- test framework:
- build tool:
- deployment target:

## Required commands

List commands agents should use:

- install:
- format:
- lint:
- typecheck:
- test:
- build:
- codegen:
- migration check:

## Forbidden or unsafe commands

List commands agents must not run, or may run only with explicit approval:

- command:
  - reason:
  - safer alternative:

## Technical notes

Document concrete project-specific technical constraints:

- generated files:
- migration rules:
- runtime compatibility:
- API compatibility:
- platform-specific notes:
- local service requirements:
- known command caveats:

## Do not put here

- ProofLoop route definitions.
- Agent role behavior.
- Dispatch packet fields.
- Product roadmap.
- PRD content.
- Broad architecture essays.
- Data-flow documentation unless it directly affects commands or technical constraints.
- Task plans or implementation checklists.