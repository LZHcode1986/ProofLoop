---
name: frontend-tech
description: Produce the conditional frontend technical handoff at tech-spec/frontend.md from current Product/Technical Authority, optional design-prototype evidence, and relevant frontend reality.
disable-model-invocation: true
---

# frontend-tech

## Mission

Close the technical handoff between Product/Technical Authority and frontend execution.

Own exactly one artifact:

`tech-spec/frontend.md`

Make that artifact sufficient for the downstream `frontend-execute` and `frontend-review` Host Agents to understand frontend scope, user-visible flows, backend bindings, observable states, and cross-boundary constraints without inventing product behavior or backend semantics.

Leave implementation HOW to `frontend-execute` and the review verdict to `frontend-review`.

## Boundary

Use this decision test for every candidate detail:

> If postponing this decision would force the frontend implementer to invent product behavior or a frontend↔backend boundary, resolve or expose it here. Otherwise leave it downstream.

Keep these outside this Skill unless an upstream Authority already makes them binding constraints:

- component decomposition;
- React/Vue/Svelte implementation structure;
- client state library or hook choices;
- CSS/Tailwind implementation;
- visual styling, typography, color, motion, and polish;
- task decomposition, sequencing, estimates, and execution planning;
- test implementation;
- new backend route/schema/error definitions.

`contracts.md` remains the canonical source for backend interfaces. `frontend.md` binds frontend behavior to those interfaces; it does not copy or redefine them.

## Authority model

Ground each statement in the strongest applicable source:

| Concern | Source of truth |
|---|---|
| Product scope, user goal, product behavior | `PRD.md` |
| System responsibilities and runtime boundaries | `tech-spec/architecture.md` |
| API/data/error/auth/state interfaces | `tech-spec/contracts.md` |
| Frontend-observable acceptance constraints | `tech-spec/acceptance.md` when relevant |
| Visible structure and interaction intent | design prototype, when one exists |
| Existing routes, components, design-system/runtime constraints | current frontend/code reality in brownfield work |

Treat a design prototype as optional input. It may come from any tool or format. It becomes normative only to the extent the user or existing Authority explicitly says it is normative.

When no design prototype exists, derive only the minimum frontend surface and behavior required by Product/Technical Authority. Do not invent an aesthetic direction to fill the absence.

When sources conflict, preserve their ownership: expose the contradiction or missing decision instead of silently rewriting upstream Authority.

## Core workflow: Ground → Map → Bind → Close → Handoff

### 1. Ground

Read the current Product/Technical Authority before drafting frontend structure.

Extract only frontend-relevant facts:

- must-implement user outcomes;
- roles, permissions, and ownership;
- domain objects visible to users;
- relevant runtime/system boundaries;
- backend contracts the frontend may consume;
- frontend-observable acceptance constraints;
- explicit non-goals and forbidden shortcuts.

If a design prototype exists, inspect it for explicit surface, hierarchy, navigation, flow, and interaction intent. Record its role as normative or reference-only from existing evidence; do not infer exact visual fidelity when that has not been established.

For brownfield work, inspect only enough current frontend/code reality to establish durable existing constraints that affect handoff. Do not turn this into a repository-wide frontend redesign audit.

**Completion criterion:** every fact intended for `frontend.md` is traceable to Product/Technical Authority, an explicitly scoped design prototype, or relevant current code reality; all material conflicts and unknowns are visible.

### 2. Map

Build the smallest user-visible frontend model that covers the product requirement.

Model four things:

- **Surface** — a user-visible page, panel, dialog, workspace, or equivalent surface;
- **Flow** — how a user moves through surfaces to complete a product outcome;
- **Action** — a meaningful user-triggered operation;
- **Read** — backend-derived information a surface must present.

For each surface, identify the user job and primary action when they materially constrain implementation.

Use a design prototype, when present, to ground structure and flow. Without one, map only what the PRD and Technical Authority require.

Do not substitute component trees for surfaces or invent screens merely to make the template look complete.

**Completion criterion:** every frontend-facing must-implement outcome is covered by at least one Surface/Flow/Action/Read, and every mapped item is justified by an input source.

### 3. Bind

Bind every backend-dependent Read or Action to canonical Technical Authority.

For each binding, capture only the semantics the frontend consumer must know:

- canonical contract reference;
- user or lifecycle trigger;
- success meaning;
- failure meaning;
- auth/permission behavior;
- ordering, pagination, filtering, search, retry, idempotency, realtime, or consistency semantics only when material to frontend behavior.

Reference the canonical contract; do not duplicate request/response schemas or create a second API definition.

If required backend behavior has no valid contract, record a handoff gap. Do not invent a route, mock response, or schema inside `frontend.md`.

**Completion criterion:** every backend-dependent frontend behavior has either one canonical contract reference or one explicit unresolved gap; no copied contract becomes a second source of truth.

### 4. Close

Close the user-observable state model from actual flows and contract outcomes.

Derive states from real behavior rather than from a fixed checklist. Typical states may include loading, ready, empty, submitting, success, error, unauthenticated, forbidden, not-found, conflict, stale, or reconnecting only when the product actually has them.

For every material state or transition, define what the user must observe or be able to do. Close cross-boundary semantics that would otherwise force frontend invention, such as:

- which side is authoritative for validation or permissions;
- server-side versus client-side search/filter/order/pagination;
- retry and duplicate-submission safety;
- timestamps, locale, units, and display-relevant normalization;
- upload limits and failure semantics;
- optimistic versus confirmed updates when externally constrained;
- eventual consistency, polling, streaming, or realtime expectations.

**Completion criterion:** every backend outcome that materially changes user-visible behavior has frontend semantics or an explicit gap, and no state exists solely because a template listed it.

### 5. Handoff

Read `references/frontend-template.md` and write `tech-spec/frontend.md`.

Prefer pointers to upstream Authority over copied prose. Include only sections that carry live information for this product.

Keep the artifact at the handoff level:

- scope and user-visible model;
- frontend↔backend bindings;
- observable state semantics;
- cross-boundary constraints;
- optional design-prototype interpretation;
- unresolved gaps.

Stop before task planning, code structure, component architecture, styling, or implementation instructions.

**Completion criterion:** `frontend-execute` can identify what must exist, how user-visible behavior maps to backend Authority, which states matter, and which constraints are binding without guessing; all remaining freedom is implementation HOW.

## Gap discipline

Ask for clarification only when one unresolved decision blocks a safe handoff and cannot be recovered from current Authority, prototype evidence, or code reality. Ask the smallest question that can close that decision.

If clarification is unavailable, keep the gap explicit. Do not make the document look complete by converting unknowns into assumptions.

A gap is material when `frontend-execute` would otherwise need to invent:

- product behavior;
- required surface or flow;
- backend capability;
- permission/error semantics;
- a cross-boundary state transition.

Visual taste or code-organization choices are not handoff gaps.

## Output discipline

The artifact template is the single source for `frontend.md` structure:

`references/frontend-template.md`

Do not duplicate that template in this file.

Write concise, reference-led prose. Omit empty optional sections instead of filling them with generic guidance.

## Completion criteria

`frontend-tech` is complete only when:

- frontend scope is grounded in current Product/Technical Authority;
- design prototype input is treated as optional and tool-agnostic;
- every backend-dependent frontend behavior is bound to a canonical contract or an explicit gap;
- user-observable async/error/permission states are closed where material;
- cross-boundary constraints are explicit where the frontend must not invent them;
- `tech-spec/frontend.md` contains no duplicate backend contract schema;
- the artifact does not prescribe frontend implementation HOW;
- any unresolved material gap is visible rather than guessed away.
