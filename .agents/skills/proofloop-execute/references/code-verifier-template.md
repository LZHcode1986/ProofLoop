# Code Verifier 派发模板

本模板供 `proofloop-execute` 由 Brain 直接调度 Slice-level Code Verifier（CV）使用。CV 是只读的独立反驳者，验证 Worker 形成的 `SLICE_CANDIDATE_READY` 是否真实满足 Slice Goal。它不做 Task-level review，不调用任何旧 CLI，不写 Receipt/Manifest/Evidence/Context。本模型无 Context Evidence gate、无 admission、无 digest 链；finding 只是 evidence，route 由 Brain 决定。`MES_MAINTENANCE` 下 CV 仍只读验证 recovery candidate/Git evidence，不写 MES。

## 派发数据包

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
target_agent: code-verifier
caller: brain
skill: proofloop-execute
verification_type: initial | recheck
stage_id: <stage-id>
slice_id: <slice-id>
project_root: <canonical-trust-root>
thin_plan_ref: <NORMAL=root-relative-accepted-thin-plan; PRE_MES_BOOTSTRAP=root-relative-candidate-or-accepted-Git-Plan-ref; MES_MAINTENANCE=root-relative-recovery-candidate-Thin-Plan-ref>
slice_goal_ref: <ref-id>
authority_refs: []        # Technical Authority: Architecture / Contracts / Acceptance 稳定 ref（CV 不读 PRD）
acceptance_refs: []
maintenance_binding:  # MES_MAINTENANCE only; omitted for NORMAL/PRE_MES_BOOTSTRAP
  frozen_snapshot_ref: <root-relative-frozen-MES-snapshot>
  frozen_snapshot_sha256: <exact-source-sha256>
  frozen_fact_count: <exact-source-fact-count>
  forensic_ref: <root-relative-immutable-incident-ref>
  forensic_sha256: <exact-incident-sha256>
  audit_ref: <root-relative-read-only-audit-ref>
  audit_sha256: <exact-audit-sha256>
actionToken: <current-dispatch-token>
git_basis:
  candidate_ref: <NORMAL=live Slice worktree branch/ref — pre-CV 验证 basis，非 durable canonical proofloop-<stage>-<slice> ref; PRE_MES_BOOTSTRAP=candidate/accepted Git Plan ref; MES_MAINTENANCE=live maintenance Slice worktree branch/ref — pre-CV 验证 basis>
  diff_ref: <root-relative-diff-or-patch-ref — NORMAL/MES_MAINTENANCE=当前待验证 worktree diff; PRE_MES_BOOTSTRAP=baseline/current Git basis diff>
  head: <NORMAL/MES_MAINTENANCE=live worktree 当前 HEAD; PRE_MES_BOOTSTRAP=baseline-Git-HEAD>
tests_ref: <ref>
worker_result_refs: []    # NORMAL=Worker Result refs; PRE_MES_BOOTSTRAP/MES_MAINTENANCE=Worker Subagent transport evidence refs; 仅 supporting evidence，不作为 primary
forbidden_scope:
  - source edits
  - test edits
  - plan edits
  - Evidence edits
  - Receipt writes
  - commits
