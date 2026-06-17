# AI Coding Architecture Template

Use this file when creating `ai-coding-architecture.md`.

## 1. Metadata

- Project:
- PRD source:
- Architecture version:
- Date:
- Owner:
- Target implementation scope:
- Status labels used: `confirmed`, `assumed`, `open`

## 2. Product Scope

### Must Implement

- [confirmed] ...

### Explicit Non-Goals

- [confirmed] ...

### Future / Out of Scope

- [confirmed/open] ...

## 3. PRD to Architecture Mapping

| PRD item | Technical implication | Architecture decision needed | Status | Notes |
|---|---|---|---|---|
|  |  |  | confirmed/assumed/open |  |

## 4. Architecture Views

### System Context

- User:
- System:
- External systems:
- Local or cloud boundary:

### Containers

| Container | Responsibility | Technology | Port/path | Persistent state | Notes |
|---|---|---|---|---|---|

### Components

| Component | Responsibility | Does not own | Inputs | Outputs | Dependencies |
|---|---|---|---|---|---|

## 5. Technical Context

- Language/runtime:
- Frameworks:
- Package manager:
- Target platform:
- Dev server ports:
- Backend ports:
- Storage:
- Test runner:
- Build command:
- Start command:
- External dependencies:
- Security/privacy constraints:

## 6. Runtime Flows

For each key flow:

### Flow: [name]

- Trigger:
- Pre-conditions:
- Steps:
- State changes:
- Success result:
- Failure handling:
- Cancel/retry behavior:
- Logs or observability:
- Acceptance evidence:

## 7. Decision Log

| ID | Context | Decision | Consequences | Status |
|---|---|---|---|---|
| ADR-001 |  |  |  | confirmed/assumed/open |

## 8. Open Questions

| Question | Why it matters | Blocking? | Proposed default |
|---|---|---|---|

## 9. Pre-Code Readiness

- [ ] Scope and non-goals are explicit.
- [ ] Critical architecture decisions are labeled.
- [ ] Components have clear owners and boundaries.
- [ ] APIs/events/files/data/state are represented in the contract matrix.
- [ ] Hard parts are registered.
- [ ] Tasks have acceptance checks.
