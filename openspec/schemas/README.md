# ProofLoop Schemas

This directory contains reusable OpenSpec schema packages shipped by ProofLoop.

If you want to install the whole ProofLoop workflow, including agents, skills, and gate documents, use [install/README.md](../../install/README.md) instead of copying only this schema directory.

## Current layout

```text
openspec/schemas/
├── README.md
└── spec-driven/
    ├── schema.yaml
    └── templates/
        ├── proposal.md
        ├── design.md
        ├── spec.md
        └── tasks.md
```

This follows the normal OpenSpec schema layout:

- one schema per folder under `openspec/schemas/<schema-name>/`
- one `schema.yaml` file at the schema root
- one `templates/` folder for artifact templates
- the schema name in `openspec/config.yaml` must match both the folder name and the `name:` field in `schema.yaml`

## How to use this schema in another project

1. Copy `openspec/schemas/spec-driven/` into the target project's `openspec/schemas/spec-driven/`.
2. Copy `openspec/config.yaml.example` into the target project as `openspec/config.yaml`.
3. Keep `schema: spec-driven` unless you intentionally rename the schema package.
4. Replace the project placeholders in `openspec/config.yaml`, especially `Project: <project name>`.
5. Fill in the remaining `context`, `rules`, and optional `traceability` sections for your own project.
6. Copy `openspec/QUALITY-GATE.md` as well if you want the same ProofLoop gate discipline.
7. Run your normal OpenSpec validation command after installation.

## Project placeholders

The example config is intentionally generic. At minimum, users should replace lines like these with project-specific values:

```text
Project: <project name>
Domain: <business domain or product area>
Product boundary: <product boundary; define what the system does and does not do>
```

Keep the reusable schema package name `spec-driven` unless you are intentionally forking the schema itself.

## If you rename the schema

Rename these three places together:

- the folder name under `openspec/schemas/`
- the `name:` field in `schema.yaml`
- the `schema:` field in `openspec/config.yaml`

Do not rename only one of them, or OpenSpec users will see a confusing mismatch between the installed folder and the configured schema.

## What this repository ships

- `spec-driven`: the reusable ProofLoop schema with proposal, design, specs, tasks, and apply-stage instructions.
