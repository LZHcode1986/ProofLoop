# Contract & State Matrix — ProofLoop v2 通用 CLI 与 OpenCode Plugin

> 权威来源：`PRD.md` FR-001..019；kernel 契约（`packages/kernel/src/contracts.ts`、`validators.ts`、`types.ts`）；runtime 服务（`packages/runtime/src/*`）。`ProofLoop_pluginv2_流程优化方案.md` 仅作为 pluginv2 技术设计参考。状态标注：confirmed / assumed / open。`contracts.ts` 的 16 值 `ReceiptType` 是 canonical source。

## 0. Harness-neutral CLI Public Contract（S10 主表面）

### 0.1 Stable invocation

```text
proofloop <domain> <operation> --request <root-relative-json> [--project-root <path>]
proofloop <domain> <operation> --json <closed-json> [--project-root <path>]
```

- Public executable：`proofloop`。现有 `node packages/runtime/dist/cli/*.js` 只作为迁移期内部
  entry，不是不同 harness 各自的公共合同。
- Harness boundary：CLI 不 import 或调用 OpenCode、Pi、Claude Code SDK/tool API；Agent 只需
  shell/command 权限。更换 harness 只能修改 Agent 定义和权限，不能修改 CLI command/schema。
- Input：closed JSON object；unknown field fail closed。`--request` 必须 root-bound/no-follow；
  `--json` 用于不可持久化或测试输入。caller 提供的 `project_root` 只是对 canonical root 的
  一致性断言，不能覆盖 trust root。
- Output：stdout 恰好一个 canonical JSON envelope；成功和 domain refusal 都不得输出自然语言
  前缀。stderr 只用于非合同诊断，不得承载唯一 Finding。
- Exit：`0=command completed/accepted/read-ready`；`2=structured blocked/refused/no-write`；
  `1=usage/schema/runtime failure/no-write`；`130=cancelled`。退出码不能替代 JSON verdict。
- Write boundary：CLI dispatcher/adapter 不直接写 Receipt/Manifest/Context/Evidence；只能调用
  对应 Runtime public owner。Agent 语义输出只能通过 closed role/result command 受理，不提供
  任意文件写命令。

### 0.2 Canonical CLI result envelope

```yaml
schema_version: 2
ok: true | false
command:
  domain: authority | plan | context | stage | review | project | doctor
  operation: <closed operation>
result: <bounded operation projection | null>
findings: []
refs:
  - ref: <root-relative ref>
    digest: <64-hex>
runtime:
  version: <semver>
  schema_version: <number>
```

- `ok:false` + Finding 可以是正常的 fail-closed 机械结果；不得伪装成进程崩溃或省略 JSON。
- Receipt/Manifest/Context 正文不进入 `refs`；只返回 ref+digest。需要角色内容时使用
  `context show`，并重新验证 digest/identity。
- source API、built CLI、重启后 CLI 对相同 fixture 的 canonical envelope 必须一致。

### 0.3 Closed command matrix

| Domain | Operations | Mechanical responsibility | Role/phase output |
|---|---|---|---|
| `authority` | `check` | 验证 Brain/Authority Skill 已选择的 Authority entity refs、root/digest 和 closed handoff shape；不判断用户是否确认或正文是否正确 | Planning/Architecture mechanical handoff + refs/Findings |
| `plan` | `materialize`, `compile`, `validate`, `initialize-evidence`, `refresh-evidence`, `status`, `admit-spv`, `admit-stage-plan` | 保存 closed AI plan input/candidate；编译 Manifest；机械验证；初始化或安全刷新 Evidence skeleton；受理初始或 Replan epoch 的 SPV 与 Stage Plan authority | candidate/Manifest/Evidence/SPV/Stage Plan/epoch refs |
| `context` | `prepare`, `show`, `admit-refutation-observation` | 按 target action/role 生成或读取 content-addressed Context；CV 反驳观察固定后才解锁 Evidence read | Planning/SPV/Worker/CV/Committer/Reviewer 的不同 Context ref/content |
| `stage` | `status`, `next`, `admit-worker`, `admit-cv`, `admit-slice-commit`, `admit-integration`, `run-gate` | Stage state/next；受理 AI/Committer 结构化结果；执行并受理 Gate | NextAction/Context/Receipt/Gate refs |
| `review` | `status`, `prepare-stage`, `finalize-stage` | 组装 Stage Review Context；受理 ACCEPTED/REPAIR | Review Context / Stage Review Receipt |
| `project` | `status`, `compile-acceptance`, `run-e2e`, `prepare-review`, `finalize-review` | 项目验收 Manifest、E2E Gate、Project Review Context/Receipt | Project refs/verdict |
| `doctor` | `run` | Runtime/CLI 版本、Git、project root、schema、commands/services、filesystem capability；Host API 项仅在 adapter 自身诊断 | structured diagnostics |

Unknown domain/operation 必须在任何 filesystem write 前返回 `RUNTIME.SCHEMA_MISMATCH`。

- §0.3 是 public `proofloop` operation 的唯一权威清单；插件目标面 §1.1 的
  `admit_spv_result` 等命名不是 public CLI alias，不得混用。source `runPlan`、built CLI 和
  parity fixture 必须断言同一 closed set。
- Replan 不新增 public CLI 或 operation：现有 `plan materialize` 的 `mode: replan`、
  `plan compile`、`plan validate`、`plan refresh-evidence`、`plan admit-spv` 与
  `plan admit-stage-plan` 通过扩展 request/result contract 接入 Replan epoch；Materializer
  仍只负责 candidate `tasks.md`，影响判定和 epoch 事实由独立 Runtime seam 负责。
- `stage admit-cv` 也不新增 operation：CLI result envelope 的 `schema_version: 2` 是外层
  command contract；嵌套 `CV_RESULT.schema_version` 是独立 credential discriminator，闭集为
  `2 | 3`。Manifest 无 binding 时只允许 v2；Manifest 为 `slice-local` 时只允许 v3 + 三个
  binding digests。source adapter、built CLI、public dispatcher、shared validator、CV consumer
  和 restart reader 必须保持同一判别，不能以外层版本挡掉合法 v3，也不能降级 v3 为 v2。

### 0.4 Role-specific Context contract

| Target role | Required minimum projection | Forbidden projection |
|---|---|---|
| Planning/Materializer | selected AWI、Authority refs、constraints、out-of-scope、existing findings | 完整仓库/无关 Authority、Manifest/Receipt 写权限 |
| SPV | Stage goal、candidate Plan、Proof Index、Authority digests、Git snapshot、Evidence skeleton refs | Worker output、执行完成声明 |
| Worker | 一个 Task、Slice goal、acceptance/seam/oracle/risk refs、skills、Evidence path、allowed/forbidden scope、current snapshot | 其他 Task 实现范围、Receipt/Manifest 写权限 |
| Initial CV | pre-refutation Authority/goal/proof、代码/测试/diff/snapshot refs；`evidence_read:false` | Worker Evidence 正文/摘要（观察固定前） |
| CV recheck | previous criterion/counterexample/signature、repair diff、required regression scope、current bindings | 无关 Slice 或扩大后的验收范围 |
| Committer/Integrator | accepted CV/Task Receipt refs、精确 Git boundary、changed-file set、expected HEAD/index/worktree | 语义修复、额外文件、Receipt 直写 |
| Stage Reviewer | Stage goal、integrated snapshot、Stage Gate/CV/Slice refs、unresolved findings、Authority refs | 未集成工作、Agent narrative 代替 persisted facts |
| Project Reviewer | PRD goals/AC refs、全部 accepted Stage Review/Gate refs、E2E Receipt、limitations | 缺失 Stage 的口头完成声明 |

所有 Context 都写入 `.proofloop/context/<context-digest>.json`，write-once、可重建、Agent
不可编辑；`context show` 在返回内容前重新验证 root、digest、Manifest/Plan/snapshot binding。

## 1. Tool Contracts（插件工具表面）

> 本节是 CLI 成熟后的 OpenCode adapter 目标，不是 S10 self-host 主表面。Plugin tools
> 必须复用 Runtime public services，并与 §0 CLI parity；不得作为 CLI 缺失 operation 的替代。

