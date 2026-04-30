# Repository Guide

## What to read first

1. Read the root `README.md` to understand the repository position.
2. Read `./OpenSpec-Workflow-Customization-Methodology.md` to understand the main methodology.
3. Read `./openspec-migration-pack/README.md` to understand how the migration pack works.
4. Confirm whether the user enables `test-driven-development`.
5. Read `./skills/README.md` and `./skills/openspec-propose/SKILL.md` to understand the skill roles and the primary `propose` migration asset.
6. Read `./openspec-migration-pack/QUALITY-GATE.md` and `USER-GUIDE.md` together.
7. Read `./openspec-migration-pack/schemas/project-schema/README.md` and `config.yaml.example` to understand the schema and project-context skeleton.
8. If the user enables `test-driven-development`, then read `./skills/openspec-apply-change/SKILL.md` and `./skills/test-driven-development/SKILL.md`.
9. Read `./OpenSpec-vs-This-Workflow.md` last if you want the comparison with upstream OpenSpec.

## If this is your first visit

- Start with `README.md`
- Then read `./OpenSpec-vs-This-Workflow.md`
- Then read the main methodology document

## If you want to reuse this workflow

- Start with `./openspec-migration-pack/README.md`
- Then confirm whether `test-driven-development` must be enabled
- Then read `./skills/README.md`
- Then replace the target project's `propose` skill with `./skills/openspec-propose/SKILL.md`
- Then read `config.yaml.example`, `schemas/project-schema/`, and the three gate documents
- If yes, wire in `./skills/openspec-apply-change/SKILL.md`
- Then check whether the target project already has `test-driven-development`; if not, configure it

## If you want to customize this workflow

- Update the main methodology first
- Then update the migration pack overview
- Then update the `skills/` implementations
- Then update the schema skeleton
- Then align the gate documents
- Finally align the redesign notes so they stay in sync with the documented workflow
