---
name: prd-to-ai-architecture
description: Use when a user provides an approved PRD and wants an AI-coding-ready technical architecture brief before implementation — architecture, contracts and state matrices, hard-part risks, and task acceptance matrices. Use when another skill needs pre-code architecture artifacts.
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
   - Mark each item as `confirmed`, `assumed`, or `open`; record missing technical decisions as `open`.

2. **Architecture Grilling With Docs** *(conditional mode — not a mandatory step)*
   Enter grilling mode only when at least one entry criterion is met:
   - An `open` or `assumed` item blocks producing or confirming the current artifact.
   - A term is vague or overloaded, or conflicts with the PRD, existing docs, or codebase.
   - User assumptions conflict with existing docs or code.
   - A hard-to-reverse, surprising, or trade-off-heavy decision needs a decision-log record.

   If no entry criterion is met, skip the interview entirely and produce the artifact directly, labeling decisions `confirmed`/`assumed`/`open`. Do not ask questions for the sake of asking — with a complete PRD, skipping is the expected default, not a failure.

   When grilling engages, you MUST read `references/grilling-protocol.md` and follow it exactly.

3. **Architecture Brief**
   - Create `tech-spec/ai-coding-architecture.md`.
   - Include system context, module boundaries, runtime flows, technical context, and decision log.
   - Every PRD must-implement item maps to a module in the brief; keep it lightweight by default and expand only when risk requires it.

4. **Contracts & Constraints**
   - Create `tech-spec/contract-state-matrix.md`.
   - Lock API routes, event streams, file paths, database/JSON schema, task states, ports, and error behavior.
   - Create `tech-spec/hard-parts-register.md`.
   - Explicitly list the difficult work the AI must complete.

5. **Architecture Work Items**
   - Create `tech-spec/task-acceptance-matrix.md`.
   - Split implementation into dependency-ordered Architecture Work Items.
   - Give each work item a definition of done, test or acceptance evidence, affected files/modules, and forbidden shortcuts.
   - Architecture Work Items use ID format `AWI-*` (not `T*`).
   - Architecture Work Items are the project-level unit of work; stage-local breakdown (Stage Tasks, Worker Tasks, Slices) belongs to later stages.

6. **Pre-Code Audit**
   - Before coding, verify all core PRD requirements map to modules, contracts, Architecture Work Items, and acceptance checks.
   - If critical fields are missing, stop and ask for clarification or record them as assumptions.

## ProofLoop Confirmation Cadence

When used by ProofLoop Brain, do not require one package-wide confirmation before any file is written.

Brain should confirm and persist one artifact at a time:
1. `tech-spec/ai-coding-architecture.md`
2. `tech-spec/contract-state-matrix.md`
3. `tech-spec/hard-parts-register.md`
4. `tech-spec/task-acceptance-matrix.md`

Before confirming each artifact, Brain may run architecture grilling when an entry criterion is met (see Step 2); otherwise, skip the interview. When grilling engages, follow `references/grilling-protocol.md` exactly. Confirm the artifact with the user, then Brain writes the artifact directly.

The skill may reason about the whole package internally, but user-facing confirmation and file persistence are incremental.

If a later artifact exposes a necessary change to an earlier artifact, Brain must confirm the revision with the user before updating the earlier file, and check consistency against previously confirmed artifacts.

Brain records the durable workflow checkpoint in progress.md after each confirmed artifact.

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
- Technical decisions and architecture-impacting assumptions are labeled as confirmed, assumed, or open.
- Module boundaries include both responsibilities and non-responsibilities.
- APIs/events/files/data/state have a verification path.
- Hard parts include forbidden shortcuts and minimum acceptable implementation.
- Tasks are dependency ordered.
- Each task has acceptance evidence.
- Domain terms that affect architecture are canonicalized.
- Key roles, permissions, ownership, and state transitions have been scenario-tested where not already resolved by the PRD, docs, or codebase.
- Hard-to-reverse or surprising decisions are captured in the architecture decision log.

## Anti-Patterns

Reject or revise outputs that:

- Read like a generic architecture essay.
- Omit ports, routes, files, data, or task states when they matter.
- Treat mock data, TODOs, fake integrations, or static UI as finished work.
- Ask AI to implement everything in one giant task.
- Hide open questions.
- Claim the architecture guarantees AI will not make mistakes.
