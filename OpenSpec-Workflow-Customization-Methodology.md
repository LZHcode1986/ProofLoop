# OpenSpec Workflow Customization Methodology

## 1. Goal

This methodology adapts OpenSpec from a lightweight planning tool into a project-specific constraint system.

It is intended for projects that have:

- clear architecture boundaries
- canonical objects or authority sources
- a state machine or lifecycle model
- recurring drift between planning and implementation
- a desire to keep OpenSpec, but not keep the default template behavior unchanged

It does not aim to:

- push all implementation detail into OpenSpec
- turn OpenSpec into a full project management system
- sacrifice delivery speed for formal completeness

## 2. Core principles

### 2.1 Define project constraints before defining document templates

Do not start by editing templates.

First define:

- project boundaries
- explicit non-goals
- authority sources
- canonical objects
- state machine
- front-end / back-end authority split
- testing and verification standards

Put those constraints into `openspec/config.yaml`.

### 2.2 Fix the main spec before you change generation flow

If the main `openspec/specs/` has already drifted, restore the main spec before adjusting `propose` or schema generation.

Check whether:

- the main spec still serves as the source of truth
- `## ADDED Requirements` still appears where it should not
- `Purpose` is still placeholder text
- the main spec can be read independently of any archived change

### 2.3 Keep customization concentrated in schema and gate logic

Prefer to centralize project constraints into:

- schema
- readiness gate

Do not spread the same rules across:

- prompts
- ad hoc comments
- human memory
- duplicated checklists

### 2.4 OpenSpec should own pre-implementation quality, while implementation stays project-specific

Recommended split:

- OpenSpec owns:
  - proposal
  - design
  - specs
  - tasks
  - archive
- Project implementation rules own:
  - code execution
  - test execution
  - commits and releases
  - runtime verification

## 3. Recommended customization order

### Step 1: Lock project context into `openspec/config.yaml`

At minimum, define:

- project name and domain
- product boundary
- MVP scope
- explicit non-goals
- tech stack
- architecture principles
- state machine
- canonical objects
- API principles
- testing strategy
- documentation language
- authority order

### Step 2: Restore the main `specs/` directory as a formal spec library

The main spec must satisfy:

- consistent file structure
  - `# <capability> Specification`
  - `## Purpose`
  - `## Requirements`
- no change-delta language in the main spec
- `Purpose` is not placeholder prose
- requirements and scenarios can describe the current system behavior on their own

### Step 3: Introduce a custom schema

Create a project schema under `openspec/schemas/<project-schema>/`.

Minimum recommended structure:

- `schema.yaml`
- `templates/proposal.md`
- `templates/design.md`
- `templates/spec.md`
- `templates/tasks.md`
- `openspec/schemas/README.md`

The schema is responsible for:

- defining the shape of planning artifacts
- preserving project-critical information that the default templates would omit
- injecting project constraints into proposal, design, and tasks

### Step 4: Consolidate quality checks into one readiness gate

Do not rely only on `openspec validate`.

`validate` checks structure. It does not check project-level quality.

Add a project-level gate document such as:

- `openspec/QUALITY-GATE.md`

Recommended checks:

- coverage completeness
- authority consistency
- implementability
- archive safety

### Step 5: Lock the `propose` flow through `skills/openspec-propose/SKILL.md`

Do not make the gate a parallel process.

This step is not complete until the target project's existing `propose` skill has been replaced by `skills/openspec-propose/SKILL.md`.

Recommended internal order:

1. source decomposition
2. proposal coverage check
3. design coverage check
4. specs and tasks generation
5. final traceability review
6. final readiness gate

Migration rule:

- `skills/openspec-propose/SKILL.md` is the primary migration asset for `propose`
- `propose-redesign.md` remains only as a design note for that skill
- Do not claim the workflow migration is complete until the target project's original `propose` skill has been replaced

### Step 6: Restore active change discipline

Keep a separate working agreement, for example:

- `openspec/CHANGE-WORKING-AGREEMENT.md`

At minimum, define:

- when to open a new change
- when to update the current change
- when archive is allowed
- where new implementation knowledge must be written back

Key rule:

- finishing tasks is not the same as archiving
- finishing code is not the same as archiving
- a change is ready to archive only after the change is fully closed

### Step 7: Close changes through the upstream archive behavior

Do not maintain a separate archive checklist file.

Use the upstream `archive` workflow directly:

- identify the target change with `openspec list --json` or `openspec status --change "<name>" --json`
- treat incomplete artifacts or incomplete `tasks.md` as warnings only
- prefer `openspec archive "<name>" --yes`
- use `--skip-specs` only for changes that are clearly docs/tooling-only and do not affect the main spec
- do not manually merge delta specs
- do not manually move `openspec/changes/...`

## 4. How to customize each artifact

### 4.1 Proposal customization

A proposal should not only say what changes. It must also say why the change stops where it does.

Recommended sections:

- Why and mapping
- What changes
- Acceptance criteria
- Non-goals
- Risks
- Affected objects
- State transition impact
- Capabilities
- Verification commands

### 4.2 Design customization

The design should make the authority boundary explicit and make impact analysis visible.

Recommended sections:

- Background
- Goals and non-goals
- State transition impact
- Persistence impact
- API / contract impact
- Authority boundary
- Key decisions
- Risks and tradeoffs

### 4.3 Spec customization

The spec should describe current behavior as a stable source of truth.

Recommended pattern:

- consistent capability title
- clear `Purpose`
- requirement-first structure
- scenario-driven requirements
- no change-delta language in the main spec

### 4.4 Task customization

Tasks should be granular enough that the implementer does not need to guess.

Recommended contents:

- explicit file scope
- blocking and foundational tasks
- slice definitions
- independent acceptance criteria per slice
- verification command per task
- parallelizable tasks clearly marked

## 5. Common mistakes

- Editing templates before defining project constraints
- Allowing the main spec to remain in delta form after archive
- Splitting the same rule across multiple notes
- Treating validate as a substitute for a project-level gate
- Letting implementation discoveries stay only in code and never return to the change documents

## 6. Minimal adoption path

If you want the smallest useful version of this methodology, keep only:

- `config.yaml`
- the main spec library
- the custom schema
- the quality gate
- the working agreement
- the archive checklist
- `skills/openspec-propose/SKILL.md`
- `skills/README.md`

Also record one explicit decision and perform one explicit check:

- whether the target project enables `test-driven-development`
- if enabled, whether the target project already has `skills/test-driven-development/SKILL.md`; if not, install it into the OpenSpec skills directory

Rule:

- the agent must ask the user before enabling the TDD-specific `apply` setup
- only after the user enables `test-driven-development` may the agent replace the target project's `apply` skill and write TDD-first rules into config/schema
- once TDD is enabled, the agent must check for the `test-driven-development` skill and help configure it if missing

That is enough to make OpenSpec project-specific without turning it into a heavyweight system.

