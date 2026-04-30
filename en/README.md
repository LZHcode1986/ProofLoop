# Let AI Optimize Your OpenSpec Workflow

This repository is a methodology pack for customizing OpenSpec around project constraints.

中文页面: [`../zh/README.md`](../zh/README.md)

Upstream OpenSpec: <https://github.com/Fission-AI/OpenSpec>

Before using this repository, you must complete the base OpenSpec configuration first.

## What this is

- A methodology for adapting OpenSpec to a specific project
- A set of documents for validation, archive usage rules, and change control
- A reusable schema and template skeleton
- A guide for helping AI work according to project constraints

## What problem this solves

OpenSpec works well for lightweight planning, but many projects need stronger constraints.

The common failure modes are:

- `propose` generates documents but leaves gaps
- `tasks.md` is too coarse, so execution falls into guessing, hallucination, or drift
- `archive` syncs specs back into the main library in a way that degrades the source of truth

## What this adds beyond stock OpenSpec

- Project context is defined first: boundaries, authority sources, canonical objects, and state machines
- Schema is used to encode project constraints into templates and generated structure
- Proofability, tasks-readiness, and implementation-done checks decide whether a proposal can enter `apply`
- Active Change rules require implementation discoveries to be written back into documents
- Archive checks prevent the main spec from degrading into leftover change deltas
- Proposal, design, and tasks each have a clearer responsibility
- TDD is the default implementation discipline

## Who it is for

- People who like the lightweight and automated OpenSpec workflow, but need stronger control over project drift
- Projects with clear boundaries, authority sources, canonical objects, or state machines
- New projects that already have a technical direction and want OpenSpec to help with SDD-style execution
- People who want AI to help organize project specifications

## Who it is not for

- Users who do not want to configure OpenSpec
- Projects where a single sentence is enough for AI to understand and start implementing
- Users who do not want to maintain config, schema, or gate documents and just want to start immediately
- Users who do not want AI to follow project rules and prefer free-form generation

## How AI should use this repo

Tell the agent: "Configure this repository for me: https://github.com/LZHcode1986/Openspec-Harness".

When adapting this workflow to another project:

- Replace the target project's existing `propose` skill with `skills/openspec-propose/SKILL.md`
- Replace the target project's `apply` skill with `skills/openspec-apply-change/SKILL.md`
- Check whether the target project already has `test-driven-development`; if not, help configure `skills/test-driven-development/SKILL.md` into the OpenSpec skills directory

## Recommended reading order

1. Read this `README.md` first.
2. Then read [`Repository-Guide.md`](Repository-Guide.md).
3. Then read [`OpenSpec-Workflow-Customization-Methodology.md`](OpenSpec-Workflow-Customization-Methodology.md).
4. Then read [`openspec-migration-pack/README.md`](openspec-migration-pack/README.md).
5. Then read [`../skills/README.md`](../skills/README.md) and [`../skills/openspec-propose/SKILL.md`](../skills/openspec-propose/SKILL.md).
6. Then read the gate documents, schema, `config.yaml.example`, [`../skills/openspec-apply-change/SKILL.md`](../skills/openspec-apply-change/SKILL.md), and [`../skills/test-driven-development/SKILL.md`](../skills/test-driven-development/SKILL.md).
7. Read the comparison page when you want a direct comparison with stock OpenSpec.

## Detailed contents

| Area | English entry | Purpose |
| --- | --- | --- |
| Repository guide | [Repository-Guide.md](Repository-Guide.md) | Reading order and navigation |
| Main methodology | [OpenSpec-Workflow-Customization-Methodology.md](OpenSpec-Workflow-Customization-Methodology.md) | Core methodology |
| Migration pack overview | [openspec-migration-pack/README.md](openspec-migration-pack/README.md) | How to reuse the assets |
| Quality gate | [openspec-migration-pack/QUALITY-GATE.md](openspec-migration-pack/QUALITY-GATE.md) | Proposal readiness check |
| User guide | [openspec-migration-pack/USER-GUIDE.md](openspec-migration-pack/USER-GUIDE.md) | User-facing change guidance |
| Schema example | [openspec-migration-pack/schemas/project-schema/README.md](openspec-migration-pack/schemas/project-schema/README.md) | Project schema skeleton |
| Propose redesign notes | [openspec-migration-pack/propose-redesign.md](openspec-migration-pack/propose-redesign.md) | Required workflow asset for `propose` hardening |
| Apply redesign notes | [openspec-migration-pack/apply-redesign.md](openspec-migration-pack/apply-redesign.md) | Design notes, with apply entering TDD first |
| TDD integration | [openspec-migration-pack/TDD-apply-integration.md](openspec-migration-pack/TDD-apply-integration.md) | Reference for apply-first-TDD flow |
| Comparison page | [OpenSpec-vs-This-Workflow.md](OpenSpec-vs-This-Workflow.md) | Difference from stock OpenSpec |

## License

[MIT](../LICENSE)
