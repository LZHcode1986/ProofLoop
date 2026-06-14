# tech-spec.md Customization Guide

This file is a template guide for downstream projects.

When installing ProofLoop into a real repository, replace this guide with a project-specific technical specification. The final local `tech-spec.md` should describe the project's architecture and technical boundaries at a stable, high level.

Do not use this file to store ProofLoop workflow internals, agent dispatch procedures, packet formats, or task execution playbooks.

## What the local tech-spec.md should contain

A project-specific `tech-spec.md` should normally answer these questions.

### What is being built?

Summarize the system or product from a technical point of view:

- main capabilities;
- runtime shape;
- important users or clients;
- major external dependencies.

This should be an architecture overview, not a marketing description.

### What are the major components?

Describe the main technical components and their responsibilities.

Examples:

- frontend application;
- backend API;
- workers or jobs;
- database;
- cache;
- queue;
- external integrations;
- shared packages;
- deployment infrastructure.

For each component, explain what it owns and what it must not own.

### What are the important data flows?

Describe the stable flows agents must understand before changing code.

Examples:

- request lifecycle;
- authentication flow;
- data ingestion;
- background processing;
- export or reporting flow;
- payment or billing flow;
- notification flow.

Use diagrams only when they are maintained and useful.

### What are the key interfaces?

List the important boundaries between components:

- API routes;
- public SDK or package exports;
- event contracts;
- database boundaries;
- configuration contracts;
- external service contracts.

The purpose is to help agents avoid changing one side of an interface without checking the other.

### What are the technical constraints?

Document constraints that should shape implementation decisions:

- supported runtime versions;
- deployment environment;
- performance limits;
- security requirements;
- data retention rules;
- compatibility requirements;
- scaling assumptions;
- offline or reliability requirements.

Keep these concrete and project-specific.

### What are the architecture decisions?

Record only stable decisions that affect future changes.

Examples:

- why a framework was chosen;
- why a service boundary exists;
- why a schema shape is intentionally constrained;
- why a migration path must be preserved.

Detailed ADRs may live elsewhere. Link to them instead of duplicating them.

### How should changes be verified technically?

Describe project-level verification expectations:

- required test layers;
- contract checks;
- migration checks;
- build or packaging checks;
- observability checks;
- manual validation that is unavoidable.

Do not include full workflow procedures or agent-specific output formats.

## What tech-spec.md should not contain

Do not put the following in the local `tech-spec.md`:

- ProofLoop route definitions;
- agent role behavior;
- dispatch packet fields;
- implementation task lists;
- temporary plans;
- commit or archive procedures;
- detailed runbooks;
- issue-specific debugging notes;
- product requirements that belong in PRDs or specs;
- low-level code comments that belong near the code.

## Recommended local structure

Projects may use this structure as a starting point:

```md
# <Project Name> Technical Specification

## System overview

## Component responsibilities

## Data flows

## Key interfaces

## Data model and storage

## External dependencies

## Technical constraints

## Verification strategy

## Architecture decisions
```

Add, remove, or rename sections to match the real project.

## Maintenance rule

Keep the local `tech-spec.md` stable and architectural.

When content becomes a task plan, move it to planning artifacts.  
When content becomes a runbook, move it to operations documentation.  
When content becomes a product requirement, move it to specs or PRDs.  
When content becomes agent-specific, move it to the relevant agent instruction or contract.
