# Execute Project Acceptance Contract

## 触发条件
所有 Stage 已 ACCEPTED，Brain 进入 PROJECT_ACCEPTANCE 阶段

## 调用时序

```text
PROJECT_ACCEPTANCE
1. COMPILE
    → compile-project-acceptance 生成 ProjectAcceptanceManifest JSON
    → 输出 manifest digest

2. RUN E2E
    → run-project-acceptance 执行 Manifest 中的 E2E steps
    → 输出 Project E2E Gate Receipt

3. INDEPENDENT REVIEW
    → 外部 Reviewer（人工或独立 Agent）生成 Project Review Result JSON
    → 结构化审查结果，包含每个 AC 的逐条评估

4. FINALIZE
    → finalize-project-review 读取 Manifest + E2E Receipt + Review Result
    → 验证所有交叉引用一致性
    → 输出最终 Project Review Receipt
```

## 输入

编译阶段（compile-project-acceptance）的输入 JSON 必须包含以下字段：

- `project_id` — 项目标识
- `project_root` — 项目根目录路径（用于计算 expected_snapshot）
- `prd_goals` — PRD 目标列表
- `acceptance_criteria` — 验收标准列表
- `stage_receipts` — 每个 Stage 的证据结构数组：
  ```json
  {
    "stage_id": "S01",
    "stage_manifest": { "path": "...", "digest": "16-char hex" },
    "review_receipt": { "path": "...", "digest": "16-char hex" },
    "gate_receipt":   { "path": "...", "digest": "16-char hex" }
  }
  ```
- `e2e_steps` — E2E 运行时证明步骤数组（RuntimeProofStep 格式）

## 生成（compile）

由 `compile-project-acceptance` 工具生成 `ProjectAcceptanceManifest` JSON：

```jsonc
{
  "project_id": "string",
  "expected_snapshot": "16-char hex digest",
  "prd_goals": ["string", "..."],
  "acceptance_criteria": ["string", "..."],
  "stage_receipts": [
    {
      "stage_id": "S01",
      "stage_manifest": { "path": "string", "digest": "16-char hex" },
      "review_receipt": { "path": "string", "digest": "16-char hex" },
      "gate_receipt":   { "path": "string", "digest": "16-char hex" }
    }
  ],
  "e2e_steps": [ /* RuntimeProofStep array */ ],
  "compiled_at": "ISO timestamp"
}
```

输出 manifest 时同时计算并输出 canonical JSON digest。

输出路径由 CLI 参数指定，例如：
```
node .agents/runtime/dist/compile-project-acceptance.js <input-json> .proofloop/manifests/project-acceptance.json
```

## 执行（run-e2e）

由 `run-project-acceptance` CLI 执行 Manifest 中的 E2E steps：

```
node .agents/runtime/dist/run-project-acceptance.js <manifest-path> [output-dir] [project-root]
```

执行逻辑（`runProjectAcceptance`）：
1. 验证 E2E step 拓扑（start/stop 配对、无孤立步骤）
2. 校验 `expected_snapshot` 与当前工作区快照一致
3. 按顺序执行每个 step
4. 清理所有已注册服务
5. 写入 Project E2E Gate Receipt

Receipt 格式（`ProjectE2EReceiptSchema`）：
- `project_id`
- `verdict`: `"PASS" | "FAIL" | "BLOCKED"`
- `snapshot`: 执行后快照
- `manifest_digest`: Manifest 的 canonical digest
- `expected_snapshot` / `executed_snapshot`
- `steps`: 每个 step 的 exit_code、observations、skipped
- `service_cleanup`: 服务清理结果

Receipt 文件命名：`project-e2e-{project_id}.json`

输出路径示例：`.proofloop/receipts/project-e2e-{project_id}.json`

## Review（独立审查）

Review 由外部独立 Reviewer（人工或独立 Agent）执行，输出结构化 `ProjectReviewResult` JSON：

```jsonc
{
  "verdict": "PROJECT_ACCEPTED | PROJECT_REJECTED | PROJECT_BLOCKED",
  "reviewer": "reviewer name",
  "reviewed_snapshot": "16-char hex",
  "project_manifest": { "path": "string", "digest": "16-char hex" },
  "project_e2e_receipt": { "path": "string", "digest": "16-char hex" },
  "criteria_results": [
    { "criteria": "AC-01", "passed": true, "notes": "optional" }
  ],
  "findings": [],
  "accepted_deviations": [],
  "reviewed_at": "ISO timestamp"
}
```

Reviewer 独立验证：
- 每个 PRD Acceptance Criterion 在 manifest 中有对应评估
- 所有 stage 的 manifest/review/gate receipt 完整且 digest 一致
- E2E steps 能证明 PRD 目标
- 已知限制和 deferred work 被明确记录

## Finalize（最终收束）

由 `finalize-project-review` 工具执行最终验证和出证：

```
node .agents/runtime/dist/finalize-project-review.js <input-json>
```

input JSON 包含：
- `manifestPath`: ProjectAcceptanceManifest 路径
- `e2eReceiptPath`: Project E2E Gate Receipt 路径
- `reviewerResultPath`: Project Review Result JSON 路径
- `outputDir`: 最终 receipt 输出目录

验证逻辑：
1. 读取并 Schema-validate Manifest
2. 计算 Manifest canonical digest
3. 读取并 Schema-validate E2E Receipt（E2E 必须 PASS）
4. 读取并 Schema-validate Review Result（必须 PROJECT_ACCEPTED）
5. 交叉验证：E2E project_id、manifest_digest、expected_snapshot、executed_snapshot 一致性
6. 交叉验证：Reviewer 引用的 manifest/E2E path+digest 一致性
7. 读取每个 Stage 的 manifest、review、gate receipt，进行 triple-binding 验证
8. 验证每个 acceptance_criteria 都有对应的 criteria_result
9. 所有校验通过后写入最终 Project Review Receipt

最终 Receipt 格式（`WriteProjectReviewReceiptOptionsSchema`）：
- `project_id`
- `verdict`: `"PROJECT_ACCEPTED" | "PROJECT_REJECTED" | "PROJECT_BLOCKED"`
- `snapshot`
- `reviewer` / `reviewed_at`
- `findings` / `accepted_deviations`
- `project_manifest` / `project_e2e_receipt`（path+digest）
- `stage_receipts`: 每个 stage 的 review 和 gate receipt（path+digest）
- `criteria_results`

Receipt 文件：`project-review.json`

## 输出

| 步骤 | 输出文件 | 格式 |
|------|----------|------|
| compile | `project-acceptance.json`（路径由 CLI 指定） | ProjectAcceptanceManifest |
| run-e2e | `project-e2e-{project_id}.json` | ProjectE2EReceipt |
| review | 外部文件（如 `project-review-result.json`） | ProjectReviewResult |
| finalize | `project-review.json` | Project Review Receipt |