### 1.1 proofloop_plan — visible: Brain / planning capability
| Operation | Input (canonical) | Output | Producer | Verification |
|---|---|---|---|---|
| compile | candidate input, manifest path | ToolResult + manifest ref/digest | Runtime vNext compiler（候选，不授权执行） | parity vs active compiler |
| initialize_evidence | manifest_path, project_root | ToolResult + evidence ref | runtime cli/initialize-slice-evidence 语义 | parity |
| validate | tasks_path, manifest_path, evidence_dir | ToolResult {valid, findings} | runtime cli/validate-stage 语义 | parity |
| admit_spv_result | stage_id, verdict(SPV_PASS), manifest_digest, summary | AdmitResult {accepted, receipt_ref, new_state, findings} | Runtime SPV admission；不等同 Stage Plan admission | parity vs Runtime admission |
| status | stage_id, project_root | 状态摘要（≤1000 字符） | reconcileStage + compact renderer | spec |

> §1.1 边界：当前 Host plan surface 与 active vNext Stage Plan admission 必须区分。Stage Plan admission 是 Runtime-owned execution boundary；在 Host operation 尚未闭合前，只能通过 allowlisted Runtime seam 完成，不能由 Planner/Brain 手写 Receipt，也不能把 `SPV_PASS` 单独当作执行授权。

### 1.2 proofloop_stage — visible: Brain / execution capability
| Operation | Status | Input (canonical) | Output | Producer | Verification |
|---|---|---|---|---|---|
| status | implemented（S08 v1/vNext 显式分流） | stage_id, project_root | 状态摘要（≤1000 字符） | Runtime route-specific status projection | parity vs vNext CLI |
| next | implemented（S08 v1/vNext 显式分流） | stage_id, project_root, manifest_path?, tasks_path? | 唯一 NextAction + 最小 ContextRef + manifest/plan/proof/snapshot digests；≤1500 字符 | Runtime NextAction/Context Resolver | parity vs active Runtime vNext seam |
| admit_worker_result | implemented（S08 v1/vNext 显式分流） | stage_id, slice_id, envelope(WorkerResultEnvelope) | AdmitResult | admission.admitWorkerResult | parity vs vNext CLI |
| admit_cv_result | implemented（S08 v1/vNext 显式分流） | stage_id, slice_id, verdict(PASS/REPAIR), snapshotDigest, summary | AdmitResult | admission.admitCVResult | parity vs vNext CLI |
| admit_slice_commit | implemented（S08 v1/vNext 显式分流） | stage_id, slice_id, commit_sha, cv_receipt_digest | AdmitResult | admission.admitSliceCommit | parity vs vNext CLI |
| admit_integration | implemented（S08 v1/vNext 显式分流） | stage_id, slice_id, commit_sha, integration_ref | AdmitResult | admission.admitIntegration | parity vs vNext CLI |
| run_gate | planned (S5; not exposed by current S3 surface) | stage_id, project_root | gate-result {success, gate, steps, errors} + internal gate-result admission | runGate + admitGateResult | parity vs CLI run-gate |

### 1.3 proofloop_review — visible: stage-reviewer, brain
| Operation | Input | Output | Producer | Verification |
|---|---|---|---|---|
| stage_status | stage_id | 状态摘要 | reconcileStage | spec |
| prepare_stage_review | stage_id, scope 输入准备 | ReviewInput 组装 | 只读组装（无 Receipt 写入） | spec |
| finalize_stage_review | stage_id, verdict(ACCEPTED/REPAIR), summary | AdmitResult（REPAIR 为 no-Receipt warn 分支） | admission.admitStageReview（v1/vNext 显式分流） | parity vs vNext CLI |

### 1.4 proofloop_project — visible: brain, project-reviewer
| Operation | Status | Input | Output | Producer | Verification |
|---|---|---|---|---|---|
| compile_acceptance | planned (S5) | project_id, prd_goals, acceptance_criteria, stage_receipts, e2e_steps | Manifest ref/digest | project-acceptance.compileProjectAcceptance | parity |
| run_e2e | planned (S5) | manifest_path | E2E Receipt ref（PROJECT_E2E_PASS/FAIL/BLOCKED） | project-acceptance.runProjectAcceptanceE2E | parity |
| prepare_review | planned (S5) | — | ReviewInput 组装 | 只读 | spec |
| finalize_review | planned (S5) | manifest_path, e2e_receipt_path, reviewer_result_path | Project Review Receipt ref | project-acceptance.finalizeProjectReview | parity |
| status | planned (S5) | project_root | 项目状态摘要 | reconcile | spec |

### 1.5 proofloop_doctor — visible: brain, planning/execution capability
| Check | Input | Output |
|---|---|---|
| runtime/plugin 版本 | — | 版本对比结果 |
| Git | project_root | branch/HEAD/dirty |
| 项目命令与服务 | CommandSpec | 执行结果 |
| artifact 根 | project_root | .proofloop 存在性与权限 |
| Receipt schema 版本 | — | schema 版本匹配 |
| Host API compatibility | — | 兼容矩阵检查结果 |

## 2. Event / Hook Contracts

| Hook | Trigger | Behavior | Error condition | Verification |
|---|---|---|---|---|
| protect-artifacts | 写操作目标命中受保护路径 | **fail-closed** `tool.execute.before`/`command.execute.before` 抛结构化 host-policy 错误（OC-0 实测可阻止执行） | 非 ProofLoop 项目不启用 | hook 测试 + host integration |
| invalidate-cache | 文件/Git/命令变化 | 设置 stage_cache_dirty=true（`tool.execute.after` 观察——被阻止的调用不触发 after） | — | hook 测试 |
| command-policy | 命令执行 | fail-closed 阻止旧 runtime CLI/拼接 shell/未声明 cwd | 非 ProofLoop 不启用 | hook 测试 |
| compact-context | 上下文压缩（`experimental.session.compacting`） | 注入最小恢复指针（≤3 行）；OC-0 未实测触发 → 保留宿主集成测试 | 不注入事实正文 | hook 测试 + token benchmark |

## 3. File / Artifact Contracts

| Path | Producer | Consumer | Format | Required fields | Lifecycle | Validation |
|---|---|---|---|---|---|---|
| `.proofloop/runtime.lock` | 项目初始化（Brain/插件） | 插件加载 | JSON | runtime_version, domain_schema_version, risk_policy_version, capability_policy_version, host_adapter, plugin_package, plugin_version | 版本不兼容 → fail closed | kernel `validateRuntimeLock` |
| `.proofloop/manifests/<stage>.json` | Runtime v1/vNext compiler | runtime 全链 | JSON（Manifest） | v1 legacy schema 或 v2 `plan`、`reference_index`、Proof Index、dependencies、skills、Evidence paths、structured Runtime Proof | 不可变（digest 绑定）；v2 不静默解释 v1 | kernel v1/vNext validator |
| `.proofloop/manifests/project-acceptance.json` | compile_acceptance | run_e2e/finalize | JSON | project_id, expected_snapshot, prd_goals, acceptance_criteria, stage_receipts, e2e_steps | 不可变 | project-acceptance schema |
| `.proofloop/receipts/**`（8 类目录） | runtime admit 管线 | reconcile/readers | JSON（Receipt） | type(16 值), stage_id, digest, previous_digest, payload | 不可变 + chain | active vNext 使用 kernel `writeReceiptBounded`/`ensureBoundedReceiptDirectory`/`validateReceipt`；显式 v1 compatibility 才可使用 legacy `writeReceipt`；**受保护路径** |
| `.proofloop/receipts/plan/<stage>/epochs/<epoch>/**` | Runtime Replan epoch admission | current epoch readers / Gate / Review | epoch-qualified SPV/Stage Plan Receipt refs | parent epoch, impact disposition, Manifest/Plan/snapshot bindings | append-only；旧 epoch 不覆盖 | root-bound epoch chain、parent/digest/currentness 校验；不依赖 mutable current pointer |
| `.proofloop/runtime/**` | runtime CLI / gate facts | reconcile / gate / doctor | JSON | stage-scoped derived facts | 可重建派生物；不改变 Receipt 权威 | **受保护路径** |
| `.proofloop/logs/**` | Runtime CLI / adapter logger | 诊断 | 文本 | — | 追加 | — |
| `.proofloop/context/<digest>.json` | Runtime Context Resolver（经 CLI/adapter） | 当前 role Agent / admission | JSON（derived Context） | role/action、input refs/digests、snapshot、scope、self digest | write-once、可重建、非 Receipt authority | root/digest/identity + source bindings |
| `delivery/stages/<stage>/candidate-input.json` | Brain closed input → `plan materialize` | Runtime materializer/compiler | closed JSON | schema/caller/owner/refs/goals/slices/tasks/scope | candidate transient source；不是第二权威 | CLI schema/entity/path checks |
| `delivery/stages/<stage>/tasks.md` | Active Plan Materializer → Committer boundary | Runtime compiler / SPV / Context Resolver | Markdown + checkbox | Stage 头 + SLICE 区块 + `- [ ] T-id:` 行 | candidate → final Git boundary before SPV；checkbox/status 仍是人类投影（非权威） | entity/ref/plan digest + clean Git gate |
| `delivery/stages/<stage>/evidence/<slice>.md` | Runtime Evidence initializer/refresh before SPV → Worker → CV | SPV / Runtime / CV | Markdown | Plan/Manifest/Proof Index binding + Task Evidence + Current Slice Evidence + Current CV Status | skeleton 必须在 final Git boundary 前存在；manifest 变化只允许 Runtime 对 pre-admission pristine skeleton 原子 refresh；已有执行内容后不可覆盖 | manifest evidence_path + pristine-template parser + receipt/status absence + clean Git gate + CV contract |
| `delivery/stages/<stage>/evidence/history/<epoch>/<slice>.md` | Runtime Replan Evidence rotation | audit/recovery only；不得作为当前 Evidence path | archived Markdown | 原 Evidence 内容、旧 binding、epoch/parent refs、archive digest | append-only；不得作为当前 Worker/CV Evidence | root-bound/no-follow、旧文件 identity/digest、epoch chain；Brain/Worker 不可写 |

