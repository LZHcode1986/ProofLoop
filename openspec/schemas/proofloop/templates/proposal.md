## Why
<!-- Remediation mapping (reason and mapping) -->
<!-- Explain why this change is needed and what problem, requirement, or architecture goal it maps to. -->

## Minimum Closed Loop
<!--
Describe the minimum closed loop that makes this change valid using a real entry point / real user path.
Do not only state modules, controllers, or scripts exist.
State how the user enters, what actions they perform, what feedback they see, and what result they get.
-->

## What Changes
<!-- Change content -->
<!-- Describe what will change. Be specific about capability, object, behavior, or constraint. -->

### In Scope
- [specific change item 1]
- [specific change item 2]

### Out of Scope
- [items not included in this change]

## Acceptance Criteria
<!-- Write verifiable pass / fail criteria. At least 3 concrete criteria are recommended. -->

- The real entry point and full user loop must be explicit.
- A failure condition must be explicit, and "can start but cannot be played" must not count as done.
- Acceptance criteria must be decomposable into `tasks.md`.

## Non-goals
<!-- Explicitly state what will not be done to prevent scope drift. -->

## Risks
<!-- Describe known risks and mitigations. -->

## Affected Objects
<!-- Impacted modules, files, interfaces, objects, or systems. -->

## State Transition Impact
<!-- If this involves a state machine or lifecycle flow, describe the impact here. -->

## Capability List

### New Capabilities
<!-- New capabilities. Generate one spec file per capability. -->
- `<capability-name>`: <short description>

### Modified Capabilities
<!-- Fill when changing existing capabilities. Each capability needs one delta spec file. -->
- `<existing-capability-name>`: <description of requirement changes>

## Verification Commands
<!-- List commands used to verify this proposal and later artifacts. -->

## Readiness Gate
- [ ] Aligned with architecture authority
- [ ] Scope, non-goals, risks, and acceptance criteria are listed
- [ ] Affected objects, interfaces, and state transitions are explicit
- [ ] Verification commands are provided