expected_result: PASS | FINDINGS | BLOCKED
```

## 必需输入

- Slice Goal、Technical Authority/Acceptance 稳定 ref（tech-spec-only，不包含 PRD）、对应模式的 Plan binding、candidate Git ref/diff、real code/tests；`MES_MAINTENANCE` 另需完整 frozen/forensic/audit binding 与 physical quarantine 证据。
- `NORMAL` 使用 accepted Thin Plan 与 MES work identity/resultRef；`PRE_MES_BOOTSTRAP` 仅对首个 MES-persistence Stage 合法，使用 candidate/accepted Git Plan（绑定 canonical Technical Authority refs、baseline/current Git basis、Worker Subagent transport evidence 与 actionToken），不要求 MES status、MES work identity 或 MES `resultRef`；`MES_MAINTENANCE` 使用 recovery candidate Thin Plan + current Technical Authority + live maintenance Git basis + exact frozen/forensic/audit tuple + Brain bounded dispatch authorization，不要求或产生 MES identity/resultRef；CV packet 必须能支撑对应 Worker→CV→Integration 链路。
- Worker Result refs / Worker Subagent transport evidence 仅作 supporting evidence，不替代独立验证；
- 验证 basis 按 mode 显式：`NORMAL` 是 live Slice worktree basis（`candidate_ref` 指向当前 live worktree branch/ref，`head` 绑定该 worktree 当前 HEAD，`diff_ref` 绑定当前待验证 worktree diff）；这不是 durable canonical `proofloop-<stage>-<slice>` candidate ref（后者只在 post-PASS `slice-output` 建立，作为 Integration 输入）；`PRE_MES_BOOTSTRAP` 使用 candidate/accepted Git Plan ref + baseline/current Git basis + Worker Subagent transport evidence；`MES_MAINTENANCE` 使用 recovery candidate Plan ref + live maintenance worktree basis + frozen/forensic/audit binding；后两种 mode 不在 PASS 前发明 durable MES result 或第二 candidate store。
- read-only 约束与 expected result；`MES_MAINTENANCE` 下 CV 可只读核对 frozen snapshot exact digest/count、forensic/audit refs、quarantine 与 isolated fixture 结果，但不得写真实 project MES。
- S06 integrity hard-freeze 时，public `status` 的 `EXECUTE`/`proofloop-execute` 仅是 observation；CV 不接受 NORMAL dispatch/recheck。只有 maintenance packet 的 entry tuple fresh-valid 且 `execution_mode: MES_MAINTENANCE` 时执行 evidence-only CV；否则返回 typed blocker/recovery evidence，不触碰真实 project MES。
- Result binding 按 mode 显式：`NORMAL` 是正式 CV verdict input，由 Brain 接纳/授权后交 MES operational transaction layer materialize；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 是结构化 Subagent transport evidence（binding = execution_mode + authority_refs + candidate/accepted 或 recovery candidate Plan ref + git_basis + maintenance_binding（MES_MAINTENANCE）+ actionToken），不写 MES、不指向 MES resultRef。三种 mode 下 CV 都全程 read-only、独立反驳。

本模型无 Manifest/Evidence skeleton/Receipt/admission/Context gate；CV 输入不需要任何 digest helper 或
Runtime admission。缺任一输入、ref 无法解析或 scope 不闭合时返回 `BLOCKED`，不降级为猜测。

## vNext 验证规则（只读、独立、Slice-level）

被验证的 Slice basis 按 `execution_mode`：`NORMAL` 使用 accepted Thin Plan + candidate Git ref/diff + MES work identity；`PRE_MES_BOOTSTRAP` 使用 candidate/accepted Git Plan + canonical Technical Authority refs + baseline/current Git basis + Worker Subagent transport evidence；`MES_MAINTENANCE` 使用 recovery candidate Plan + canonical Technical Authority refs + live maintenance Git basis + frozen/forensic/audit binding（不读取、不声称 normal MES status/work identity/resultRef）。三种 mode 都在独立反驳完成前不读 Worker Evidence，且全程 read-only。
- 不使用旧 cv_level 或遗留验证分级机制；runtime launch configuration belongs to the selected Host adapter (Pi `.pi/agents/*.md + .pi/subagents.json` or OpenCode `.opencode/agents/*.md`); this Skill does not define it.
- `verification_type: initial`：执行完整、独立的 Slice 反驳顺序。
- `verification_type: recheck`：只覆盖前次 failed criterion、concrete counterexample、repair diff 与 `required_recheck_scope`。
- `initial`/`recheck` action 的 fresh-required、currentness 与 recovery 由 `.agents/contracts/brain/agent-lifecycle.md` 决定；本模板不决定何时 fresh。
- 独立反驳完成前不读 Worker Evidence；先读 Slice Goal、Technical Authority/Acceptance（Architecture / Contracts / Acceptance；不读 PRD）、Plan、code/tests/diff/snapshot；CV 不消费 Brain-projected Slice semantics，自读 Plan 与 tech-spec。
- 对每个 PO 与高风险路径设计并执行 concrete refutation：PO coverage、test/seam/oracle validity、forbidden
  mocks、scope side effects、regression risk 与真实 call path。
- 反驳固定后才允许读取 Worker Evidence，对照独立观察检查 declared proof 是否真的支撑 Slice Goal。
- CV 是只读的，不修改任何项目文件，不派发 Worker，不直接 route Repair/Replan。

## 允许的结果

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
actionToken: <current-dispatch-token>
verdict: PASS | FINDINGS | BLOCKED
stage_id: <stage-id>
slice_id: <slice-id>
verification_type: initial | recheck
planRef: <NORMAL=accepted Thin Plan; PRE_MES_BOOTSTRAP=candidate/accepted Git Plan ref; MES_MAINTENANCE=recovery candidate Thin Plan ref>
authorityRefs: [<canonical-tech-spec-ref>, ...]
maintenanceBinding:  # MES_MAINTENANCE only; omitted for NORMAL/PRE_MES_BOOTSTRAP
  frozenSnapshotRef: <root-relative-frozen-MES-snapshot>
  frozenSnapshotSha256: <exact-source-sha256>
  frozenFactCount: <exact-source-fact-count>
  forensicRef: <root-relative-immutable-incident-ref>
  forensicSha256: <exact-incident-sha256>
  auditRef: <root-relative-read-only-audit-ref>
  auditSha256: <exact-audit-sha256>
gitBasis:
  head: <NORMAL/MES_MAINTENANCE=current live-Git-HEAD; PRE_MES_BOOTSTRAP=baseline-Git-HEAD>
  candidateRef: <candidate Git ref>
  diffRef: <root-relative-diff-or-patch-ref>
resultRef: <NORMAL=root-relative-MES-result-ref; PRE_MES_BOOTSTRAP/MES_MAINTENANCE=omitted>
summary: <non-empty-summary>
acceptance_refs_checked: [<all-bound-acceptance-ref-ids>]
failed_acceptance_refs: []
invalid_tests: []
counterexamples: []
scope_violations: []
forbidden_substitutions: []
regression_failures: []
claimed_route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP | null
# FINDINGS only: failed_criterion, failure_signature and required_recheck_scope are required.
# RECHECK only: previous_failure_signature and repair_diff_basis are required.
```

- `PASS`：无 concrete counterexample 且反驳完成；`NORMAL` 返回 Brain/MES transaction flow，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 返回 evidence-only freeze-and-boundary flow。三种 mode 下只有 PASS 且 durable canonical candidate ref 已建立才允许进入对应 Integration；`MES_MAINTENANCE` 的 Integration 只形成 Git evidence，不形成 MES `INTEGRATED`。
- `FINDINGS`：带 failed criterion、failure signature 与 bounded recheck scope；由 Brain 决定 owner/route
  （典型为 bounded Worker repair 后交给下一次 CV review action）。
- `BLOCKED`：无法验证或超出 CV 权限，带结构化 blocker 回 Brain。
- `REVIEW_RESET_REQUIRED`：只用于要求 fresh full initial 的 lifecycle 信号，不是可替代 `PASS` 的结果。

非成功结果必须包含 `claimed_route_code`、`subtype`、`reason`、`invalidation_scope` 与 `resume_target`；`claimed_route_code` 仅为 CV evidence。CV 不读 PRD，不判断 Product→Technical 权责，claimed_route_code 不包含 `AUTHORITY_GAP`（下游合法问题分类仅限 `IMPLEMENTATION_DEFECT`、`PLAN_GAP`、`TECHNICAL_UNKNOWN`、`RUNTIME_BLOCKER`、`USER_DECISION_REQUIRED`、`EVIDENCE_GAP`）。Finding 仅回 Brain；`NORMAL` 下如适用由 Brain 发起 `FINDING_DISPOSITION` semantic event，经 MES transaction layer materialize，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 下只保留结构化 evidence，不写 MES，不能直接 repair/replan。
Brain 只能把 `PASS` 且 durable canonical candidate ref 已建立的 candidate 交给对应 Integration；`FINDINGS`/`BLOCKED` 先由 Brain 重读 Authority/Plan/scope/code reality；`NORMAL` 按现有 MES disposition，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 保持 evidence-only，不得把 `claimed_route_code` 直接当作 route 或把 finding 改写成通过。

Result binding 按 `execution_mode` 显式：`NORMAL` 是正式 CV verdict input，由 Brain 接纳/授权后经 MES transaction layer materialize（绑定 MES work identity/resultRef）；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 是结构化 Subagent transport evidence（binding = execution_mode + authority_refs + candidate/accepted 或 recovery candidate Plan ref + git_basis + maintenance_binding（MES_MAINTENANCE）+ actionToken），不写 MES、不指向 MES resultRef；三种 mode 下 reply 只出现一次、完整且关联当前 packet。