## 4. Data Model / Schema

| Entity | Fields | Source of truth | Read/write owner | Validation | Migration risk |
|---|---|---|---|---|---|
| StageId | canonical `^S\d+$`（例如 `S09`、`S10`） | Runtime Stage request contract | 写：Plan/Runtime request owner；读：compiler/Validator/status/admit | candidate parser、strict compiler、Validator、status/admit 必须使用同一 grammar；旧 `S08B0`/`S08B` label fail closed | Stage label 修正需重新 materialize/compile/Evidence boundary/fresh SPV，不能改 admitted artifact |
| Receipt | type, stage_id, slice_id?, digest, previous_digest, timestamp, payload | `contracts.ts` `ReceiptType`（16 值） | 写：runtime admit 管线；读：reconcile | validateReceipt（16 值闭集） | 旧 Receipt 不自动迁移（显式命令） |
| Manifest | stage_id, slices, runtime_proof；v2 另含 plan/reference_index/Proof Index/digests | kernel contracts.ts + vNext contracts | 写：Runtime compiler；读：Runtime | validate v1/vNext schema | 版本演进需重新编译；不得隐式迁移 |
| RuntimeLock | 版本字段集 | kernel contracts.ts | 写：项目初始化 | validateRuntimeLock | fail closed |
| AdmissionRequest | type(10 值), stage_id, slice_id?, payload | runtime admission-request.ts | 写：工具调用方 | assertAdmissionRequest | — |
| NextActionOutput | action(15 闭集), action_detail, responsible_role, receipt_chain_valid, findings | kernel types.ts + runtime next-action-service | 读：工具调用方 | ROLE_CLOSED_SET/action 闭集 | — |
| CliResultEnvelope | schema_version, ok, command{domain,operation}, result, findings, refs, runtime | §0.2 + Runtime command adapters | 写：CLI dispatcher；读：任意 harness Agent | closed domain/op + canonical JSON + ref/digest | command/schema 变化需版本化；不能按 harness 分叉 |
| RoleContext | role/action, authority/plan/proof refs, bindings, snapshot, role-specific fields, context_digest | Context Resolver Contract | 写：Runtime；读：目标 Agent/admission | role projection matrix + self digest + root/identity | stale binding 重新生成；Agent 不可编辑 |
| ExecutableRuntimeProofStep | id, type(`command\|service_start\|service_stop\|probe`), executable, args, cwd, timeout_ms, expected；按 type 可有 readiness_signal/service_ref；`not_applicable.reason` 为显式例外 | kernel Runtime Proof contract + S09 seam | 写：Plan Materializer closed input；digest：Runtime；执行：Gate runner | unknown field/type、非 root cwd、非正 timeout、caller-supplied digest fail closed；S10 至少一个 executable step | schema/type 变化需重新 compile/refresh/fresh SPV |
| EvidenceRefreshRequest | stage_id, manifest_ref/digest, expected_previous_manifest_digest, evidence refs, `mode` (`refresh`\|`recover`\|`rollback`\|`replan`) | S09 seam + Replan epoch seam | 写：Runtime `plan refresh-evidence`；读：Planning/SPV/epoch admission | `refresh|recover|rollback` 仅 pre-admission pristine；`replan` 绑定 current/parent epoch、Disposition 并执行安全 rotation；全量预检 + transaction journal + compare-and-swap | 任何 non-pristine/stale/symlink、父链不一致或未恢复 transaction 直接阻断 |
| ReplanDisposition | stage_id, parent_epoch_digest, `impact_scope` (`task-local`\|`slice-wide`), changed_task_ids, carry_forward_task_ids, invalidated_task_ids, previous/new plan+Manifest digests | Runtime `replan-impact` | 写：Runtime `plan refresh-evidence(mode=replan)` preparation；读：epoch/admission/next | 前后 current Manifest/Task contract、依赖闭包、Receipt/Evidence/scope 全部可重建；caller 不得提供派生集合 | 误判会导致静默复用或无谓重做；无法判定必须 no-write |
| ReplanEpoch | epoch_digest, parent_epoch_digest?, stage_id, disposition_digest, current Manifest/Plan/snapshot digests, SPV/Stage Plan refs | Runtime `replan-epoch` + existing vNext SPV/Stage Plan admission | 写：现有 `plan admit-spv` / `plan admit-stage-plan` 的 epoch 扩展；读：next/Worker/CV/Commit/Integration/Gate/Review | epoch digest、父链、current epoch、receipt refs 和 Git snapshot 一致；不新增 ReceiptType | 旧 epoch 只作历史；当前 epoch 只能由完整 append-only chain 派生 |
| VNextCvResultEnvelope | nested `CV_RESULT`：`schema_version` (`2`\|`3`), `type`, stage/slice/Worker tip/Manifest/Plan/Proof Index/Context/snapshot bindings, verification/refs/findings；v3 另含 `stage_contract_digest`, `slice_contract_digest`, `execution_binding_digest` | Code Verifier → `stage admit-cv` → shared validator → vNext CV consumer | 写：Runtime CV admission；读：`stage next`/Gate/Review/currentness | Manifest mode gate、Worker tip、Context、Proof Index、epoch/path/snapshot 与三层 binding 全部一致；v2/v3 混链 fail-closed | 外层 CLI schema 2 不得遮蔽 nested v3；v3 不得被 v2 consumer 消费 |

### 4.1 Legacy Receipt compatibility read policy

- **Canonical set**：读取侧只把 `packages/kernel/src/contracts.ts` 导出的 16 值 `ReceiptType` 视为当前格式；`packages/kernel/src/types.ts` 中未导出的 13 值 `Receipt.type` 仅作为 legacy 形状记录，不得作为新的 Receipt 类型注册来源。
- **Legacy detection**：Receipt 能识别为旧格式但不满足当前 16 值/当前 schema 时，使用现有 `RUNTIME.SCHEMA_MISMATCH`，并在 finding detail 中标注 `LEGACY_RECEIPT_DETECTED`；保留原文件、停止将其纳入新的 chain，不自动迁移或重写。
- **Chain distinction**：当前 schema 合法但 `previous_digest` 链接或 digest 校验失败时，使用现有 `RUNTIME.RECEIPT_CHAIN_BROKEN`；既不是已知 legacy 也不是合法当前 schema 时，使用 `RUNTIME.SCHEMA_MISMATCH`。三者在读取策略上不得混用。
- **Migration boundary**：只有显式 migration 命令可以生成新格式 Receipt；普通 `status` / `next` / review 读取不得隐式迁移 legacy 文件。
- **Active vNext write boundary**：v2 Manifest/Worker Receipt 不得进入 legacy writer；active vNext 必须使用
  root-bound directory scaffolding、`O_DIRECTORY|O_NOFOLLOW`、root-fd anchored operations、no-replace
  final install、writer-time file identity 和 bounded readback/rollback；缺少安全 filesystem capability
  时必须在写入前 fail closed。
