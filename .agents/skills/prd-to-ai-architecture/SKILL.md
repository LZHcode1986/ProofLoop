---
name: prd-to-ai-architecture
description: Use when a user provides a PRD and wants an AI-coding-ready technical architecture brief before implementation. This skill turns PRD content and optional technical clarification notes into lightweight architecture artifacts, contract/state matrices, hard-parts registers, and task acceptance matrices so AI coding agents are less likely to drift, skip difficult work, or create interface mismatches.
---

# PRD to AI Architecture

## Purpose

Transform a PRD into AI-coding-ready technical guidance before implementation starts.

This skill is not a prompt pack. It is a workflow for producing compact, auditable artifacts that constrain later AI coding work.

## When To Use

Use this skill when:

- The user has a PRD, product brief, feature spec, or technical intake brief.
- The user wants to code with an AI agent after architecture planning.
- The project risk includes missing features, interface mismatch, fake/mock implementations, skipped difficult parts, wrong ports, unclear module boundaries, or weak acceptance criteria.
- The user wants reusable SOP, architecture templates, or task acceptance matrices.

Do not use this skill for:

- Tiny one-file fixes where a design step would add no value.
- Pure brainstorming with no intent to implement.
- General PRD writing without a technical architecture output.

## Inputs

Required:

- PRD or product requirements document.

Optional:

- Technical clarification brief.
- Existing codebase structure.
- Preferred stack.
- Non-goals.
- Acceptance criteria.
- Known failure cases from prior AI coding attempts.

## Core Workflow: PACT

1. **Parse PRD**
   - Extract product facts, user flows, scope, non-goals, outputs, state, data, dependencies, risks, and acceptance criteria.
   - Mark each item as `confirmed`, `assumed`, or `open`.
   - Do not treat missing technical decisions as confirmed.

2. **Architecture Brief**
   - Create `tech-spec/ai-coding-architecture.md`.
   - Include system context, module boundaries, runtime flows, technical context, and decision log.
   - Keep it lightweight by default; expand only when risk requires it.

3. **Contracts & Constraints**
   - Create `tech-spec/contract-state-matrix.md`.
   - Lock API routes, event streams, file paths, database/JSON schema, task states, ports, and error behavior.
   - Create `tech-spec/hard-parts-register.md`.
   - Explicitly list difficult work that AI must not skip.

4. **Tasks & Tests**
   - Create `tech-spec/task-acceptance-matrix.md`.
   - Split implementation into dependency-ordered tasks.
   - Give each task a definition of done, test or acceptance evidence, affected files/modules, and forbidden shortcuts.

5. **Pre-Code Audit**
   - Before coding, verify all core PRD requirements map to modules, contracts, tasks, and acceptance checks.
   - If critical fields are missing, stop and ask for clarification or record them as assumptions.

## Required Outputs

Produce these artifacts unless the user asks for a smaller scope (they should be placed under the `tech-spec/` directory):

- `tech-spec/ai-coding-architecture.md`
- `tech-spec/contract-state-matrix.md`
- `tech-spec/hard-parts-register.md`
- `tech-spec/task-acceptance-matrix.md`

For detailed templates, read:

- `references/architecture-template.md`
- `references/contract-state-matrix.md`
- `references/hard-parts-register.md`
- `references/task-acceptance-matrix.md`
- `references/pre-code-audit.md`

If the user provides a PRD similar to a local Web/SaaS/full-stack product, you may also read:

- `references/example-creator-sop-studio.md`

## Quality Gates

Do not proceed to implementation planning unless:

- Scope and non-goals are explicit.
- Technical decisions are labeled as confirmed, assumed, or open.
- Module boundaries include both responsibilities and non-responsibilities.
- APIs/events/files/data/state have a verification path.
- Hard parts include forbidden shortcuts and minimum acceptable implementation.
- Tasks are dependency ordered.
- Each task has acceptance evidence.

## Anti-Patterns

Reject or revise outputs that:

- Read like a generic architecture essay.
- Omit ports, routes, files, data, or task states when they matter.
- Treat mock data, TODOs, fake integrations, or static UI as finished work.
- Ask AI to implement everything in one giant task.
- Hide open questions.
- Claim the architecture guarantees AI will not make mistakes.

## Evidence Basis

This workflow combines:

- C4 model for architecture views.
- arc42 for architecture document structure.
- ADR for decision records.
- OpenAPI and contract testing ideas for interface discipline.
- BDD/acceptance criteria for verifiable behavior.
- Spec-driven AI coding practices for staged artifacts.
- Lightweight constraints from critiques of overly heavy spec workflows.
