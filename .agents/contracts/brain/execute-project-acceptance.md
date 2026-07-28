# Execute Project Acceptance Contract

## 触发条件
所有 Stage 已 ACCEPTED，Brain 进入 PROJECT_ACCEPTANCE 阶段

## 输入
- PRD Goals
- Acceptance Criteria
- final snapshot
- All Stage Review Receipts（路径列表）
- E2E 场景定义
- Manifest 输出路径

## 生成
由 compile-project-acceptance 工具生成 ProjectAcceptanceManifest JSON：
.proofloop/manifests/project-acceptance.json

## 执行
由 run-project-acceptance CLI 执行 E2E steps 并写 Receipt：
.proofloop/receipts/project-e2e-<attempt>.json

## Review
由 Stage Reviewer (review_scope: project) 读取 E2E Receipt 并独立挑战

## 输出
- Project E2E Gate Receipt
- Project Review Verdict
