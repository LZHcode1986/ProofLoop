# tech-spec.md

## 1. 技术栈入口
- Runtime: OpenCode + OpenSpec workflow
- Scripts: PowerShell / Shell
- Data/Storage: repo-local Markdown / YAML artifacts
- Test/Validation: `scripts/local-check.sh` and workflow-specific verification
- Package/runtime dependencies: project-specific, confirm before implementation

## 2. 全局技术规范
- Coding conventions: Follow AGENTS.md for coding guidelines.
- Error handling: Output structured validation errors, do not fail silently.
- Logging: Log validation steps in scripts.
- Config: Keep variables in openspec/config.yaml or environment variables.
- Security/privacy: Sanitize inputs in validation scripts.
- Testing posture: Rely on local verification scripts and adversarial verifications.

## 3. 架构 source of truth
- AI coding architecture: ./ai-coding-architecture.md
- Contract/state matrix: ./contract-state-matrix.md
- Hard parts register: ./hard-parts-register.md
- Task acceptance matrix: ./task-acceptance-matrix.md

## 4. ProofLoop 投影规则
- Propose may project these docs into OpenSpec artifacts.
- Propose must not weaken acceptance criteria.
- Executor must use tasks and evidence requirements derived from OpenSpec artifacts.
- Any architecture drift must update the relevant source document through Brain-authorized General edit.
