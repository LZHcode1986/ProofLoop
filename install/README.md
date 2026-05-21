# Install ProofLoop

ProofLoop now supports two practical installation paths for an existing project:

1. One-command install with PowerShell.
2. AI-assisted install with a ready-made prompt.

The PowerShell installer uses `pwsh`, so it can run on Windows and on other platforms that have PowerShell 7 installed.

## One-command install

From the ProofLoop repository checkout, run:

```powershell
pwsh -File ./install/install-proofloop.ps1 -TargetProjectPath <path-to-target-project>
```

After the repository is published on GitHub, users can also run the bootstrap installer directly from GitHub:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -Command "& {
	$bootstrap = Join-Path $env:TEMP 'proofloop-bootstrap.ps1'
	Invoke-WebRequest 'https://raw.githubusercontent.com/LZHcode1986/ProofLoop/main/install/bootstrap-proofloop.ps1' -OutFile $bootstrap
	& $bootstrap -RepositoryZipUrl 'https://github.com/LZHcode1986/ProofLoop/archive/refs/heads/main.zip' -TargetProjectPath '<path-to-target-project>'
}"
```

## Install destinations

ProofLoop is installed into three scopes by default:

- target project:
	- `AGENTS.md`
	- `openspec/QUALITY-GATE.md`
	- `openspec/config.yaml.example`
	- `openspec/schemas/README.md`
	- `openspec/schemas/spec-driven/`
- user agent home: `$HOME/.opencode/agents`
- user skill home: `$HOME/.agents/skills`

If a user's runtime expects different directories, override them with:

```powershell
pwsh -File ./install/install-proofloop.ps1 `
	-TargetProjectPath <path-to-target-project> `
	-AgentInstallRoot <custom-agent-home> `
	-SkillInstallRoot <custom-skill-home>
```

What the installer does with config:

- if `openspec/config.yaml` does not exist, it creates it from `config.yaml.example`
- if `openspec/config.yaml` already exists, it keeps the file and updates `schema:` to `spec-driven`
- before overwriting installer-managed files, it writes `.spec-driven.bak-<timestamp>` backups

## AI-assisted install

If the user already works with an AI coding agent, use the prompt in [install/agent-install-prompt.md](agent-install-prompt.md).

The expected agent behavior is:

- run the installer script first
- verify both user-home and project-home install targets
- point out any remaining placeholders in `openspec/config.yaml`
- report conflicts instead of silently guessing

## Manual fallback

If a user cannot run the script, use [install/manual-install.md](manual-install.md).
