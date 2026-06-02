# Manual Install

Use this only when the installer script cannot be run.

## Prerequisites

- An existing target project directory
- PowerShell or another way to copy files
- OpenSpec available in the target project workflow

## Preferred automated command

```powershell
pwsh -File ./install/install-proofloop.ps1 -TargetProjectPath <path-to-target-project>
```

## Manual steps

1. Copy these files into the target project:
   - `AGENTS.md`
   - `tech-spec.md`
   - `tech-spec/architecture.md`
   - `tech-spec/api.md`
   - `tech-spec/state.md`
   - `tech-spec/testing.md`
   - `openspec/QUALITY-GATE.md`
   - `openspec/config.yaml.example`
   - `openspec/schemas/README.md`
   - `openspec/schemas/proofloop-spec-driven/` (and optionally legacy `openspec/schemas/spec-driven/`)
2. Copy `.opencode/agents/` into `<target-project>/.opencode/agents/`.
3. Copy `.agents/contracts/` into `<target-project>/.agents/contracts/`.
4. Copy `.agents/skills/` into `<target-project>/.agents/skills/`.
5. If the target project has no `openspec/config.yaml`, copy `openspec/config.yaml.example` to `openspec/config.yaml`.
6. If `openspec/config.yaml` already exists, update its `schema:` field to `proofloop-spec-driven` (or its legacy alias `spec-driven`).
7. Fill in project-specific values in `openspec/config.yaml`, especially:
   - `Project: <project name>`
   - project boundary
   - MVP scope
   - canonical objects
   - authority order
   - testing posture
8. Run your normal OpenSpec validation command in the target project.

## Recommended validation points

After installation, confirm:

- `openspec/config.yaml` points to `schema: proofloop-spec-driven` (or legacy `spec-driven`)
- `openspec/schemas/proofloop-spec-driven/schema.yaml` exists
- `openspec/QUALITY-GATE.md` exists
- `tech-spec.md` exists
- `tech-spec/` directory with architecture.md, api.md, state.md, testing.md exists
- required agent files exist under `<target-project>/.opencode/agents/`
  - `brain.md`
  - `propose.md`
  - `executor.md`
  - `spec-verifier.md`
  - `reality-verifier.md`
  - optional when selected: `reality-verifier-codegraph.md`
- required contract files exist under `<target-project>/.agents/contracts/`
  - `dispatch-packets.md`
  - `executor-dispatch-packets.md`
- required skill files exist under `<target-project>/.agents/skills/`