- **Accepted platform residual**：纯 Node API 无法提供 `openat2/openat` 的 syscall-atomic containment；
  恶意进程在最后 identity check 后整体移动 trusted root/parent inode 的极端 race 作为已记录 residual，
  不得描述为正常流程会生成目录外文档。若未来要求绝对 adversarial containment，必须引入 native helper
  或在不支持的平台整体 fail closed。

## 5. State Machines（kernel 权威，插件只读）

| State machine | States | Valid transitions | Persistence | UI reflection |
|---|---|---|---|---|
| StageState | UNINITIALIZED, PLANNING, READY, EXECUTING, UNDER_REVIEW, COMPLETED | kernel `transitionStage`（闭集） | Receipt 派生（reconcile） | stage status 工具 |
| SliceState | PLANNED, IN_PROGRESS, READY_FOR_CV, CV_IN_PROGRESS, CV_PASSED, INTEGRATING, INTEGRATED | kernel `transitionSlice`（7 值闭集） | Receipt 派生 | stage status |
| CVStatus | NOT_STARTED, READY_FOR_CV, IN_PROGRESS, PASS, REPAIR, PENDING_RECHECK | kernel `transitionCv`（6 值闭集） | CV receipt / vNext execution fact 派生 | proofloop_stage(status/next) + Context/Evidence projection |
| ProjectState | IN_PROGRESS, UNDER_REVIEW, COMPLETED, DEFERRED | kernel `transitionProject`（4 值闭集）；PROJECT_E2E_* 不触发 COMPLETED | PROJECT_REVIEW_PASS receipt | project status |

> `GATE_INTERRUPTED` 是 ReceiptType，不是任何状态机状态。它表示 gate 被取消或超时；可重跑，且不会把 Slice 推进为 `INTEGRATED`、不会等同于 `GATE_FAIL` 或 `GATE_PASS`。

## 5.1 pluginv2 vNext contracts（S08）

以下合同是从已确认 PRD 和当前 Runtime 实现边界派生的 S08 技术 authority。它们补充
现有工具合同，但不改变 kernel 状态机或 Receipt 类型；candidate `tasks.md` 只能通过
稳定 entity ref 引用它们。

### S08-A routing seam
<!-- proofloop:entity id="PLUGINV2-S08-A-SEAM" kind="seam" -->
- Public seam：`proofloop_plan(status/validate)`、`proofloop_stage(status/next)`、
  `proofloop_review(stage_status)` 的真实 Host tool 入口，以及 Runtime 对显式
  `version: 1` / `version: 2` Manifest 的 route selection。
- Boundary：v2 只能进入 vNext consumer；v1 保持 legacy boundary；未知 schema、跨版本
  输入和不可信路径返回 structured Finding，不调用另一版本的 consumer。
- Owner：Runtime 派生 route，Host 只做 canonical-root/path assertion 和结果投影。

### S08-B Stage Plan admission seam
<!-- proofloop:entity id="PLUGINV2-S08-B-SEAM" kind="seam" -->
- Public seam：Runtime vNext Stage Plan admission API/CLI `admit-vnext-stage-plan.js`。
  输入必须包含 v2 schema、root-bound `manifest_path`、`stage_id`、`manifest_digest`、
  `plan_digest`、`snapshot_digest` 和 kernel-valid fresh SPV；`snapshot_digest` 必须等于
  canonical Git HEAD。
- Boundary：candidate Plan、candidate input 和 Evidence skeleton 先进入最终且 clean 的
  Git boundary；Runtime 再校验 Manifest/reference bindings、SPV binding、当前 HEAD 和
  worktree clean 状态，以 write-once 方式写入 v2 SPV/Stage Plan authority。Brain/Agent
  不直接写 Receipt，candidate 或 SPV_PASS 单独不能授权执行。
- Stability：SPV `PLAN_READY` 后，若 Authority、Plan、Manifest binding 和 snapshot 未变化，
  `next/context` 继续消费现有 admission，不重复 SPV。
- Failure：目标已存在、字段未知、digest 不匹配、root escape、schema 不合法、HEAD 变化
  或 dirty worktree 时 fail closed，不覆盖旧 Receipt；只有真实边界变化才重新 fresh SPV。

### S08-C next/context seam
<!-- proofloop:entity id="PLUGINV2-S08-C-SEAM" kind="seam" -->
- Public seam：`proofloop_stage(next)` 的 Runtime vNext dispatch projection。
- Output boundary：合法结果包含唯一 action、owner、stage/slice/task、`context_ref`、
  `manifest_digest`、`plan_digest`、`proof_index_digest`、`snapshot_digest` 和
  `receipt_chain_valid`；Context 只包含当前 Task 所需的 goal/proof refs、skills、
  Evidence path，以及由 admitted Plan 投影的 root-bound execution scope。
  implement Task 的 scope 必须包含非空 `code_paths`、`test_paths` 和显式
  `forbidden_paths`；scope 参与 immutable `plan_digest`，不得由 Brain/Worker 补造。
- Failure：缺少 admission、依赖完成事实、Context identity、任何 digest binding 或
  implement Task 的 executable scope 时只返回 bounded `VALIDATE`，不持久化可执行
  Context authority，也不派发 Worker。不得使用 Evidence-only 默认 scope。

### S08-D parity/security seam
<!-- proofloop:entity id="PLUGINV2-S08-D-SEAM" kind="seam" -->
- Public seam：同一 fixture 的 Runtime source/dist、Runtime CLI、Host tool 与真实
  filesystem/Git 边界；验证结果比较 action、Finding、Receipt/digest 和 fail-closed
  行为，而不是只比较内部函数返回值。
- Required boundary：root-bound canonical paths、no-follow read、manifest/context
  identity re-check、TOCTOU closure、v1/v2 paired fixture、未 admission 的 next 以及
  会话重启恢复。
- Owner：Runtime/kernel 保持语义与 Receipt 权威；Host 仅适配，不重新实现派生或受理。

### S08-E formal execution loop seam
<!-- proofloop:entity id="PLUGINV2-S08-E-SEAM" kind="seam" -->
- Public seam：`proofloop_stage(admit_worker_result/admit_cv_result/admit_slice_commit/
  admit_integration)`、`proofloop_review(prepare_stage_review/finalize_stage_review)` 和
  Runtime 的 vNext state/receipt consumers。它们必须通过真实 Host tool 入口进入同一
  Runtime admission pipeline；不能把 v2 envelope 交给 legacy reconcile/reducer。
- State boundary：Stage Plan admission 之后，Runtime 从 persisted facts 依次投影
  `DISPATCH_WORKER → TASK_COMPLETE → RUN_CV → CV_PASS/CV_REPAIR → SLICE_COMMIT →
  INTEGRATION → STAGE_GATE → STAGE_REVIEW`。每个动作只能由唯一 owner 触发，不能由
  checkbox、progress 或 Agent narrative 推进。
- Git boundary：Plan/Evidence 的 final clean Git boundary 只属于 SPV/admission 前的
  planning boundary。admission 后，Worker/CV 修复产生的 dirty diff 只要完全落在当前
  admitted execution scope 内就是预期执行状态；`next` 不得再次执行 planning clean gate，
  但必须继续校验当前 Manifest/Plan/Context/snapshot 和 changed-file boundary。
- Binding：Worker、CV、Slice Commit、Integration、Gate 和 Review 的每个 vNext fact
  必须绑定当前 Stage/Manifest/Plan、适用的 Context 或前序 Receipt digest，以及执行期
  snapshot；legacy v1 Receipt/Manifest/consumer 不得静默混入 vNext Slice。
- Recovery：`recover-task` 是已产生实现成果的 consistency recheck，必须有明确的
  persisted/admissible mode discriminator；恢复不能重新实现 Task，也不能用
  `implement-task` 叙事替代缺失的 recovery binding。
- Failure：缺少 vNext consumer、state transition、digest/snapshot binding、scope
  或前序 Receipt 时，Runtime 返回结构化 blocker，不写错误 Receipt，也不回退到 v1。

## 5.2 pluginv2 harness-neutral CLI/self-host contracts（S10）

