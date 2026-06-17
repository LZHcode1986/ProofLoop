# tech-spec.md

## 1. 技术栈入口
- Runtime: Node.js (v18+)
- Backend: Express / TypeScript
- Frontend: HTML / Vanilla CSS / Vanilla JS
- Data/Storage: SQLite
- Test: Jest

## 2. 全局技术规范
- Coding conventions: TypeScript strict mode
- Error handling: Standardized error handling with structured JSON
- Logging: Console logging for server events
- Config: Environment-based configuration
- Security/privacy: No raw SQL, input sanitization
- Testing posture: Unit and integration testing using Jest

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
