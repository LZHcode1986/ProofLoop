# AGENTS.md Customization Guide

This file is a template guide for downstream projects.

When installing ProofLoop into a real repository, replace this guide with project-specific agent instructions. The final local `AGENTS.md` should describe only the rules that every agent working in that project must know.

Do not use this file to store ProofLoop workflow internals, role-specific procedures, packet formats, or long process playbooks.

## What the local AGENTS.md should contain

A project-specific `AGENTS.md` should normally include the sections below.

### Project identity

Describe the project in a few lines:

- product or repository name;
- primary purpose;
- main users or runtime context;
- the most important business or engineering constraint.

Keep this short. Agents need orientation, not a full PRD.

### Authority and source of truth

List the project-local authority order.

Typical sources include:

- user instruction;
- current task or dispatch contract;
- product requirements or specs;
- architecture documents;
- code and tests;
- local conventions.

State what agents should do when these sources conflict.

### Repository map

Explain the important top-level paths.

Include only paths that help agents avoid mistakes, such as:

- application source directories;
- tests;
- generated files;
- migrations;
- configuration;
- scripts;
- documentation;
- files or directories agents should not edit.

### Common commands

List the project-local commands agents should prefer for:

- dependency setup;
- formatting;
- linting;
- type checking;
- unit tests;
- integration tests;
- local build;
- code generation.

Include platform notes only when they matter.

### Coding conventions

Summarize conventions that apply across the project:

- language or framework conventions;
- naming rules;
- error handling style;
- logging style;
- API compatibility expectations;
- frontend or backend patterns;
- test style.

Do not duplicate rules already enforced by formatters or linters unless agents commonly miss them.

### Verification expectations

Define what counts as acceptable evidence for this project.

Examples:

- tests that should be run for common change types;
- screenshots or manual checks for UI changes;
- migration dry-run expectations;
- API contract checks;
- security or data-safety checks.

Keep this project-specific. Generic workflow verification belongs in workflow contracts or agent instructions, not here.

### Safety and boundaries

State project-wide restrictions, such as:

- secrets and credentials that must not be read or printed;
- production data restrictions;
- destructive command restrictions;
- migration safety expectations;
- generated file rules;
- external service rules.

### Collaboration rules

Add project-wide collaboration expectations only when they are stable across agents.

Examples:

- when to ask for clarification;
- when to stop and report a blocker;
- when a change needs a formal spec update;
- when maintainers must review manually.

## What AGENTS.md should not contain

Do not put the following in the local `AGENTS.md`:

- detailed ProofLoop dispatch flows;
- agent-specific role instructions;
- packet schemas;
- per-agent output formats;
- long troubleshooting procedures;
- task-by-task implementation plans;
- temporary migration notes;
- historical rationale that is not needed during execution;
- product requirements that belong in specs or PRDs;
- instructions for tools or agents not used by the local project.

## Recommended local structure

Projects may use this structure as a starting point:

```md
# <Project Name> Agent Instructions

## Project summary

## Authority order

## Repository map

## Common commands

## Coding conventions

## Verification expectations

## Safety and boundaries

## Stop and clarify conditions
```

Add sections only when they are useful for every agent in the project.

## Maintenance rule

Keep the local `AGENTS.md` short and current.

When a rule becomes role-specific, move it to the relevant agent instruction.  
When a rule becomes procedural, move it to a workflow contract or skill.  
When a rule becomes product-specific, move it to the appropriate requirement, spec, or design document.