### S10 harness-neutral CLI seam（稳定 entity id 保留历史 `S08B` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B-CLI-SEAM" kind="seam" -->
- Public seam：§0 的 `proofloop <domain> <operation>` 是唯一 harness-neutral public CLI。
  它必须覆盖 Authority/Plan preflight 与 materialization、Manifest/Validator/Evidence/SPV/
  Stage Plan admission、role Context、Worker/CV/Commit/Integration/Gate、Stage Review、Project
  Acceptance、doctor/recovery。现有单用途脚本只能作为内部迁移入口。
- AI/CLI boundary：AI 负责解释用户、维护 Authority、规划、实现、反驳和评审；CLI 只消费
  closed AI output，按当前持久事实生成角色 Context，机械验证并交给 Runtime owner 保存。
  不提供 generic prompt、任意文件写或“替 AI 判断”的 operation。
- Role transfer：Planning/SPV/Worker/CV/Committer/Stage Reviewer/Project Reviewer 使用 §0.5
  的不同 Context。`context prepare/show` 的 output 必须受 ref/digest/snapshot 绑定，不能由
  Brain 复制完整文档或手工拼 Packet。Initial CV 的 Evidence 继续受反驳观察 gate 保护。
- Preflight：任何写 command 必须在同一调用内重复校验相关 precondition（read-only）；ready 只代表机械制品满足，不代表
  AI 语义 verdict。
- Persistence：candidate、Manifest、Evidence skeleton、Context、Receipt、Gate/Review/Project
  facts 只能由其 Runtime owner 落盘；CLI 返回 ref+digest。Agent 直接写 Evidence/tasks mutable
  projection 仍受 admitted scope 和后续 admission 校验，不因此成为完成权威。
- Self-host：S10 final Plan boundary 依赖 §5.3 的 S09 bootstrap；S10 Manifest 必须包含
  至少一个 executable Runtime Proof step，不能以全量 `not_applicable` 证明 AWI-023。S10-A
  CLI bootstrap commit/integration 后，S10 的 next/context、后续 Slice admissions、Gate 和
  Stage Review 必须全部走真实 built `proofloop`。全过程记录发现/修复/重试事实。
- Harness independence：process-level tests 用同一 built executable/request fixture 模拟
  OpenCode、Pi、Claude Code caller；测试不得 import `packages/opencode-plugin`、harness SDK
  或注入 Host tool result。不同 harness 仅有 Agent prompt/permission fixture 差异。
- Cutover：先全流程 CLI/source/dist/self-host/restart oracle 全绿，再迁移旧 parity oracle，
  最后删除 v1 stage CLI consumer、`sync-cv-status`/`cv_level`、旧注释和 Host legacy 权限；
  后续 plugin adapter 不属于该删除前置。
- Failure：unknown domain/op、legacy/unknown/cross-version、stale Authority/Plan/Manifest/
  Context/snapshot、root escape、不完整 envelope、非法 transition 和 broken Receipt chain 均
  canonical Finding + no-write；不得 fallback、放宽断言或以 Host tool 成功掩盖 CLI 缺口。
- Known failures：三个既有 Host 失败先按 canonical public CLI behavior 判根因；Runtime/CLI
  错误在本阶段修复并增加 public CLI regression；纯 OpenCode adapter 错误记录为后续 Plugin
  Finding，不得为追求全仓绿而把 adapter 实现混入 S10，也不得放宽 canonical CLI 断言。
- Out of scope：S08-REVIEW-010 Runtime Proof 回填及其 Manifest/Gate/Review 重验单独排期。

## 5.3 executable Runtime Proof / Evidence refresh bootstrap contracts（S09）

### S09 bootstrap seam（稳定 entity id 保留历史 `S08B0` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B0-BOOTSTRAP-SEAM" kind="seam" -->
- Candidate proof input：`runtime_proof` 仍是 closed object，仅含 `spec_refs`、
  `resolved_steps`；每个 step 只能是 canonical executable step 或显式
  `not_applicable{reason}`。Executable step 的必需字段为 `id`、`type`、`executable`、`args`、
  `cwd`、`timeout_ms`、`expected`；type 闭集为 `command | service_start | service_stop | probe`，
  `service_start` 可增加 `readiness_signal`，`service_stop` 可增加 `service_ref`。unknown field/type、
  空 executable、非 string args、非 root-bound cwd、非正整数 timeout 必须在 compile 写入前拒绝。
- Digest owner：caller/Materializer 不得提供 `proof_digest`；Runtime 只从 `spec_refs +
  resolved_steps` canonical projection 计算并写入 Manifest。任何 supplied/mismatched digest fail
  closed。candidate parser、strict compiler、dispatch preflight 与 Gate runner 使用同一 schema，
  不得维护 `service_probe/file_assertion` 等第二组 type。
- Canonical Stage ID：Runtime request 的 `stage_id` 只接受 `^S\d+$`；candidate parser、strict
  compiler、Validator、status 与 admission 必须共用同一规则。旧 `S08B0`/`S08B` 只作历史导航，
  不得进入 Runtime request；S09 必须为该 parity 缺口增加 regression。
- Formal S10 rule：S10 的 ProofSpecification 必须至少包含一个 executable step；
  `not_applicable` 只允许用于个别不适用步骤。S09 因创建该 seam 可使用一次性 all-skipped
  bootstrap exception，但必须在 Evidence/Review 标记 restricted，不能计入 AWI-023 或项目验收。
- Refresh operation：`proofloop plan refresh-evidence` 保持既有 pre-admission 模式，并新增
  显式 `mode: replan` 的 post-admission Runtime-owned Evidence rotation 模式。
  `refresh|recover|rollback` 只接受当前 Manifest ref/digest、expected previous Manifest digest
  和 Manifest 声明的全部 Evidence paths；在任何写入前验证 Stage 尚无 Stage Plan/execution Receipt、
  每个文件仍严格匹配 initializer 的 pristine template（无 Task/Current Evidence、CV=NOT_RUN、
  无 Receipt/Finding）、path root-bound/no-follow 且 old binding 一致。
- `mode: replan` 必须绑定 current/parent epoch、Runtime-derived ReplanDisposition 和新 Manifest；
  它允许对已 admission 的 Stage 执行安全 Evidence rotation，但不改变 immutable Plan/Manifest，
  不直接写 Gate/Review/Worker Receipt。旧 Evidence 先归档，当前 canonical path 再生成新的
  skeleton；任何无法安全轮换的情况按 `REPLAN.EVIDENCE_ROTATION_BLOCKED` fail-closed。
- Transaction：全部 Evidence 先完成 parse/identity/binding 预检，再建立 Runtime transaction
  journal，并以 bounded temp + expected-file-binding compare-and-swap 逐文件更新。成功必须覆盖 Manifest
  声明的全部 Evidence；中断/写失败必须按 journal rollback 或在重启后返回 blocked recovery，绝不能
  把部分更新报告为成功。对 pre-admission 模式，任一 non-pristine、缺失、额外文件、stale digest、
  symlink 或竞态在写前 no-write，且不改变 checkbox/Task/CV 状态。对 `mode: replan`，同样使用
  journal/compare-and-swap，只在 Runtime bounded mutable projection scope 内恢复 carry-forward 状态；
  epoch Receipt 仍只能由后续 `admit-spv` / `admit-stage-plan` 写入，任何中断必须返回 blocked recovery。
- `mode: replan` 的 public request 最小字段为 `stage`、`mode: "replan"`、当前 canonical
  Manifest 的 digest/ref、`previous_manifest_digest` 和 `parent_epoch_digest`；Runtime 从 current
  epoch、前后 Manifest/Task contract、Receipt/Evidence/Git facts 派生并持久化
  `ReplanDisposition`，caller 不得提供 impact/carry-forward/invalidated 集合或 disposition digest。
  成功 result 必须返回 disposition、archive/current Evidence 与 rotation journal refs/digests；失败
  返回 typed finding 并保证 no-write 或可验证 rollback。
- Bootstrap process：S09 使用当前 active seam 完成 restricted admission；实现并验证上述能力后
  Stage close。随后 S10 由 Materializer replan 为 executable proof，Runtime recompile 并用
  `refresh-evidence` 更新当前 blocked skeleton，再建立 final clean boundary/fresh SPV/admission。

## 6. Ports and Runtime Configuration

