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
| `plan` | `materialize`, `compile`, `validate`, `initialize-evidence`, `refresh-evidence`, `status`, `admit-spv`, `admit-stage-plan` | 保存 closed AI plan input/candidate；编译 Manifest；机械验证；初始化或安全刷新 pristine Evidence skeleton；受理 SPV 与 Stage Plan authority | candidate/Manifest/Evidence/SPV/Stage Plan refs |
| `context` | `prepare`, `show`, `admit-refutation-observation` | 按 target action/role 生成或读取 content-addressed Context；CV 反驳观察固定后才解锁 Evidence read | Planning/SPV/Worker/CV/Committer/Reviewer 的不同 Context ref/content |
| `stage` | `status`, `next`, `admit-worker`, `admit-cv`, `admit-slice-commit`, `admit-integration`, `run-gate` | Stage state/next；受理 AI/Committer 结构化结果；执行并受理 Gate | NextAction/Context/Receipt/Gate refs |
| `review` | `status`, `prepare-stage`, `finalize-stage` | 组装 Stage Review Context；受理 ACCEPTED/REPAIR | Review Context / Stage Review Receipt |
| `project` | `status`, `compile-acceptance`, `run-e2e`, `prepare-review`, `finalize-review` | 项目验收 Manifest、E2E Gate、Project Review Context/Receipt | Project refs/verdict |
| `doctor` | `run` | Runtime/CLI 版本、Git、project root、schema、commands/services、filesystem capability；Host API 项仅在 adapter 自身诊断 | structured diagnostics |

Unknown domain/operation 必须在任何 filesystem write 前返回 `RUNTIME.SCHEMA_MISMATCH`。

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
| `.proofloop/runtime/**` | runtime CLI / gate facts | reconcile / gate / doctor | JSON | stage-scoped derived facts | 可重建派生物；不改变 Receipt 权威 | **受保护路径** |
| `.proofloop/logs/**` | Runtime CLI / adapter logger | 诊断 | 文本 | — | 追加 | — |
| `.proofloop/context/<digest>.json` | Runtime Context Resolver（经 CLI/adapter） | 当前 role Agent / admission | JSON（derived Context） | role/action、input refs/digests、snapshot、scope、self digest | write-once、可重建、非 Receipt authority | root/digest/identity + source bindings |
| `delivery/stages/<stage>/candidate-input.json` | Brain closed input → `plan materialize` | Runtime materializer/compiler | closed JSON | schema/caller/owner/refs/goals/slices/tasks/scope | candidate transient source；不是第二权威 | CLI schema/entity/path checks |
| `delivery/stages/<stage>/tasks.md` | Active Plan Materializer → Committer boundary | Runtime compiler / SPV / Context Resolver | Markdown + checkbox | Stage 头 + SLICE 区块 + `- [ ] T-id:` 行 | candidate → final Git boundary before SPV；checkbox/status 仍是人类投影（非权威） | entity/ref/plan digest + clean Git gate |
| `delivery/stages/<stage>/evidence/<slice>.md` | Runtime Evidence initializer/refresh before SPV → Worker → CV | SPV / Runtime / CV | Markdown | Plan/Manifest/Proof Index binding + Task Evidence + Current Slice Evidence + Current CV Status | skeleton 必须在 final Git boundary 前存在；manifest 变化只允许 Runtime 对 pre-admission pristine skeleton 原子 refresh；已有执行内容后不可覆盖 | manifest evidence_path + pristine-template parser + receipt/status absence + clean Git gate + CV contract |

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
| EvidenceRefreshRequest | stage_id, manifest_ref/digest, expected_previous_manifest_digest, evidence refs | S09 seam | 写：Runtime `plan refresh-evidence`；读：Planning/SPV | 仅 pre-admission + 所有 skeleton pristine + 无 Stage execution Receipt；全量预检 + transaction journal + 每文件 compare-and-swap | 任何 non-pristine/stale/symlink 或未恢复 transaction 直接阻断 |

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
- Refresh operation：`proofloop plan refresh-evidence` 是 Runtime-owned pre-admission operation。
  它只接受当前 Manifest ref/digest、expected previous Manifest digest 和 Manifest 声明的全部
  Evidence paths；在任何写入前验证 Stage 尚无 Stage Plan/execution Receipt、每个文件仍严格匹配
  initializer 的 pristine template（无 Task/Current Evidence、CV=NOT_RUN、无 Receipt/Finding）、
  path root-bound/no-follow 且 old binding 一致。
- Transaction：全部 Evidence 先完成 parse/identity/binding 预检，再建立 Runtime transaction
  journal，并以 bounded temp + expected-file-binding compare-and-swap 逐文件更新。成功必须覆盖 Manifest
  声明的全部 Evidence；中断/写失败必须按 journal rollback 或在重启后返回 blocked recovery，绝不能
  把部分更新报告为成功。任一 non-pristine、缺失、额外文件、stale digest、symlink 或竞态在写前
  no-write；该 operation 不写 Receipt，不改变 checkbox/Task/CV 状态，不允许 post-admission 使用。
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
