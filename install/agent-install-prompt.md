# Agent Install Prompt

Use this prompt inside the target project while the ProofLoop repository is also available locally.

```text
Install ProofLoop into this project by using the local ProofLoop installer first.

Inputs:
- Target project root: <target-project-path>
- ProofLoop repository root: <proofloop-repo-path>
- Agent install root: <optional, defaults to $HOME/.opencode>
- Skill install root: <optional, defaults to $HOME/.agents>

Requirements:
1. Prefer the installer script over manual copy.
2. Use PowerShell.
3. Do not rename canonical `openspec-*` skills.
4. If existing files conflict with ProofLoop assets, report the conflict clearly.

Steps:
1. Confirm both paths exist.
2. Run:
   pwsh -File "<proofloop-repo-path>/install/install-proofloop.ps1" -TargetProjectPath "<target-project-path>"
3. Verify that these paths now exist in the target project:
   - AGENTS.md
   - openspec/QUALITY-GATE.md
   - openspec/config.yaml.example
   - openspec/schemas/spec-driven/schema.yaml
4. Verify that these user-home paths now exist:
   - $HOME/.opencode/agents/brain.md
   - $HOME/.opencode/agents/executor.md
   - $HOME/.agents/skills/openspec-propose/SKILL.md
   - $HOME/.agents/skills/workflow-intake/SKILL.md
5. Check that `openspec/config.yaml` uses `schema: spec-driven`.
6. If `openspec/config.yaml` was created from the example, list the placeholders the user still needs to fill, especially `Project: <project name>`.
7. Summarize what was installed, what was backed up, and any follow-up steps.
```