| Service | Port | Protocol | Start command | Env | Notes |
|---|---|---|---|---|---|
| 通用 ProofLoop CLI | — | 本地子进程 | `proofloop <domain> <operation>`（repo bootstrap 可用 built entry） | — | S10 主机械表面；harness-neutral；structured JSON |
| 插件（opencode 内嵌） | — | 进程内 | 开发期 `.opencode/plugins/**` 自动加载；发布期 `opencode.json` 使用 npm 包名 | — | CLI 成熟后完善；直接调用 Runtime service，不 shell CLI |
| E2E/Gate 证明步骤 | — | 子进程 | CommandSpec（executable, args, cwd, timeout_ms, expected） | 继承 | process-runner 管理（超时/树清理） |

## 7. Error Contracts

| Error source | Internal error | User-facing message | Logged details | Recovery path |
|---|---|---|---|---|
| 输入非法 | RUNTIME.SCHEMA_MISMATCH / PLAN.* / TASK.* / CV.* / SLICE.* / INTEGRATION.* / STAGE.GATE.* / ARTIFACT.* / HOST.* | 结构化 Finding（code, severity, message） | 完整日志 .proofloop/logs/ | 修正输入重试 |
| 产品/技术权威缺失 | AUTHORITY_GAP + subtype | 阻断当前规划或执行，不由 candidate/Agent 补写事实 | finding、受影响 refs 和恢复阶段 | 返回 Authority Readiness 路由 |
| 权限拒绝（角色不符） | HOST.CAPABILITY.MISSING | 工具不可用提示 | 调用者 agent + 工具 + 期望角色 | 换正确角色；execute(context.agent) 二次校验（OC-0 定稿） |
| 取消（abort） | AbortError（协作式） | 工具停止执行并返回取消 | 取消信号来源 | 重试；不得吞掉取消 |
| 版本不兼容 | RUNTIME.LOCK_MISMATCH（fail closed） | 提示升级/降级 | 期望 vs 实际版本 | 更新 lock 或插件版本 |
| 直接写受保护路径 | ARTIFACT.PATH.PROTECTED | 阻止原因 | 目标路径 + 调用者 | 通过 admit 管线 |
| Receipt chain 断裂 | RUNTIME.CHAIN_BROKEN | 阻断 + 定位断裂点 | 断裂详情 | 修复/审计（不自动改） |
| 已识别旧 Receipt | RUNTIME.SCHEMA_MISMATCH（detail: LEGACY_RECEIPT_DETECTED） | 阻断读取侧链入并提示显式迁移 | legacy 版本/type 与路径 | 显式 migration；不得自动改写 |
| 未知 Receipt 结构 | RUNTIME.SCHEMA_MISMATCH | 结构化拒绝 | schema 校验详情 | 修正或显式迁移 |

## Contract Gate

- [x] 每个工具操作有输入/输出/生产者/验证（§1）
- [x] 每个持久化文件有 owner 与 schema（§3）
- [x] 每个 hook 有触发/行为/错误（§2）
- [x] 每个用户可见错误有日志与结构化输出（§7）
- [x] 状态机有合法转移与持久化（§5）
- [x] 宿主 API 能力矩阵 → `host-compatibility.md` 已记录 OC-0 结论；未覆盖触发路径保留为集成验证项（HOST 部分）

## 8. 整改契约：Slice 级证明绑定（2026-08-15，承接架构文档 §10）

### 8.1 Manifest binding 字段 schema（closed）

```jsonc
{
  "binding": {                          // 可选：无该字段 = legacy stage-wide 模式
    "version": 1,                       // 固定值 1；未知 → fail-closed
    "mode": "slice-local",              // 闭集：仅 "slice-local"
    "stage_contract_digest": "<sha256>" // 唯一 Stage 全局契约指纹
  },
  "slices": [
    {
      "slice_id": "S12-A",
      "proof_index": { /* 现有字段不变 */ },
      "required_skills": [],
      "depends_on": [],
      "evidence_path": "delivery/stages/S12/evidence/S12-A.md",
      "slice_contract_digest": "<sha256>"   // 新增（slice-local 模式必填）
    }
  ]
}
```

- 未知 / 缺失 / 畸形 binding 字段 → 沿用现有 manifest 校验模式 fail-closed。
- 一个 Stage 的 receipts 禁止混用两种模式；mode 判别在 admission 侧执行。

### 8.1.1 Candidate binding mode propagation（closed）

`candidate-input.json` 的顶层可选字段 `binding_mode` 是计划到 Manifest 的模式判别输入：

- 缺省或不提供 `binding_mode` → legacy stage-wide；现有 Stage 与旧 candidate 行为零变化。
- `binding_mode: "slice-local"` → active Materializer 保留该字段，candidate adapter 传递到 `CompileVNextManifestInput`，public `plan compile` 输出 §8.1 的 `binding` 与每 Slice `slice_contract_digest`。
- 任何其他值、类型错误或传播链中字段被静默丢弃 → fail-closed；不得通过直接调用内部 Compiler 绕过 candidate → public CLI 边界。
- 该字段属于 immutable planning input；改变它必须重新 compile/validate、刷新 pre-admission Evidence、建立 clean Git boundary、fresh SPV 并重新 admission。

### 8.2 三级指纹 canonical projection（closed 字段清单）

| 指纹 | Canonical projection 字段 | 计算入口（唯一） |
|---|---|---|
| `stage_contract_digest` | `binding_schema_version:1`、`stage_id`、`stage_node{id,kind,goal,refs[],dependencies[],required_skills[]}`（Plan stage 节点不可变投影）、`stage_reference_bindings[{kind,ref_id,file_digest,section_digest}]`（仅 stage 直接引用） | `kernel/src/vnext/bindings.ts`（新增） |
| `slice_contract_digest` | `binding_schema_version:1`、`stage_id`、`slice_id`、`proof_index{...}`、`required_skills[]`、`depends_on[]`、`evidence_path`、`task_scopes{taskId:{task_ref,execution_scope{kind,code_paths[],test_paths[],forbidden_paths[]}}}`（仅本 slice task_refs）、`reference_bindings[{kind,ref_id,file_digest,section_digest}]`（slice 引用闭包） | 同上 |
| `execution_binding_digest` | `binding_schema_version:1`、`stage_id`、`slice_id`、`stage_contract_digest`、`slice_contract_digest`、`dependency_bindings[{slice_id,slice_contract_digest,integration_receipt_digest,integration_head_sha}]`、`base_snapshot_digest` | 同上 |

- 引用 digest 基于 entity-resolver 规范化文本（checkbox/Worker Status/CV Status 已规范化），不被 mutable 投影污染。
- 禁止在 compiler/admission/next 复制 hash 逻辑；全部走 kernel 唯一入口。

### 8.3 Receipt schema 版本演进与消费策略

| payload.schema_version | 含义 | binding 字段 | legacy 消费方 | vNext(2) 消费方 | 需要的判别改动 |
|---|---|---|---|---|---|
| 1 | legacy | 无 | 正常 | 不消费 legacy | — |
| 2 | 当前 vNext | 无 | 整链阻塞（既有 `legacyTaskSchemaFinding`，≠1 即 block） | 正常 | — |
| 3 | slice-local | 必填三 digest | 整链阻塞（≠1 已覆盖） | **显式 fail-closed，不得静默忽略** | 新增 v2→v3 判别与路由 |

- 新 Receipt 字段（schema_version 3 的 Worker/CV/Slice Commit/Integration payload）：`stage_contract_digest`、`slice_contract_digest`、`execution_binding_digest`。
- admission 时仍严格验证派发时点 revision；旧结果不得静默按新 Plan 受理。

### 8.4 新增错误码（实施时定稿 closed 值）

