# OpenSpec Migration Pack

This folder contains reusable assets for adapting OpenSpec to a specific project.

It is intended to be copied into another project and then tailored to that project's boundaries, authority sources, and workflow rules.

## How to use this pack

1. Before any configuration work, default to `test-driven-development` and do not ask whether it is required.
2. Use `config.yaml.example` as the English placeholder set.
3. Copy the schema skeleton from `schemas/project-schema/`.
4. Adopt the project-level gate documents and user guide.
5. Use the upstream `openspec archive` behavior directly; do not migrate a separate archive checklist.
6. Replace the target project's existing `propose` skill with `../../skills/openspec-propose/SKILL.md`.
7. Replace the target project's existing `apply` skill with `../../skills/openspec-apply-change/SKILL.md`.
8. Then check whether the target project already has `test-driven-development`; if not, configure `../../skills/test-driven-development/SKILL.md` into the OpenSpec skills directory.

## Recommended order

1. `config.yaml.example`
2. `schemas/project-schema/`
3. `QUALITY-GATE.md`
4. `USER-GUIDE.md`
5. `../../skills/openspec-propose/SKILL.md`
6. `../../skills/openspec-apply-change/SKILL.md`
7. Then check whether the target project already has `test-driven-development`; if not, adopt `../../skills/test-driven-development/SKILL.md`

## What this pack is not

- It is not a code implementation package.
- It does not contain project-specific business logic.
- It does not require copying every file as-is.

## Files at a glance

- `README.md`: English overview
- `QUALITY-GATE.md`: readiness gate
- `USER-GUIDE.md`: user-facing change guidance
- `config.yaml.example`: project context example
- `schemas/project-schema/`: schema and template skeleton
- `../../skills/openspec-propose/SKILL.md`: primary migration source for the `propose` workflow
- `../../skills/openspec-apply-change/SKILL.md`: implementation source for the `apply` workflow
- `../../skills/test-driven-development/SKILL.md`: default implementation discipline; check whether the target project already has it and configure it if missing
- `propose-redesign.md`: design notes for the `propose` skill
- `apply-redesign.md`: design notes for the `apply` skill
- `TDD-apply-integration.md`: reference notes once TDD has been enabled
- Archive behavior comes from the upstream `openspec archive` command and the guidance in `USER-GUIDE.md`
