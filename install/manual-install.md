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
   - `openspec/QUALITY-GATE.md`
   - `openspec/config.yaml.example`
   - `openspec/schemas/README.md`
   - `openspec/schemas/spec-driven/`
2. Copy `agents/` into `$HOME/.opencode/agents/`.
3. Copy `skills/` into `$HOME/.agents/skills/`.
4. If the target project has no `openspec/config.yaml`, copy `openspec/config.yaml.example` to `openspec/config.yaml`.
5. If `openspec/config.yaml` already exists, update its `schema:` field to `spec-driven`.
6. Fill in project-specific values in `openspec/config.yaml`, especially:
   - `Project: <project name>`
   - project boundary
   - MVP scope
   - canonical objects
   - authority order
   - testing posture
7. Run your normal OpenSpec validation command in the target project.

## Recommended validation points

After installation, confirm:

- `openspec/config.yaml` points to `schema: spec-driven`
- `openspec/schemas/spec-driven/schema.yaml` exists
- `openspec/QUALITY-GATE.md` exists
- required agent files exist under `$HOME/.opencode/agents/`
- required skill files exist under `$HOME/.agents/skills/`