| 错误码（建议） | 触发 | 处理 |
|---|---|---|
| `BINDING.STAGE_CONTRACT_STALE` | stage_contract_digest 不 current | 阻断该 Slice 继续；按失效规则全量失效 |
| `BINDING.SLICE_CONTRACT_STALE` | slice_contract_digest 不 current | 该 Slice 失效重跑（+ 逆依赖闭包） |
| `BINDING.EXECUTION_BINDING_STALE` | 依赖绑定 / 基线快照不 current | 阻断派发/集成；重建立执行绑定 |
| `BINDING.MODE_MIXED` | 同一 Stage 出现两种模式凭证 | fail-closed，禁止混链 |
| `BINDING.SCHEMA_FUTURE` | schema_version 3 进入 v2 消费端 | fail-closed，提示升级消费端 |
| `BINDING.CV_ROUTE_MODE_MISMATCH` | nested CV_RESULT 的 v2/v3 discriminator 与 Manifest binding mode 不一致，或 public route 未按闭集转发 | fail-closed；不写 CV Receipt；修复 source/dist/public parity |
| `EVIDENCE_BINDING_MISMATCH`（行为变更，FR-023） | slice-local 模式下 validate | 已受理且当前有效的 Slice 豁免；其余照旧 fail-closed |
| `REPLAN.IMPACT_UNRESOLVED` | Runtime 无法证明 Task-local / Slice-wide 影响范围 | no-write；停止当前 Replan，要求重新建立边界 |
| `REPLAN.PARENT_EPOCH_MISMATCH` | Replan 请求未绑定当前 epoch 或父链不一致 | no-write；不得创建新 admission authority |
| `REPLAN.CURRENT_AUTHORITY_MISSING` | current epoch/Stage Plan/SPV 链不可重建 | no-write；保留旧事实，转 recovery/authority audit |
| `REPLAN.EVIDENCE_ROTATION_BLOCKED` | 旧 Evidence 无法安全归档、identity 不匹配或轮换事务未恢复 | no-write/blocked；不得覆盖旧 Evidence |

### 8.5 Slice currentness 状态维度（slice-local 模式）

| 状态 | 含义 | 可恢复动作 |
|---|---|---|
| `CURRENT` | stage/slice contract + 依赖绑定 + receipt chain 均 current | 正常推进 |
| `STALE_CONTRACT` | 自身 slice_contract_digest 变化 | 重跑该 Slice（含逆依赖闭包） |
| `STALE_DEPENDENCY` | 依赖 Slice 的集成事实变化 | 重跑该 Slice |
| `INVALIDATED` | stage_contract_digest 变化 | 全部重跑 |

- 已集成且 CURRENT 的 Slice：继续有效，不因整本 plan_digest/manifest_digest 历史不同自动失效。
- 执行中未集成的 Slice：不整体自动跨 Plan revision carry forward；Task-local 时，之前已接纳
  `TASK_COMPLETE` 且 Task contract 未变的前置 Task 可保留；当前/受影响 Task 不 carry forward。
- 若 Replan 影响此前 Task 的目标、验收含义、证明边界、依赖或 execution_scope，则升级为
  Slice-wide，Slice 内旧成果全部不作为当前授权。
- REPLAN 为 global barrier：OPEN → BARRIER_ACTIVE（停新动作）→ RECONCILED（重规划 + fresh SPV + 新 admission 后按失效规则重算）。

### 8.6 失效规则矩阵（对应 FR-020 验收 Case 1-6）

| 场景 | stage_contract | slice_contract(A/B) | slice_contract(C) | A/B 证明 | C 证明 | Stage Gate |
|---|---|---|---|---|---|---|
| 只改 C | 不变 | 不变 | 变 | 有效 | 失效重跑 | 重跑 |
| A→C→D，改 A | 不变 | A 变、B 不变 | C 变 | A 失效、B 有效 | C/D 失效 | 重跑 |
| Stage 全局契约变 | 变 | 全变 | 变 | 全部失效 | 全部失效 | 重跑 |
| 只改 runtime proof | 不变 | 不变 | 不变 | 有效 | 有效 | 重跑 |
| 权威 ref 只被 A 引用且改变 | 不变 | A 变、B 不变 | 不变 | A 失效、B 有效 | 有效 | 重跑 |
| 旧模式（无 binding） | n/a | n/a | n/a | 行为与现状完全一致 | 行为与现状完全一致 | 行为与现状完全一致 |

Task-local / Slice-wide Task 级补充规则：

| 场景 | 之前 Task `TASK_COMPLETE` | 当前 Replan Task | 后续 Task | 可 carry-forward | 当前 Gate/Review |
|---|---|---|---|---|---|
| Task-local，前置 contract 未变 | 保留 | invalidated，重做 | 受影响闭包 invalidated，重做 | 仅之前且 digest 完全匹配的 Task | 新 epoch 重新执行 |
| Slice-wide，前置成果受影响 | historical only | invalidated，重做 | invalidated，重做 | 无 | 新 epoch 重新执行 |
| 影响范围无法判定 | 不改变旧事实 | 不授权 | 不授权 | 无 | no-write / blocked |

### 8.7 集成与提交契约（slice-local 模式）

- Integration Receipt 新增字段（实施时按现有 receipt 字段核实定稿）：`integration_head_sha`（合并后 canonical HEAD）。
- Slice Commit 新模式：只提交 implementation code / tests / Slice Evidence；CV Receipt 通过 digest 关联（本阶段仅绑定字段；changed-file 边界行为切换在 Phase 2，ADR-021）。
- Gate：绑定当前 Replan epoch、完整 plan_digest/manifest_digest 与 integrated snapshot；每个新 epoch
  必须重新执行 Gate/Review，旧 Gate/Review 不复用；新模式不依赖 tasks checkbox（本阶段仅预留）。

### 8.8 分级 Replan / epoch / Evidence rotation contract

<!-- proofloop:entity id="PLUGINV2-REPLAN-EPOCH-CONTRACT-SEAM" kind="seam" -->

#### Public route and ownership

- 不新增 public CLI 或 operation。现有链的职责保持分离：
  `plan materialize(mode=replan)` 只渲染 candidate `tasks.md`；`plan compile` 生成 Manifest；
  `plan validate` 只读验证；`plan refresh-evidence(mode=replan)` 由 Runtime 计算并保存
  Replan disposition/完成 Evidence rotation；`plan admit-spv` 与 `plan admit-stage-plan`
  在现有 admission seam 上接纳新的 epoch authority。
- Materializer 不计算 impact、不读 Receipt、不写 Manifest/Evidence/Receipt；
  `replan-impact` 与 `replan-epoch` 是独立 Runtime module。CLI adapter 只做 request/path
  校验和 seam 转发，不复制判定逻辑。
- Brain/Agent 不提供 `impact_scope`、`carry_forward_task_ids`、`invalidated_task_ids` 或
  `epoch_digest` 作为可信事实；这些字段由 Runtime 从 current epoch、前后 Manifest/Task
  contract、Receipt/Evidence/Git 事实派生。

<!-- proofloop:entity id="PLUGINV2-REPLAN-ROTATION-CONTRACT-SEAM" kind="seam" -->

Contract seam：`plan refresh-evidence(mode=replan)` 是唯一 public Replan preparation/Evidence
rotation 入口；它只接收 current/parent binding 和 Manifest digest/ref，Runtime 负责 disposition、
archive、transaction journal、CAS/rollback 与 bounded projection recovery。

<!-- proofloop:entity id="PLUGINV2-SLICE-LOCAL-CV-CONTRACT-SEAM" kind="seam" -->

Contract seam：`stage admit-cv` 的 nested `CV_RESULT` 使用 v2/v3 closed discriminator；slice-local
仅允许 v3 binding credential，外层 CLI envelope 版本不改变；source/dist/public route 与 shared
consumer 必须保持同一语义。

#### Replan disposition schema（Runtime-derived）

```jsonc
{
  "schema_version": 1,
  "stage_id": "S13",
  "parent_epoch_digest": "<sha256>",
  "impact_scope": "task-local", // task-local | slice-wide
  "changed_task_ids": ["S13-A-T01"],
  "carry_forward_task_ids": ["S13-A-T00"],
  "invalidated_task_ids": ["S13-A-T01", "S13-A-T02"],
  "previous_manifest_digest": "<sha256>",
  "manifest_digest": "<sha256>",
  "previous_plan_digest": "<sha256>",
  "plan_digest": "<sha256>",
  "snapshot_digest": "<git-sha1>"
}
```

- `impact_scope` 判定：Stage contract、Slice proof index、权威引用、前置 Task 的目标/验收/证明
  refs/dependencies/required_skills/execution_scope 任一变化，或依赖闭包无法证明时，必须
  `slice-wide` 或直接 `REPLAN.IMPACT_UNRESOLVED`；不得降级为 `task-local`。
- `carry_forward_task_ids` 只能包含 changed set 之前、Task contract digest 完全匹配且有
  合法 Runtime `TASK_COMPLETE` 的 Task；当前被 replan 的 Task 绝不 carry forward。
