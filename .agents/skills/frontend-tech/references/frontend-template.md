# Frontend Technical Handoff Template

Use this template to produce `tech-spec/frontend.md`.

Keep sections conditional: omit a section or row when the project has no live information for it. Prefer canonical references over copied Authority.

# Frontend Technical Handoff

## 1. Basis

### Product / Technical Authority

- Product: `PRD.md#...`
- Architecture: `tech-spec/architecture.md#...`
- Contracts: `tech-spec/contracts.md#...`
- Acceptance: `tech-spec/acceptance.md#...` when relevant

### Design prototype

Include only when a design prototype exists.

- Reference: [prototype reference]
- Role: [normative | reference-only]
- Binding interpretation: [which visible structure/interaction decisions it establishes]
- Deliberately open: [visual/implementation choices it does not establish]

Do not name a specific design tool unless the project actually uses it.

### Brownfield constraints

Include only when existing frontend/code reality materially constrains the handoff.

- [existing route/surface/design-system/runtime constraint] → [evidence]

## 2. Frontend scope

| Surface | User job | Primary action / read | Source |
|---|---|---|---|
| [surface] | [what the user is trying to complete] | [action/read] | [PRD/prototype/Authority ref] |

A Surface is user-visible product structure, not a component tree.

## 3. User flows

Record only flows that constrain frontend behavior.

### [Flow name]

```text
[entry surface]
  → [user action]
  → [next surface/state]
  → [product outcome]
```

- Source: [Authority/prototype ref]
- Critical branch: [only when an alternate/error/permission branch changes the user outcome]

## 4. Backend bindings

| Surface / action / read | Canonical contract ref | Trigger | Success meaning | Failure / permission meaning |
|---|---|---|---|---|
| [item] | `tech-spec/contracts.md#...` | [trigger] | [frontend-visible result] | [frontend-visible result] |

Add ordering, pagination, filtering, search, retry, idempotency, realtime, or consistency notes only when they materially constrain the frontend consumer.

Do not copy request/response schemas from `contracts.md`.

## 5. UI-visible state contract

Model states from actual flows and contract outcomes.

| Surface / action | State | Trigger / evidence | Required user-visible behavior |
|---|---|---|---|
| [item] | [state] | [contract outcome or interaction] | [what the user sees/can do] |

Do not add generic loading/empty/error rows when those states do not exist for the surface.

## 6. Cross-boundary constraints

Include only constraints that the frontend must know and must not invent.

| Concern | Binding rule | Authority ref |
|---|---|---|
| [permissions / validation / pagination / time / retry / upload / consistency / etc.] | [rule] | [ref] |

## 7. Open handoff gaps

Omit this section when there are no material gaps.

| Gap | Why it blocks safe handoff | Owner / source needed |
|---|---|---|
| [unknown or contradiction] | [frontend behavior or boundary that cannot be determined] | [PRD / architecture / contracts / user / code evidence] |

Do not resolve a gap by inventing product behavior, backend capability, or mock semantics.
