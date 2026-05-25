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

## Reality Snapshot
<!--
Document the minimum closed loop against current code reality.
Include the real entry path, key handlers or services, state transitions, persistence objects,
frontend caller path when applicable, key artifacts, and referenced validation docs or commands.
-->

## Critical Runtime Assumptions
<!--
List only the assumptions that matter for the current stage's minimum closed loop.
Each item must include a code anchor or be explicitly marked as unverified.
-->

## Assumptions Verified Against Code
<!--
For each critical runtime assumption, record one of:
- confirmed
- contradicted
- unverified
Include the code anchor, test anchor, or validation-doc anchor used for the judgment.
-->

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
- [ ] Reality snapshot and critical runtime assumptions are explicit
- [ ] Verification commands are provided

