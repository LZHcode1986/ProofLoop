---
name: test-driven-development
description: Use when a implements behavior, fixes a bug, or changes logic. Enforces a mechanical test-first RED/GREEN/REFACTOR loop against the assigned Worker execution context, with optional reference docs loaded only when needed.
---

# Test-Driven Development

## Core Rule

No production behavior change before a failing behavior test or proof probe.

Work one behavior at a time.

## Required Context

Use only the resolved execution context supplied to the Worker, including when available:

- Task Text
- Task Acceptance Criteria
- Slice Goal
- Slice Acceptance Criteria
- Verification Commands
- Expected Evidence
- Allowed / Forbidden File Scope
- Stop Conditions
- required source refs

Do not ask the user.

Do not invent missing behavior.

Return blocked when the resolved execution context does not provide enough information to identify the behavior under test, verification target, expected evidence, or allowed file scope.

Blocked response:

```text
Implementation blocked: insufficient task context
```

## Optional References

Do not load all reference docs by default. Load only the one needed for the current decision:

- Read `tests.md` when deciding whether a test observes behavior through a public interface.
- Read `mocking.md` before adding or relying on mocks.
- Read `interface-design.md` when the required behavior is hard to test through the current interface.
- Read `refactoring.md` only during REFACTOR.
- Read `deep-modules.md` only when refactor work reveals a shallow or over-wide interface.

Do not use reference docs to broaden product scope or override the assigned task context.

## Choose Test Level

Choose the smallest test or proof that can verify the required behavior.

| Behavior type | Preferred proof |
|---|---|
| Pure logic | Unit test |
| API, database, file system, or component boundary | Integration test |
| Page route, user action, or visible UI result | E2E test or runtime proof |
| Bug fix | Reproduction test that fails before the fix |
| Behavior not suited to automation | Executable inspection or proof from Verification Commands |

Prefer real code paths over mocks.

Use mocks only when real dependencies are unavailable, slow, nondeterministic, or explicitly allowed by the task context.

## TDD Loop

### 1. RED

Write one failing test or proof probe for one required behavior.

The behavior must come from the Worker resolved execution context:

- Task Text
- Task Acceptance Criteria
- Slice Goal
- Slice Acceptance Criteria
- Verification Commands
- Expected Evidence
- Allowed / Forbidden File Scope

The RED test or proof must:

- map to one behavior required by the assigned Task Acceptance Criteria, Slice Goal, or Slice Acceptance Criteria;
- use a public interface or observable behavior;
- stay within Allowed File Scope;
- fail before implementation;
- fail for the expected reason.

Run the narrowest command that executes this test or proof.

If it passes immediately, the RED step is invalid. Replace it with a test or proof that demonstrates the required behavior is currently missing or broken.

If it fails because of typo, import error, invalid setup, or unrelated environment failure, fix the test setup and rerun until the failure proves the target behavior is missing.

If the resolved execution context does not provide enough information to identify the behavior under test, return blocked instead of inferring product intent:

```text
Implementation blocked: insufficient task context
```

### 2. VERIFY RED

Record the RED evidence before writing production code:

```text
RED:
- behavior:
- test/probe:
- command:
- expected failure:
- actual failure:
```

Do not write production code until RED is valid.

### 3. GREEN

Implement the smallest change that makes the RED test or proof pass.

Rules:

- stay within Allowed File Scope;
- do not add behavior outside the assigned Task Acceptance Criteria, Slice Goal, or Slice Acceptance Criteria;
- do not weaken, delete, or skip the RED test;
- do not refactor unrelated code;
- do not fix unrelated issues unless required by the current behavior.

Run the same narrow test or proof command used for RED.

### 4. VERIFY GREEN

The GREEN step is valid only when:

- the RED test or proof now passes;
- required local checks from the task context also pass;
- no tests were skipped, deleted, or weakened.

Record:

```text
GREEN:
- changed files:
- command:
- passing result:
```

### 5. REFACTOR

Refactor only after GREEN is valid.

Allowed:

- remove duplication;
- improve names;
- simplify structure;
- move complexity behind the same public interface.

Forbidden:

- adding behavior;
- changing acceptance semantics;
- broadening scope;
- skipping relevant checks after refactor.

After refactor, rerun the relevant test or proof command.

Record:

```text
REFACTOR:
- done: yes/no
- changed files:
- command:
- passing result:
```

## Proof Profile

If the assigned task matches a profile in `.agents/contracts/proof-profiles.md`, record the selected profile and satisfy its minimum evidence.

If no profile fits, use:

```text
Proof Profile: None
```

Do not broaden implementation scope to force a profile match.

## Completion Record

Before marking the task complete, record:

```text
Proof Profile: <profile-name | None>

TDD Cycle:
- RED evidence:
- GREEN evidence:
- REFACTOR evidence:

Mapping:
- Task Acceptance Criteria, Slice Goal, or Slice Acceptance Criteria:
- why this test/proof verifies it:

Residual Risk:
- untested risk:
- blocked risk:
```

## Stop Conditions

Return blocked instead of guessing when:

- behavior under test is ambiguous;
- verification target is missing;
- expected evidence is missing;
- allowed file scope is missing;
- required runtime dependency is unavailable;
- implementation requires forbidden files;
- the required behavior is outside the assigned task or slice context;
- the only possible proof would rely on unauthorized mocks, secrets, external services, or interactive setup.
```