- Disposition 的 canonical digest 由 Runtime 计算并写入 `.proofloop/runtime/replan/**` 的
  Runtime-owned preparation fact；它不是 Agent/Plan 的第二权威，也不能脱离 parent/current
  epoch 使用。admission 前需重新验证其 root、Manifest、Evidence、Receipt chain 和 snapshot。

#### Epoch authority and admission

- `ReplanEpoch` 是逻辑 authority，不新增 ReceiptType 或 public operation；Runtime 使用现有
  `SPV_PASS` 与 `STAGE_PLAN` Receipt 类型，在
  `.proofloop/receipts/plan/<stage>/epochs/<epoch_digest>/` 下 append-only 写入 epoch-qualified
  refs。初始 Stage 继续兼容现有 canonical plan receipt 路径。
- Replan admission request 只允许声明 current `stage_id`、`parent_epoch_digest`、候选
  Manifest/Plan/snapshot 绑定和 Runtime preparation disposition ref/digest；Runtime 重新计算
  impact 集合并拒绝 caller 伪造的派生集合或 epoch digest。
- 新 SPV/Stage Plan Receipt 必须绑定：Stage、parent/current epoch、Manifest digest、Plan
  digest、snapshot digest、disposition digest 和 Receipt chain。旧 Stage Plan/SPV/Worker/CV/
  Commit/Integration/Gate/Review Receipt 不覆盖、不删除、不静默升级，只作为历史事实或经
  disposition 明确继承的来源。
- `plan status`、`stage next`、Gate、Review 和 Stage Close 读取经过 parent-chain 校验的最新
  epoch；不得使用 mutable `current.json` 指针补全当前权威。

#### Evidence rotation and mutable projection

- `plan refresh-evidence(mode=replan)` 在任何写入前完成全量预检：current epoch、candidate
  Manifest、Task disposition、旧 Evidence root/identity/digest、Receipt chain、Git boundary
  与 transaction journal。
- carry-forward Task 的 Evidence 内容保持不变，只由 Runtime 写入新的 epoch binding/rotation
  fact；当前/invalidated Task 的旧 Evidence 原子归档到
  `delivery/stages/<stage>/evidence/history/<epoch>/<slice>.md`，再生成当前 canonical
  `delivery/stages/<stage>/evidence/<slice>.md` skeleton。旧文件和旧内容不得被覆盖或删除。
- 任一 non-pristine 归档、identity mismatch、symlink、缺失、journal 未恢复或 compare-and-swap
  失败都返回 `REPLAN.EVIDENCE_ROTATION_BLOCKED`，零写入或按 journal rollback；Brain/Worker
  不可手工修复 binding header。
- `tasks.md` 的 immutable Plan projection 仍由 Materializer 生成；carry-forward 的 checkbox/
  status/CV projection 由 Runtime 在 bounded mutable projection scope 内显式恢复，不能改变
  plan digest 或 immutable Task 内容。

#### Gate / Review / Close

- Replan 是 global barrier：旧 epoch 停止新动作；新 epoch admission 后，Runtime 只为
  carry-forward Task 提供当前 Context，为 invalidated Task 重新 dispatch。
- 每个新 epoch 必须重新完成当前 Worker/CV/Commit/Integration（按 disposition）、Stage Gate
  与 Stage Review；旧 Gate/Review 不复用。
- Stage Gate PASS 必须绑定当前 epoch、current Manifest/Plan、所有当前有效 Slice proof 和
  integrated snapshot；Stage Review ACCEPTED 必须再绑定当前 Gate Receipt；Stage Close 只消费
  当前 epoch 的 Gate/Review，不得用旧 Receipt 补齐。

<!-- proofloop:entity id="PLUGINV2-REPLAN-EPOCH-CONTRACT-ORACLE" kind="oracle" -->

Contract oracle：public operation set 不增加；Materializer 不越权；Task-local 只继承边界未变的
此前 `TASK_COMPLETE`；Slice-wide/不确定影响不继承受影响成果；Evidence 轮换与 epoch admission
均 Runtime-owned、append-only、root-bound、可重启恢复；新 Gate/Review 只绑定当前 epoch。

<!-- proofloop:entity id="PLUGINV2-SLICE-LOCAL-CV-CONTRACT-ORACLE" kind="oracle" -->

CV route oracle：外层 command envelope 与 nested credential discriminator 分离；slice-local v3
必须经 public `stage admit-cv`、built parity、Stage/path binding、Worker tip/Context/Proof Index
和三层 digest 校验；v2 在 slice-local Stage 与 v3 混用时必须 `BINDING.MODE_MIXED` 且 zero-write。

<!-- proofloop:entity id="PLUGINV2-REPLAN-EPOCH-CONTRACT-RISK" kind="risk" -->

Contract risk：current epoch 选择、父链校验、Evidence rotation 与 mutable projection 恢复若
任一处失配，会造成历史 Receipt 被误当当前授权或造成无谓全 Slice 重做；必须有 source/dist/
public CLI parity、零写入失败、restart recovery、legacy 回归和 Gate/Review binding 测试。

## Contract Gate（整改增补）

- [ ] 三级指纹 projection 为 closed 字段清单且全部经 kernel 唯一计算入口（bindings.ts）
- [ ] 凭证三档版本判别有消费端测试（重点：v2 消费端遇 schema_version 3 fail-closed）
- [ ] 失效规则矩阵（8.6）与 FR-020 验收 Case 1-9 一一对应并有测试
- [ ] legacy 模式（无 binding 字段）路径零行为变化（回归测试）
- [ ] 一个 Stage 混用两种模式凭证被拒绝（BINDING.MODE_MIXED）
- [ ] candidate input 的 `binding_mode` 经 Materializer → adapter → public compile 完整传播；缺省 legacy、slice-local 三层绑定、未知值 fail-closed
- [ ] §8.8 Replan epoch、Task-local/Slice-wide disposition、Evidence rotation、Gate/Review 当前 epoch binding 有 source/dist/public CLI 与 restart/零写入证据
- [ ] nested CV_RESULT v3 可通过 source/built/public `stage admit-cv` route，v2 legacy route 零行为变化，且跨模式/Stage-path/Worker-tip 混链均有零写入测试

### PLUGINV2-S12-BINDING-SEAM（seam）
<!-- proofloop:entity id="PLUGINV2-S12-BINDING-SEAM" kind="seam" -->
整改契约 seam：Manifest `binding{version:1,mode:"slice-local",stage_contract_digest}` + 每 slice `slice_contract_digest` 由 compiler 输出并经 kernel 唯一 oracle 校验（§8.1/§8.2）；Receipt payload schema_version 三档判别与 fail-closed（§8.3）；slice currentness 与失效规则（§8.5/§8.6）；validate 对已受理且 current 的 Slice 豁免（FR-023）。

### PLUGINV2-S13-BINDING-MODE-SEAM（seam）
<!-- proofloop:entity id="PLUGINV2-S13-BINDING-MODE-SEAM" kind="seam" -->
S13 模式传播 seam：candidate input `binding_mode` → active Materializer closed schema → Runtime candidate adapter → public `plan compile` → Manifest binding mode；缺省 legacy、`slice-local` 输出三层绑定、未知值与静默丢弃均 fail-closed。

### PLUGINV2-S12-TEST-SEAM（seam）
<!-- proofloop:entity id="PLUGINV2-S12-TEST-SEAM" kind="seam" -->
S12-A 测试基线 seam：fresh clone（无本地 `.proofloop` 遗留）后全量 vitest 全绿；测试以临时 HOME/配置目录隔离运行，不写项目真实配置（`.pi/subagents.json`、`opencode.json` 等）；`.proofloop/**` 保持 gitignore；fixture 全部自包含（tracked 生成器或静态 fixture）。

### PLUGINV2-S12-PROCESS-SEAM（seam）
<!-- proofloop:entity id="PLUGINV2-S12-PROCESS-SEAM" kind="seam" -->
S12-F 流程纪律 seam：materialize 禁令与 replan 投影保留规则固化于 proofloop-plan SKILL/brain-workflow 且经一致性测试；Evidence 标题规则固化于 Worker 派发模板且 admission 错误明确提示；13 条问题→防复发机制→固化位置对照表入权威并可由 Stage Review 审计。
