# project-schema Skeleton

This is a reusable OpenSpec schema skeleton for project-specific adaptation.

## Directory layout

- `schema.yaml`: defines artifact order, dependencies, and shared context
- `templates/proposal.md`: proposal template
- `templates/design.md`: design template
- `templates/spec.md`: spec template
- `templates/tasks.md`: task template

## How to use it

- Keep the structure, but replace project-specific names.
- Put project-specific constraints into `schema.yaml`.
- Use the templates to preserve the required artifact shape.
- Encode the default `test-driven-development` requirement in `apply.instruction` instead of stuffing the full TDD flow into the proposal or task body.
- If `tasks.md` explicitly defines implementation-slice verifier gates, represent them as separate boundary-check tasks and make the inspection scope and `PASS/FAIL` conditions explicit.

## Migration principles

- Preserve structure, do not copy project-specific business terms.
- Keep methodology and constraints only.
- Replace all project-specific content with placeholders.

