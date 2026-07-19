# Pre-Code Audit

Run this audit before allowing implementation to begin.

## Scope Audit

- [ ] Must-have scope is explicit.
- [ ] Non-goals are explicit.
- [ ] Future work is not mixed into current implementation.
- [ ] Open questions are not silently treated as decisions.

## Architecture Audit

- [ ] System context is clear.
- [ ] Containers/services are identified.
- [ ] Components have responsibilities and non-responsibilities.
- [ ] Runtime flows cover success, failure, cancel/retry where relevant.
- [ ] Decisions with tradeoffs are recorded.

## Contract Audit

- [ ] API routes and methods are declared.
- [ ] Event streams include payloads and end conditions.
- [ ] File paths and schemas are declared.
- [ ] Data owner and source of truth are declared.
- [ ] Ports are declared.
- [ ] Error behavior is declared.

## AI Drift Audit

- [ ] Hard parts are listed.
- [ ] Forbidden shortcuts are listed.
- [ ] Mock/fake implementation risks are identified.
- [ ] Minimum acceptable implementation is written.
- [ ] Human confirmation points are marked.

## Task Audit

- [ ] Tasks are dependency ordered.
- [ ] Foundational tasks precede feature tasks.
- [ ] Every task has files/modules.
- [ ] Every task has definition of done.
- [ ] Every task has test or acceptance evidence.
- [ ] Every PRD must-have maps to tasks.

## Decision

Implementation may begin only if all blocking checks pass. If not, revise the architecture artifacts or ask the user for clarification.
