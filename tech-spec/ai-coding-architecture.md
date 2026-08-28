# AI Coding Architecture — ProofLoop v2 通用 CLI（OpenCode Plugin 已退役）

## 1. Metadata

- Project: proofloop-v2（本仓库；ProofLoop v2 通用 CLI；OpenCode Plugin 已退役 2026-08-14）
- PRD source: `PRD.md`（CONFIRMED；已吸收 harness-neutral CLI-first 与 Slice 级证明绑定整改需求 FR-020..024）
- Technical reference: 当前权威为 `CONTEXT.md`、`tech-spec/contract-state-matrix.md`、`tech-spec/task-acceptance-matrix.md`、`tech-spec/hard-parts-register.md` 与 `tech-spec/process-discipline-matrix.md`；未随模板发布的历史输入不作为引用
- Architecture version: 0.3.0
- Date: 2026-08-15（Slice 级证明绑定整改架构）
- Owner: Brain（技能 prd-to-ai-architecture；输入 PRD/CONTEXT 与当前代码）
- Target implementation scope: `packages/kernel` + `packages/runtime`（vNext 分层绑定）；Plugin adapter 无当前交付义务
- Status labels: `confirmed` / `assumed` / `open`；Historical 条目不授予当前执行权

## 2. Product Scope

### Must Implement
- [confirmed] harness-neutral `proofloop` CLI 命令表面：不同 harness 的 Agent 调用相同命令，不依赖 host tool API
- [confirmed/current seam] CLI/Runtime capability surface covers Authority/Plan 机械检查、角色 Context、AI 结果受理、Commit/Integration、集成事实 Gate、Review、Project Acceptance、恢复和 doctor；Gate 不执行 Manifest `runtime_proof` 或绑定 `runtime_proof_digest`，完整 built-process Gate/E2E 证据仍为 open。
- [open] S10 CLI-first self-host completion：public CLI 是当前机械入口，但完整 Execution→Review、Gate/E2E 的 built-process 证据尚未建立，不能由旧 Receipt 或文档声明完成。
- [open / Historical] S09 一次性 executable Runtime Proof bootstrap：当前 active candidate/materializer 不接受 `runtime_proof`，compiler 不生成该字段，Gate 不执行或绑定它；仅保留为历史规划/未来重新立项入口。
- [confirmed] 项目检测（ProofLoop 标识）+ `.proofloop/runtime.lock` 校验 + fail closed（FR-001/FR-013）
- [confirmed] 按角色隔离：Agent 权限由宿主配置声明，Runtime/CLI 对调用上下文执行二次校验（FR-007）
- [confirmed] Token 预算与 compact 输出（FR-012）
- [confirmed/current seam] Runtime source/dist 与 public CLI 的 parity contract（FR-014）；旧 Plugin parity 仅作 Historical/compatibility audit。
- [open] FR-015 真实 Git workflow 与 FR-016 会话恢复的完整 built-process 验证：当前仅有局部 Runtime seam 与单 Slice boundary fixture；两个 Slice 的 Gate/Review 及 restart/Replan/Evidence refresh 证据尚未建立。

### Historical / 已归档（不属于当前交付）
- OpenCode Plugin workspace、tools、hooks、插件加载/分发与 Plugin parity 计划仅保留审计语义；2026-08-14 已退役，不恢复其实现入口。
- 旧 pluginv2 / S08 / OC-* 阶段标签仅用于历史导航；当前状态、路径和执行授权以 Runtime 与本文件引用的现行 Tech Spec 为准。

### Explicit Non-Goals
- [confirmed] npm 发布（发布清单记录，后续执行）
- [confirmed] Pi、Claude Code 或其他 harness 的专用 extension/tool adapter（通用 CLI 本身必须可直接调用）
- [confirmed] 新流程语义不在本架构重复定义；以 kernel/runtime 与对应 Contract 为权威。
- [confirmed] 旧 Receipt 自动迁移（仅显式 migration 命令）
- [confirmed] Windows/macOS 完整验证（代码跨平台注意，验收 Linux）
- [confirmed] 非 ProofLoop 项目任何 ProofLoop 行为（doctor 除外）

### Future / Out of Scope
- [open] npm 发布与更多 harness 的显式 adapter；不恢复 OpenCode Plugin 流程实现

### 整改范围（2026-08-15，FR-020..024）

#### Must Implement（整改）
- [confirmed] 三级绑定：`stage_contract_digest` / `slice_contract_digest` / `execution_binding_digest`（FR-020）
- [confirmed] 已集成且未受影响的 Slice 在 replan 后保持有效；旧模式行为零变化（FR-020 Case 1-7）
- [confirmed] replan 保留已受理 Slice 执行状态 / Evidence 规则固化 / validate 豁免 / 纪律防复发对照表（FR-021..024）
- [confirmed] 测试 fixture 自包含 + 测试环境隔离（工程卫生，Task 0）

#### Explicit Non-Goals（整改）
- [confirmed] 并行执行 / worktree 工作区 / Brain 与宿主并发改造（Future 范围，不属于本整改 Phase 1）
- [confirmed] 删除 tasks.md 状态、改集成 Git 工作流、会话 id 持久化、固定 repair 次数、CV PASS 后自动 rebase

## 3. PRD to Architecture Mapping

| PRD item | Technical implication | Architecture decision | Status |
|---|---|---|---|
| FR-001 项目检测 | 需要确定性项目标识 + 非 ProofLoop 无感 | 标识 = `.proofloop/runtime.lock`（主）+ manifests/delivery 存在性（辅）；检测失败 → public CLI 除 `doctor` 外 fail closed | confirmed |
| FR-002 plan 工具 | 封装规划与计划认可 | candidate plan 只引用 PRD/Tech Spec/AWI；Runtime 编译/验证；Stage Plan admission 是独立的 Runtime authority boundary，不由 candidate 或 SPV narrative 代替 | confirmed（验收以当前 source/dist/public CLI parity 为准） |
| FR-003 stage 工具 | 单动作阶段执行 | Runtime 派生唯一 next action、最小 Context Projection、4 类 admit 与 Gate；Brain 不替代 Runtime 状态判断 | confirmed（验收以当前 Runtime/CLI execution loop 与对应测试为准） |
| FR-004 review 工具 | 封装评审受理 | public `review prepare-stage|finalize-stage` 组装 Context 并受理 ACCEPTED/REPAIR；REPAIR Receipt 保留链历史并路由重新 Gate/Review | confirmed |
| FR-005 project 工具 | 项目验收 | public `project compile-acceptance|run-e2e|prepare-review|finalize-review|status` 组装并受理 Project Acceptance facts（`PROJECT_E2E_PASS/FAIL/BLOCKED`） | confirmed |
| FR-006 doctor | 诊断 | public `doctor run|status` 检查 Runtime/CLI 版本、Git、trust root、schema、命令与 filesystem capability；宿主 adapter 仅诊断自身，不成为流程前置 | confirmed |
| FR-007 角色隔离 | Agent 权限 + Runtime/CLI 二次校验 | Agent 配置声明角色能力；Runtime/CLI 校验调用上下文 | confirmed（AWI-011 为历史追踪；当前以 Agent/CLI role tests 为准） |
| FR-008..011 边界 | 受保护制品、脏状态、命令策略、Context 恢复 | 由 Runtime/CLI 与 Agent 权限规则承担；不依赖已退役的宿主生命周期 hook | confirmed（AWI-012 为历史追踪；当前以 Runtime/security regression 为准） |
| FR-012 token | 输出预算 | ToolResult 统一形状 + compact renderer（status ≤1000、next ≤1500、findings ≤20、receipt ref+digest） | confirmed |
| FR-013 版本锁 | runtime.lock | kernel `validateRuntimeLock` + fail closed | confirmed |
| FR-014 parity | 多入口一致性 | Runtime source/dist 与 public CLI 对同一 fixture 调用同一 Runtime 语义；已退役 adapter 仅作 Historical 审计，不是当前入口 | historical/current CLI parity |
| FR-015/016 | git workflow / 恢复 | 复用 Runtime reconcile（Receipt 权威）与现有 boundary/recovery seam | confirmed（Runtime seam/contract）/ open（真实两 Slice workflow、Gate/Review 与 recovery/restart/Evidence refresh 证据） |
| FR-017/018 | 单一权威 / 受控切换 | 当前 vNext CLI、Runtime 与 Contract 共享 schema discriminator、consumer 与 Receipt binding；旧切换/旧 route 仅显式 fail-closed 读取，不自动迁移 | confirmed（当前）/ historical（切换） |
| FR-019 | harness-neutral CLI / self-host | 一个稳定 CLI command family 覆盖完整机械流程；根据 action/role 生成不同 Context；所有受理与转换检查走 Runtime；S10 用该 CLI 自举 | confirmed（CLI contract）/ open（S10 self-host 与 Gate/E2E evidence） |

## 4. Architecture Views

### System Context
- User: OpenCode、Pi、Claude Code 等 harness 的使用者与 ProofLoop Agent 角色
- System: `@proofloop/runtime` 的 harness-neutral CLI（当前机械交付）
- External systems: Agent harness（只需 shell/command 能力）；Git 仓库；业务项目目录（`.proofloop/`）
- Local boundary: 全部本地；网络 deny-by-default

### Containers
| Container | Responsibility | Technology | Port/path | Persistent state | Notes |
|---|---|---|---|---|---|
| @proofloop/kernel | 领域规则/契约/Receipt 校验 | TypeScript 库 | — | 无 | 现有，零依赖 |
| @proofloop/runtime | 应用服务与通用 CLI：resolve/reconcile/admit/next/context/runner | TypeScript 库 + stable CLI command family | `proofloop <domain> <operation>`；repo 内 built entry | 无（读写项目 artifacts） | S10 主交付；不得 import harness SDK |
| 业务项目目录 | ProofLoop 项目工作区 | — | `.proofloop/`、`delivery/` | receipts/manifests/runtime/runtime.lock | CLI/Runtime 主操作目标 |


### Components（通用 CLI / Runtime）
| Component | Responsibility | Does not own | Inputs | Outputs | Dependencies |
|---|---|---|---|---|---|
| `packages/runtime/src/cli/proofloop.ts` | 稳定 command dispatcher；解析 domain/operation 并调用各 `proofloop-*.ts` command adapter | 不实现状态机、语义判断或 Receipt 写逻辑 | argv + structured request | canonical JSON + exit status | `packages/runtime/src/cli/proofloop-common.ts` + domain adapters |
| `packages/runtime/src/cli/proofloop-common.ts` | 统一 request-file/JSON input、root assertion、canonical stdout/stderr/exit contract | 不解释业务语义 | command args、JSON | parsed request / closed error | `packages/runtime/src/path-guard.ts`、schema validators |
| `packages/runtime/src/cli/proofloop-plan.ts` | Authority ref 检查、candidate materialize、compile/validate/evidence/SPV/Stage Plan admission 的机械入口 | 不理解用户意图、不生成 Plan 语义 | closed AI result + refs | candidate/Manifest/Evidence/Receipt refs | materializer、vNext compiler/admission |
| `packages/runtime/src/cli/proofloop-stage.ts` | status/next、Worker/CV/Commit/Integration admission、Gate/Stage Close | 不派发 Agent、不做 CV/Review 判断 | stage requests / Agent envelopes | NextAction/Context/Receipt/Gate/Review refs | vNext services |
| `packages/runtime/src/cli/proofloop-review.ts` + `packages/runtime/src/cli/proofloop-project.ts` | Stage Review 与 Project Acceptance 的 prepare/finalize/status/run 操作 | 不替 Reviewer 作结论 | persisted refs + AI verdict | role Context / Receipt refs | review/project services |
| Runtime Context Resolver | 按 action/role 从同一持久事实生成不同最小 Context | 不生成通用 Prompt，不复制全部 Authority | refs/digests/state/snapshot | content-addressed ContextRef | vNext resolver |
| Transition Preflight | 在每个机械边界校验所需制品、依赖、Git、digest 和 Receipt chain | 不判断产品语义是否正确 | target boundary + persisted facts | ready/blocked + Findings + next | validators/reconcile |

## 5. Technical Context

- Language/runtime: TypeScript（Node ≥ 20；当前 Node 25 实测通过）
- Frameworks: 无运行时框架；测试使用 Node 25 内置 `node:test`（仓库无 vitest 依赖）
- Package manager: npm workspaces（根 package.json 已配 `packages/*`）
- Target platform: Linux（验收）；代码注意跨平台（POSIX/Windows 进程树 kill 已有 platform-adapter）
- Storage: 项目目录 `.proofloop/`（receipts/manifests/runtime/runtime.lock/logs）——机器权威
- Test runner: Node 25 内置 `node:test`；Git 行为测试只在临时 fixture 中运行
- Build: `npx tsc -b --force packages/kernel packages/runtime`
- External dependencies: 无运行时外部依赖（kernel/runtime 零宿主依赖；CLI 不加载 Plugin adapter）
- Security constraints: 网络 deny-by-default；受保护路径禁止直写；命令结构化（禁 shell 拼接）

## 6. Runtime Flows

### Flow: 通用 CLI 调用
- Trigger: 任意 harness 中获授权的 Agent 调用 `proofloop <domain> <operation>`，并提供
  root-bound structured request 或 request ref。
- Steps: CLI 统一解析输入/信任根 → 选择 closed command adapter → Runtime 校验当前持久事实
  与 transition preconditions → 执行只读投影或唯一 admission/write owner → 输出 canonical
  JSON、ref+digest、Findings 和 exit status。
- Boundary: CLI 不读取 harness session、不 import OpenCode/Pi/Claude SDK、不理解用户语义、
  不直接拼写 Receipt；所有流程事实通过 Runtime public services 和 bounded writer。
- Success: 相同项目事实与 request 在任意 harness 得到相同结果；Agent 只需读取输出引用并
  派发语义 owner。
- Failure: unknown operation、schema/version mismatch、root escape、stale binding、缺失制品、
  broken chain 或非法转换均 fail closed/no-write。

### Flow: 插件加载（Historical / 已归档）
- Status: 2026-08-14 退役；当前流程不再自动加载 Plugin、注册宿主 tools/hooks 或依赖 `opencode.json`。现行入口见“Flow: 通用 CLI 调用”。

### Flow: stage next（核心）
- Trigger: Brain/Agent 调通用 CLI `proofloop stage next`；所有 harness 直接使用同一 CLI 命令
- Steps: CLI 校验 projectRoot/request → 调用 vNext NextAction/Context Resolver（Reconcile→Validate→Reduce→Action→role-specific Context）→ canonical JSON/compact projection
- Success: 唯一 Next Action + refs
- Failure: 阻断 finding / chain 断裂 → fail closed + Finding
- Acceptance status: Runtime/public CLI stage-next seam exists；当前测试基线未覆盖完整 source/dist/public parity 与 stage-next action matrix（open）。

### Flow: admit（写入）
- Trigger: Agent 把 Worker/CV/Commit/Integration 等 closed result envelope 交给对应通用 CLI command
- Steps: 校验 AdmissionRequest（kernel 契约）→ 统一 admit 管线（validate→reconcile→precheck→按版本选择 Receipt writer→chain verify）→ 返回 ref+digest
- Success: 不可变 Receipt 落盘
- Failure: 请求非法 → 结构化拒绝，不写 Receipt
- Acceptance status: Runtime/public CLI admission seam exists；当前测试基线仅覆盖边界与单 Slice 局部路径，完整 admission parity/Receipt readback matrix 仍为 open。

Active vNext write boundary：v2 Manifest/Worker Receipt 必须使用 kernel
`ensureBoundedReceiptDirectory` + `writeReceiptBounded`；该 seam 通过 root-fd
anchored operations、`O_DIRECTORY|O_NOFOLLOW`、no-replace final install、writer-time
identity 和 bounded readback/rollback 防止正常路径中的 symlink/path escape。legacy
`writeReceipt` 只保留为显式 v1 compatibility API，不得被 v2 consumer 选择。纯 Node
缺少 `openat2/openat` 的 syscall-atomic containment；恶意进程在最后 identity check
后整体移动 trust-root/parent inode 的极端 race 是已接受 residual，不得描述为正常流程
会产生目录外文档；若未来要求绝对 adversarial containment，需 native helper 或平台级
fail closed。

### Flow: gate
- Trigger: Brain/Agent 调用通用 CLI Stage Gate command；不依赖宿主 adapter。
- Current behavior: `proofloop gate run` / `runGateVNext` 经 Gate preflight 与 admission 校验 Slice 集成 Receipt 或显式 `git_facts`，写入 Runtime-owned Gate Receipt；不执行 Manifest `runtime_proof`，不绑定 `runtime_proof_digest`；构建与测试由 Stage Reviewer 负责。
- `gate status` 只读 Gate 状态/Receipt 报告；失败或缺少当前集成事实时 fail closed。
- Acceptance status: public CLI/source/dist parity 与完整 Gate/E2E process evidence 仍为 open，不能以历史 all-skipped proof 声称完成。

### Flow: project acceptance
- Trigger: Brain 调通用 CLI Project Acceptance commands
- Steps: public `project compile-acceptance` → `project run-e2e`（`PROJECT_E2E_PASS/FAIL/BLOCKED` Receipt）→ `project prepare-review`/`project finalize-review`（Project Review Receipt）
- Acceptance status: public project CLI/Runtime 路径存在；当前测试目录未包含 project process/Runtime acceptance test，相关证据仍为 open。

### Flow: Historical S08 formal execution boundary（规则已迁移至当前 vNext）
- Status: S08 是旧阶段标签；以下边界原则仅作为迁移/审计参考，当前执行以 Runtime/Contract 的 admitted Stage 为准。
- Steps: Planning Skill 生成 candidate Plan（每个 implement Task 必须声明 immutable execution scope）→ Runtime
  compile/validate → Runtime 按已验证 Manifest 初始化 Evidence skeleton → 完成 candidate Plan/
  candidate input/Evidence 的最终 Git boundary → fresh SPV（绑定 clean worktree 的当前 Git
  HEAD）→ Runtime Stage Plan admission（再次
  校验 clean worktree 与 HEAD）→ `proofloop stage next` → Runtime 返回最小 Context →
  Worker/CV/Slice Commit/Integration/Gate/Review 按对应 admission 边界推进。
- Boundary: candidate、checkbox、progress、Agent narrative 和 SPV 结果本身不能授权执行；
  candidate Plan、candidate input 和 Evidence skeleton 必须先完成最终 Git boundary；只有
  admitted Manifest/Receipt 与当前 snapshot 一致、且 SPV/admission 之间没有相关 dirty
  或 commit 变化时才允许进入 Stage action。
- Formal Stage interpretation: S08 是正式 execution Stage。`tasks.md` 和
  `candidate-input.json` 中的 `candidate_only` 只描述 admission 之前的候选投影和
  Materializer 的写入边界；Stage Plan admission 成功后，S08 的 Worker、CV、Integration、
  Gate 和 Review 属于 Stage Goal 的正式执行范围。它们不能被 candidate
  projection 的 planning-only 文字再次排除，也不能被 Brain 直接补造权限。
- Stability: SPV `PLAN_READY` 后，如果 Authority、Plan、Manifest binding 和 snapshot 未变化，
  `next/context` 继续使用既有 admission，不重复 SPV；任一真实边界变化都必须 fail closed
  并重新 fresh SPV。
- Execution boundary: planning clean Git gate 只在 SPV/admission 前执行一次；Stage Plan
  admission 后，Worker/CV repair 产生的 dirty diff 只要完全落在当前 admitted execution
  scope 内就是预期执行状态。`next` 必须从 persisted Task/CV/Receipt facts 继续状态投影，
  不能再次把 planning clean gate 当作 Worker→CV 的阻断条件。
- Execution state: admitted S08 必须提供完整的
  `DISPATCH_WORKER → TASK_COMPLETE → RUN_CV → CV_PASS/CV_REPAIR → SLICE_COMMIT →
  INTEGRATION → STAGE_GATE → STAGE_REVIEW` vNext consumer 和 digest bindings；任何缺失
  的下游 consumer 都是执行前阻塞，不得用 legacy reconcile 或 checkbox 推进。
- Recovery: Authority、Plan、Context 或 snapshot 变化只使受影响下游失效；不自动迁移旧
  Manifest/Receipt/Stage，不从任意 Markdown 推断 Runtime 命令。
- Execution scope: implement Task 的 immutable `execution_scope` 是 Plan 的一部分并参与
  `plan_digest`；它必须提供 root-relative `code_paths`、`test_paths` 和显式
  `forbidden_paths`。Runtime 只将通过 Manifest/Context digest binding 验证的 scope 投影给
  Worker，并把 Evidence path 作为额外的受限写入路径。scope 缺失、为空、越界或只包含
  Evidence 时，SPV/Runtime 必须在 Worker dispatch 前 fail closed。

### Flow: S10 harness-neutral CLI-first self-host
- Status: public `proofloop <domain> <operation>` 是当前机械入口；S10 完整 self-host、Execution→Review、Gate/E2E 的 built-process 验证仍为 open，不以文档或历史 Receipt 声称完成。
- Current boundary: active candidate input/materializer 的 closed contract 不接受 `runtime_proof` 或 caller `proof_digest`；`plan compile` 当前输出不含 `runtime_proof`。Kernel 的可选 Runtime Proof 类型/validator 仅保留兼容语义，不构成当前 producer 或 executor。
- Gate boundary: `proofloop gate run` / `runGateVNext` 只验证 Integration Receipt 链或显式 `git_facts`，写入 Runtime-owned Gate Receipt；不执行 Manifest `runtime_proof`，不绑定 `runtime_proof_digest`。构建/测试由 Stage Reviewer 独立判断。
- Historical/open plan: 曾规划 S09 一次性 executable Runtime Proof bootstrap、Evidence refresh，再以 S10 self-host；该顺序保留为历史导航/未来重新立项输入，不是当前 Stage admission 前置。
- Role/persistence boundary: AI 负责语义工作；CLI 根据当前 action 从 Authority/Plan/Manifest/Receipt/Evidence/Git 解析角色 Context，并交给 Runtime owner 持久化；不提供任意文件写接口。
- Failure: unknown/cross-version、stale binding、root escape、不完整 envelope、缺失角色 Context、非法 transition 或 broken chain 均 canonical Finding + no-write；不得以非公共入口、OpenCode tools 或 all-skipped proof 掩盖缺口。
- Out of scope: 专用 Pi/Claude/OpenCode adapter、恢复已退役 Plugin tools/hooks，以及未重新确认的 executable Runtime Proof/Gate 执行 seam。

## 6.2 Historical S08/S09/S10 oracle entities
- 以下稳定 entity id 保留用于历史 Receipt/计划引用；它们不是当前 Stage admission 或交付状态。当前语义来源只引用 PRD、CONTEXT、现行 Contract/Tech Spec 与 Runtime。

### S08-A oracle
<!-- proofloop:entity id="PLUGINV2-S08-A-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-002..004、FR-017；当前 `tech-spec/contract-state-matrix.md` 与 Runtime validators。
- Oracle：显式 v1/vNext schema/version 才能决定 consumer boundary；v2 输入不得静默回退到
  v1，未知或不匹配输入必须返回 bounded Finding。
- 观察要求：真实 plan/stage/review 入口对 v1/v2 paired fixture 得到明确分流结果，拒绝路径
  不产生执行事实。

### S08-B oracle
<!-- proofloop:entity id="PLUGINV2-S08-B-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-002、FR-017、FR-018；当前 `tech-spec/contract-state-matrix.md` 的 admission 规则。
- Oracle：candidate Manifest 和 fresh SPV 都不是执行授权；只有 Runtime Stage Plan admission
  在最终 Plan/Evidence Git boundary 之后，同时绑定 Stage、Manifest、Plan、SPV 和当前
  snapshot 后，Manifest 才能成为执行前权威。
- 观察要求：缺失、陈旧、篡改、重复或 digest 不一致的 admission 输入都 fail closed，旧
  Manifest/Receipt 不能通过修改恢复；dirty worktree 或 admission request 的 snapshot
  不等于当前 HEAD 时不得写入新的 Stage Plan authority。

### S08-C oracle
<!-- proofloop:entity id="PLUGINV2-S08-C-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-003、FR-011、FR-016、FR-017；当前 `tech-spec/task-acceptance-matrix.md` 与 Runtime Context/next contract。
- Oracle：public `proofloop stage next` 只能由 Runtime 从持久事实派生一个 Primary Next Action，并
  返回最小、root-bound、digest-bound Context；Context 必须携带来自 admitted Plan 的非空
  execution scope，Brain、Worker 和 checkbox 不得手工补造 Context。
- 观察要求：合法 admitted state 返回结构化 action/ContextRef，且 implement Task 的
  Context 同时覆盖 code/test scope 与 Evidence path；缺少 scope、scope 只覆盖 Evidence、
  scope 越界、未 admission、stale digest 或 identity mismatch 时只返回 bounded `VALIDATE`，
  不得先返回 `DISPATCH_WORKER` 再由 Worker 发现 `PLAN_GAP`。

### S08-D oracle
<!-- proofloop:entity id="PLUGINV2-S08-D-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-014、FR-015、FR-016、FR-018；当前 Runtime boundary contract 与 public CLI parity 约束。
- Oracle：Runtime source/dist 与 public CLI 对同一 fixture 的 action、Finding、Receipt/digest 和 fail-closed 行为一致；已退役 Host tool/adapter 不得成为当前授权入口。
  path escape、symlink、TOCTOU、stale snapshot 和 unadmitted next 不得产生执行 authority。
- 观察要求：使用真实入口、filesystem/Git 和重启边界验证，不以内部函数或 narrative 替代。

### S08-E oracle
<!-- proofloop:entity id="PLUGINV2-S08-E-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-003、FR-004、FR-011、FR-014、FR-015、FR-016、FR-017、FR-018；
  当前 `tech-spec/task-acceptance-matrix.md`、`tech-spec/hard-parts-register.md` 与 Runtime transition contract。
- Oracle：在 admitted S08 上，Runtime 从当前 persisted facts 投影唯一的 Worker/CV/
  Commit/Integration/Gate/Review action；执行期 scope 内 dirty diff 不使 Stage 回到
  planning；每个 vNext Receipt/Context 绑定当前 Manifest/Plan/前序 digest 和适用 snapshot。
- 观察要求：真实 Runtime source/dist/public CLI、filesystem/Git 和重启边界 fixture 必须覆盖 Worker 完成后 RUN_CV、CV PASS/REPAIR、Slice Commit、Integration、Gate、Review、recovery 和 v1/vNext mixed-consumer fail-closed；不接受只验证内部函数或 checkbox。

### S10 harness-neutral CLI oracle（Historical/open；稳定 entity id 保留历史 `S08B` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B-CLI-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-002..006、FR-010、FR-014、FR-016..019；Context Resolver/Proof
  Index/Runtime admission contracts；用户 2026-08-09 的 harness-neutral、CLI-first 和
  “不同 harness 只改 Agent、不改工具”决策。
- Oracle：普通命令行进程必须能完成 ProofLoop v2 全部机械操作，并根据 action/role 产生
  不同 Context；OpenCode、Pi、Claude Code 只需调用相同命令和 schema。CLI 与 Runtime
  source/dist 产生相同 action、Finding、Context/Receipt canonical JSON、digest、Gate verdict
  和 no-write 结果；不得依赖 Host tool 或 SDK 才能通过。
- 观察要求（Historical/open）：若重新立项，才需用真实 built CLI 从干净 fixture 覆盖 Authority/Plan→Worker/CV/Commit/Integration→Gate/Review→Project Acceptance 与重启；当前不宣称该完整 Gate/E2E 已完成。
- Runtime Proof 要求（Historical/open）：当前 active `plan compile` 不生成 `runtime_proof`，Gate 不执行该字段或绑定 `runtime_proof_digest`；若未来重新引入 executable proof，必须另行确认 schema、producer、executor 和 process evidence，不能以 all-skipped `not_applicable` 代替。

### S09 executable Runtime Proof bootstrap oracle（Historical/open；稳定 entity id 保留历史 `S08B0` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B0-BOOTSTRAP-ORACLE" kind="oracle" -->
- 独立来源（Historical）：原 S08B/S09 bootstrap 规划、S08-REVIEW-010 与 kernel Runtime Proof 兼容类型；这些引用保留用于导航，不授予当前 Stage 执行权。
- Current fact：active candidate input/materializer 的 closed schema 不接受 `runtime_proof`，当前 `plan compile` 不生成该字段；Kernel 仍保留可选类型/validator。Gate 只校验集成事实，不执行 Runtime Proof，也不绑定 `runtime_proof_digest`。
- Status：Historical/open。若未来重新立项，才需另行定义 Runtime-owned proof digest、producer/consumer schema、Evidence 边界与 source/built process evidence；旧 all-skipped `not_applicable` 不构成完成证明。

## 7. Decision Log

| ID | Context | Decision | Consequences | Status |
|---|---|---|---|---|
| ADR-001..003 | Historical Plugin integration / distribution | Plugin formerly reused Runtime services and host loading rules; it was retired on 2026-08-14. Current delivery uses the public CLI and does not depend on Plugin process, host API, or `opencode.json` loading. | historical / closed |
| ADR-004 | 信任根 | projectRoot = canonical worktree root；禁止裸 process.cwd() 作为 artifact 信任根 | 多项目/会话安全 | confirmed |
| ADR-005 | 角色识别 | Agent 配置声明角色与命令权限；Runtime/CLI 二次校验调用上下文，不依赖宿主 API 的角色字段 | 影响 FR-007 实现细节 | confirmed（AWI-011 为历史追踪；当前以 Agent/CLI role tests 为准） |
| ADR-006 | Historical host tool 数量 | 旧计划曾限制为 5 个粗粒度工具；当前不注册 Plugin tools，CLI command family 是唯一公共机械表面 | historical / closed |
| ADR-007 | 缓存 | stage_cache 仅进程内；跨会话一律从 Receipt 重算 | 一致性由 Receipt 权威保证 | confirmed |
| ADR-008 | 版本基线与历史输入差异 | 历史版本号只用于审计；实际以当前 `packages/kernel`/`packages/runtime` 实现和对应 Contract 为权威 | 文档记录差异，不按外部版本号实施 | confirmed |
| ADR-009 | Historical OpenCode 版本约束 | 旧 Plugin 验收曾固定宿主版本；Plugin 已退役，当前 CLI-only 流程不以宿主版本或 Plugin API 为前置 | historical / closed |
| ADR-010 | 权威分层 | PRD 是产品权威；Contract/Tech Spec 分别拥有语义、架构、Hard Part/AWI；candidate、Manifest、Receipt、Evidence、Git 各自只承担其事实域 | 避免计划、progress 或 Agent narrative 成为第二事实源 | confirmed |
| ADR-011 | 执行前边界 | Planning Skill 只生成 candidate；Runtime 负责 compile/validate/admission/Context；Stage action 只能从 admitted facts 进入 | 旧制品不隐式迁移；stale digest 必须阻断 | confirmed |
| ADR-012 | Runtime 与 Agent 分工 | Runtime 派生确定性状态和唯一 next action；Worker/CV/Reviewer 负责语义判断；Brain 只做全局路由和一个动作 | 减少重复上下文；禁止 Agent 手工构造 Context/Receipt/Gate verdict | confirmed（以当前 Contract/Skill 为准） |
| ADR-013 | SPV 前 Git boundary | candidate Plan/input 先由 Runtime compile/validate，Runtime 再按 Manifest initialize Evidence；Plan/input/Evidence 随后进入 final Git boundary，fresh SPV/admission 绑定 clean worktree 的当前 HEAD；SPV 通过后无相关变化则不重复 SPV | 防止在脏树上取得 PLAN_READY、随后 commit 使旧 Receipt 失效；相关变化必须 fail closed 并 fresh SPV | confirmed（用户 2026-08-05 明确确认；2026-08-09 对齐 Runtime initializer 顺序） |
| ADR-014 | 两种 Git boundary（历史 S08 标签） | Stage Plan admission 后进入正式执行；admission 前使用 planning clean boundary，admission 后使用 admitted scope-bound dirty boundary；Runtime 提供 Worker→CV→Commit→Integration→Gate→Review 的 vNext 状态和 consumer | 合法 Worker diff 不再误判为 stale planning；下游结果仍绑定 Manifest/Plan/Context/Receipt/snapshot；旧标签仅作 Historical | confirmed |
| ADR-015 | S10 harness-neutral CLI-first | 通用 CLI 是 S10 主机械表面；OpenCode、Pi、Claude Code 的 Agent 调同一命令，只调整 Agent 定义；Plugin 已退役 | CLI contract confirmed；S10 self-host、完整 Gate/E2E process evidence 为 open；不得把 Host tool 当缺口替代 | confirmed（方向）/ open（验收） |
| ADR-016 | 稳定 CLI command family | 对 Agent 暴露一个稳定 `proofloop <domain> <operation>` command family；现有 `dist/cli/*.js` 作为迁移期内部 entry，最终由 dispatcher 复用同一 command adapters，不能成为各 harness 不同的公共合同 | 小公共表面隐藏 Runtime 复杂度；统一 root/request/output/exit；宿主只调整 Agent 配置 | confirmed（基于 FR-019 与现有多脚本入口缺少 package `bin` 的代码事实） |
| ADR-017 | Historical/open S09 executable proof bootstrap | 曾规划 S10 final boundary 前建立 executable Runtime Proof 与 pristine Evidence refresh；当前 active candidate/compile 不接受/生成 `runtime_proof`，Gate 不执行或绑定该字段，故该决策不构成当前实施或验收前置 | 若未来恢复，需新确认 producer/consumer、digest、Evidence 和 Gate 证据；当前保留兼容类型但不声称完成 | historical/open |
| ADR-018 | Canonical Runtime Stage ID | Runtime admission/status 的 Stage ID 只使用 `^S\d+$`；`S09`/`S10` 仅保留为历史规划与 CLI 命名导航。旧标签 `S08B0`/`S08B` 只作为 invalid candidate/历史导航，不得进入 Runtime request | ID grammar parity 仍由当前 Runtime/Contract 约束；这不表示 S09 executable bootstrap 或 S10 Gate/E2E 已完成 | confirmed（ID 规则）/ historical/open（bootstrap） |

## 8. Open Questions / Verification Residuals

| Question | Why it matters | Blocking? | Resolution / residual |
|---|---|---|---|
| Historical OpenCode/Plugin compatibility | 旧宿主 adapter 的权限、hook 生命周期与版本矩阵已随 Plugin 退役关闭 | No | 当前 CLI-only 流程不以宿主 API/版本为前置；历史记录不授予执行权 |

## 9. Pre-Code Readiness
> 本节为历史架构草案的 readiness snapshot；勾选项记录当时的设计输入，不等同于当前 Runtime admission、Stage 完成或 Git 事实。当前执行状态以 Runtime 与对应 Receipt/Gate/Review 为准。

- [x] Scope and non-goals are explicit（§2）
- [x] Critical architecture decisions labeled（§3/§7）
- [x] Components have clear owners and boundaries（§4 Components）
- [x] APIs/files/state represented in contract matrix → artifact 2（contract-state-matrix.md，已按 kernel 权威对齐）
- [x] Hard parts registered → artifact 3（hard-parts-register.md，HP-001 VALIDATED；HP-002/003 方案已定）
- [x] Product requirements have been re-confirmed in `PRD.md`（2026-08-09）
- [x] S08 Final Plan/Evidence Git boundary、fresh SPV 与 Stage Plan admission 已完成
- [x] S08 external acceptance/seam/oracle/risk entities 已 root-bound 且可解析
- [x] S08 formal execution loop 的历史 acceptance 记录保留 Worker/CV/Commit/Integration/Gate/Review 语义；不作为当前 Gate/E2E 已完成证据，当前 built-process 验证仍以 Runtime/CLI 事实为准。
- [x] S10（旧标签 S08B）的 AWI-023、harness-neutral CLI seam/oracle/acceptance refs 的历史 authority boundary 已记录（`51d80a2`）；不表示当前 executable Runtime Proof 或 self-host/Gate/E2E 已完成。
- [ ] S09 executable Runtime Proof/Evidence refresh bootstrap authority、Plan 和 restricted execution 完成
- [ ] 当前旧 S08B candidate/Manifest/Evidence 保持 parked/blocked；S09 后由 Materializer 以 S10 replan/rebind
- [ ] stable `proofloop <domain> <operation>` 覆盖完整机械流程和角色 Context
- [ ] S10 bootstrap 后通过通用 CLI self-host 完成 Execution→Review，并用 fresh candidate fixture 验证 Plan 全链；不依赖 OpenCode tools
- [ ] v1 CLI/legacy 概念只在新 CLI 全链 oracle 通过后移除，并完成 restart/harness-neutral process tests

## 10. 整改架构：Slice 级证明绑定（2026-08-15，Phase 1 串行）

> 本节承接 PRD FR-020..024 与当前 `tech-spec/` 合同/矩阵；只收录架构决策，实施细节见对应 Contract/Skill。

### 10.1 范围

- [confirmed] 目标：FR-020 连坐消除 + FR-021 replan 保留状态 + FR-022 Evidence 规则固化 + FR-023 validate 豁免 + FR-024 纪律防复发 + 测试自包含。
- [confirmed target / open implementation] 永久能力边界：post-admission Task-local/Slice-wide Replan、epoch currentness、Evidence rotation 与 slice-local CV v3 public admission 是长期 Runtime 目标，不是只为 S13 历史恢复案例提供的一次性迁移工具；当前 HP-021/HP-022 的实现及完整 source/dist/public/restart/Evidence-refresh 证据尚未闭合，不作为当前 Stage/Gate 完成事实。
- [confirmed] 非目标：并行执行 / worktree / Brain 与宿主并发改造（后续版本范围）；删除 tasks.md 状态；改集成 Git 工作流；会话 id 持久化；固定 repair 次数；CV PASS 后自动 rebase。

### 10.2 三级绑定模型

| 指纹 | 表达 | 投影来源（均来自现有 Manifest 结构，不新增计划字段） | 强绑定方 |
|---|---|---|---|
| `stage_contract_digest` | Stage 全局执行契约 | digest{ binding_schema_version:1, stage_id, stage 节点不可变投影（id/kind/goal/refs/dependencies/required_skills）, stage 直接引用 refs 的解析绑定（kind/ref/file_digest/section_digest） }；**不含任何 Slice 内容** | 所有 Slice 执行 |
| `slice_contract_digest` | 单个 Slice 静态执行/验证契约 | digest{ binding_schema_version:1, stage_id, slice_id, proof_index, required_skills, depends_on, evidence_path, task_scopes（仅本 Slice proof_index.task_refs 对应条目）, reference_bindings（本 Slice 引用闭包的解析绑定） } | Worker/CV/Slice Commit/Integration |
| `execution_binding_digest` | 执行时消费的依赖集成事实 + 基线 | digest{ stage_contract_digest, slice_contract_digest, dependency_bindings[ {slice_id, slice_contract_digest, integration_receipt_digest, integration_head_sha} ], base_snapshot_digest } | Worker/CV/Slice Commit/Integration |

- [confirmed] 依据（已对照代码核实）：Manifest slice 已含 `slice_id/proof_index/required_skills/depends_on/evidence_path`；`manifest.task_scopes` 已按 task_id 键控并交叉校验 slice proof_index.task_refs；`entity-resolver.normalizePlanExecutionProjection` 已规范化 checkbox/Worker Status/CV Status → 引用 digest 稳定，不被 mutable 投影污染。
- [assumed] `execution_binding_digest` 在 Phase 1 串行下 dependency_bindings 通常为空或单元素；`integration_head_sha` 的精确来源（现有 Integration Receipt 字段 vs 新增字段）实施时核实确定。
- [confirmed] 三个指纹全部由 kernel `bindings.ts` 唯一 canonical helper 计算；禁止在 compiler/admission/next 复制 hash 逻辑。
- [confirmed] `plan_digest` / `manifest_digest` 保留，仅用于计划审批、SPV、Gate/Review、审计；不再单独决定已集成 Slice proof 的当前性。

### 10.3 绑定模式判别

- [confirmed] Manifest 新增 closed 字段：`binding: { version: 1, mode: "slice-local", stage_contract_digest }`。
- [confirmed] 无 `binding` 字段 = legacy stage-wide 模式，行为与现状完全一致（fail-closed 不变）。
- [confirmed] 一个 Stage 禁止混用两种模式的执行凭证；旧凭证绝不静默解释成新绑定；升级活跃 legacy Stage 必须显式 replan + 重新 admission。
- [confirmed] 新 Stage 默认 slice-local；切换点 = compile 时按 candidate input 的显式 `binding_mode` 输出 binding 字段。缺省 `binding_mode` 保持 legacy，未知值 fail-closed；Materializer、candidate adapter 与 Compiler 必须保留该判别，不得静默丢弃。
- [confirmed] S12 是 legacy 过渡 Stage；S13 是首个真实以 `binding_mode: "slice-local"` 规划并执行的 Stage。该切换来自 S12-REVIEW-001 的用户决策 A，历史 S12 证据不回写或迁移。

### 10.4 凭证（Receipt）schema 演进

- [confirmed] payload.schema_version 三档：`1` = legacy / `2` = 当前 vNext / `3` = slice-local（binding 字段必填）。
- [confirmed] legacy 消费方对 schema_version ≠ 1 已整链阻塞（沿用既有 `legacyTaskSchemaFinding` 模式）；vNext(2) 消费方遇到 `3` 必须显式 fail-closed，不得静默忽略 binding 字段（防静默混链）。
- [confirmed] slice-local 模式新增 Receipt 字段（Worker/CV/Slice Commit/Integration payload）：`stage_contract_digest`、`slice_contract_digest`、`execution_binding_digest`。
- [confirmed] `stage admit-cv` 的 CLI 输出 envelope 仍使用 Runtime command 的 `schema_version: 2`；其嵌套 `CV_RESULT` role envelope 使用独立的 credential discriminator：legacy/vNext Stage 允许 `schema_version: 2`，slice-local Stage 必须使用 `schema_version: 3` 与三个 binding digests。Route detector、shared validator、consumer 与 built/source/public parity 必须共同支持该闭集；不得把外层 CLI envelope 版本误当成 credential 版本。
- [confirmed] admission 时仍严格验证派发时点 revision（dispatch revision 校验不变），不允许旧结果静默按新 Plan 受理。

### 10.5 失效规则（replan invalidation）

- [confirmed] `stage_contract_digest` 变化 → 所有 Slice 证明 invalid（正确连坐）。
- [confirmed] 否则：`invalidated = changed ∪ reverseDependencyClosure(changed)`（changed = slice_contract_digest 变化的 Slice）。
- [confirmed] 已集成 Slice 保持有效的机械判据 `isIntegratedSliceCurrent`：stage_contract current ∧ slice_contract current ∧ dependency binding current ∧ integration receipt chain valid；**不再因整本 plan_digest/manifest_digest 历史不同自动失效**。
- [confirmed] 执行中未集成的 Slice 不整体自动跨 Plan revision carry forward；但在 Task-local
  Replan 中，之前已接纳 `TASK_COMPLETE` 且 Task contract 未变的前置 Task 可保留。当前被
  replan 的 Task 与受影响的后续 Tasks 不 carry forward；若前置 Task contract 受影响则升级
  为 Slice-wide Replan。
- [confirmed] REPLAN 是 global barrier（Brain 执行：停新动作 → 重规划 → compile/validate → fresh SPV → 新 admission → 按失效规则重算）。

### 10.6 消费改造点

- [confirmed] `next.ts`：读取/重建状态处（已核实约 20 处整本 digest 绑定：Worker facts / CV facts / Slice facts / handoff 校验等）改为 Task/Slice 分级当前性消费；**legacy 路径完全不动**；Phase 1 继续维持单 active Slice。
- [confirmed] validate：对"已受理且当前有效"的 Slice 豁免证据绑定校验（FR-023）；pre-admission pristine 刷新继续走既有 `refresh-vnext-slice-evidence`（refresh/recover/rollback）；post-admission Replan 必须走同一 public `plan refresh-evidence` 的 Runtime-owned `mode: replan`，不手工改写。
- [confirmed] worker/cv/commit/integration admission：新模式消费 local binding 字段，并验证当前
  Replan epoch 对 Task 的 carry-forward/invalidated 判定；changed_files 边界行为本阶段不变（ADR-021）。
- [confirmed] CV route：`stage admit-cv` 只扩展现有 operation 的 nested `CV_RESULT` schema discriminator；slice-local v3 结果必须通过 `proofloop-stage.ts` → shared CV validator → vNext CV consumer 的同一 source/dist/public 路径，legacy/v2 与 slice-local/v3 不得混链。
- [confirmed] gate-admission：每个新 Replan epoch 都重新绑定完整 plan/manifest/epoch digest
  与当前集成 snapshot；旧 Gate/Review 不复用。新模式不依赖 tasks checkbox（本阶段仅预留字段）。

### 10.7 模块边界

| 模块 | 责任 | 不负责 |
|---|---|---|
| `packages/kernel/src/vnext/bindings.ts`（新增） | 三级指纹 canonicalization + digest + closed validators（唯一 oracle） | 状态派生、admission 决策 |
| `packages/runtime/src/vnext/binding-currentness.ts`（新增） | isIntegratedSliceCurrent、Task/Slice 历史 proof 对当前 Replan epoch 的有效性 | 语义依赖推断 |
| `packages/runtime/src/vnext/replan-impact.ts`（新增） | 比较前后 Plan/Task contract，机械判定 `task-local` / 精确 `slice-wide` / `stage-wide` 与 invalidation closure | 接受 Agent 自报影响等级、修改 Receipt |
| `packages/runtime/src/vnext/replan-epoch.ts`（新增） | append-only Replan epoch、父 epoch 链、carry-forward/invalidated Task 集合与当前 epoch 读取 | 覆盖旧 Receipt、静默迁移历史事实 |
| `packages/runtime/src/vnext/evidence-rotation.ts`（新增，内部 Runtime seam） | `mode: replan` 的全量预检、旧 Evidence archive、canonical skeleton rotation、journal/CAS/rollback/restart recovery | 计算 impact、修改 Receipt、接受 Agent 提供的 Evidence binding |
| `packages/runtime/src/cli/refresh-vnext-slice-evidence.ts` | 现有 `plan refresh-evidence` adapter；转发 `refresh/recover/rollback/replan` closed request 并投影 bounded result | 直接写 Evidence、计算 disposition、绕过 epoch authority |
| `packages/runtime/src/cli/proofloop-stage.ts` + `packages/runtime/src/vnext/cv-admission.ts` | 现有 `stage admit-cv` 的 nested CV_RESULT v2/v3 route、slice-local credential mode gate 与 consumer admission | 把 CLI 外层 schema 版本当作 credential 版本、降级 v3 为 v2、写 CV Receipt |
| `packages/runtime/src/vnext/compiler.ts` | 输出 binding 字段 + 三级指纹 | 复制 hash 逻辑 |
| `packages/runtime/src/vnext/next.ts` | Task/Slice/epoch 当前性消费（legacy 路径不动） | Git worktree 命令 |
| `packages/runtime/src/vnext/integration-admission.ts` | 消费 local binding、验证 epoch carry-forward 与 dispatch revision | 绕过 Runtime 写凭证 |
| `packages/runtime/src/vnext/gate-admission.ts` + `review-admission.ts` | 只消费当前 epoch，重新绑定 Gate/Review | 复用旧 epoch 的 Gate/Review 结论 |

- [confirmed] 禁止：AI/代码搜索推断依赖、新增 concurrency analyzer、新增并行 planner agent、用 progress.md 判断 lane 完成、保存 session id 用于恢复 authority（当前 `AGENTS.md` 与 `tech-spec/process-discipline-matrix.md` 红线）。

### 10.8 流程执行问题整改映射（FR-021..024）

| FR | 问题来源 | 架构落点 |
|---|---|---|
| FR-021 replan 保留状态 | #2 | Replan impact classifier + epoch currentness 只保留边界未变的此前 Task；当前/受影响 Task 与 Slice-wide 结果失效；materialize 禁令固化到 proofloop-plan/brain-workflow 契约 |
| FR-022 Evidence 规则 | #8 | Worker 派发模板固化 `### <task-id>` 唯一、子记录 `####`；admission 错误信息明确"任务标题必须唯一" |
| FR-023 validate 豁免 | #10 | 10.6 validate 豁免 + refresh 工具路径 |
| FR-024 纪律防复发 | #1/#3/#4/#5/#6/#7/#11/#12 | "问题 → 防复发机制 → 固化位置"对照表入权威；缺机制项补技能/契约（materialize 禁令、digest 逐字段核对清单、CV 结果立即受理） |

### 10.9 决策日志（新增）

| ID | Context | Decision | Consequences | Status |
|---|---|---|---|---|
| ADR-019 | 新旧模式共存 | binding 字段可选；无 = legacy；禁止混用 | legacy Stage 零破坏；升级需显式 replan | confirmed |
| ADR-020 | 凭证防静默混链 | payload schema_version 3 + 消费端 fail-closed（沿用 legacyTaskSchemaFinding 模式） | 三档版本清晰；v2 消费端需加判别 | confirmed |
| ADR-021 | Phase 1 边界 | 不切换 tasks.md changed_files 行为（仅预留字段） | 串行阶段零行为漂移；Phase 2 再切换 | confirmed |
| ADR-022 | validate 豁免范围 | 仅"已受理且当前有效"的 Slice 豁免；其余 fail-closed | 不掩盖真实失效 | confirmed |
| ADR-023 | 首个 slice-local 真实 Stage | S12 保持 legacy 过渡；S13 起 candidate input 显式传 `binding_mode: "slice-local"`，并由 Materializer → candidate adapter → Compiler 完整传递 | 首次真实 Stage 验证三层绑定、v3 凭证与 replan currentness；不得绕过 public plan compile | confirmed（用户决策 A） |
| ADR-024 | Replan 影响范围分级 | Runtime 根据前后 Task contract 与依赖闭包区分 `task-local`、精确 `slice-wide`（目标 Slice + transitive downstream）与 `stage-wide`（整改方案 §8.1 四态闭集）；不接受 Agent 自报等级 | 边界未变的此前 `TASK_COMPLETE` 可保留；当前/受影响 Task 必须重做；无法证明时 fail-closed | confirmed（用户 2026-08-17） |
| ADR-025 | Replan epoch 与 Stage Gate/Review | 同一 Stage/Slice 通过 append-only epoch 建立新的当前 Plan/SPV/admission；旧 Receipt 保留为历史；每个新 epoch 重新 Gate/Review | 不覆盖/删除旧 Receipt；Gate/Review 只绑定当前 epoch；未受影响成果只能作为当前证明链的继承来源 | confirmed（用户 2026-08-17） |
| ADR-026 | 永久 Replan 与 slice-local CV 边界 | 将 post-admission Replan/Evidence rotation 与 slice-local CV v3 admission 拆为两个独立 Runtime seam；复用现有 public operation set，不新增 CLI/ReceiptType；外层 CLI envelope 与 nested credential schema 分离 | Replan 可独立 fail-closed/回滚；所有 slice-local CV 都必须经过 v3 route、Stage/path binding、独立 oracle 与 source/dist/public parity；S14/S13 都必须使用该永久能力 | confirmed（用户 2026-08-18） |

### 10.10 分级 Replan 与 epoch 当前权威

<!-- proofloop:entity id="PLUGINV2-REPLAN-EPOCH-SEAM" kind="seam" -->

#### 术语与权威

- `task-local`：变更只影响当前 Task、same-slice successors 及其 downstream closure；
  变化点之前已接纳且 Task contract 未变的 Task 成果可以继承。
- `slice-wide`（精确）：Slice proof index / Slice dependency / Slice contract / 执行边界
  变化，或可归属到具体 Slice 的权威引用变化；失效范围 = 目标 Slice + transitive downstream
  Slices，受影响区域之外的已完成 Task 可 carry forward。绝不默认扩大为整个 Stage。
- `stage-wide`：Stage contract 变化，或全局 Authority 改变且无法归属任何单个 Slice
  （含 Slice set 结构变化无法局部证明安全的情形）；当前 Stage 全部 execution facts 失效，
  无任何 carry forward。
- `unresolved`：依赖闭包无法证明时 fail-closed（`REPLAN.IMPACT_UNRESOLVED`），不得猜测
  降级为 `task-local`。
- `replan_epoch`：同一 Stage/Slice 内一次被 Runtime 接纳的 Plan/Manifest/SPV/执行状态
  版本。epoch 是 append-only current authority，不是可编辑的状态字段；当前 epoch 由
  Runtime 从经过校验的 epoch Receipt 链派生。
- Agent/Brain 不得自报影响等级或 carry-forward 集合；Runtime 依据前后 admitted/current
  Manifest 的稳定 Task contract 与依赖闭包机械判定。

#### 影响判定

- Runtime 比较前一 current epoch 与候选 Plan 的 Task entity/goal/refs/acceptance/proof
  refs/dependencies/required_skills/execution_scope 规范化投影。
- 只有当 Stage contract 未变、Slice 前置 Task contract 未变、变更集合是当前 Task 与其
  后续依赖闭包时，才可判定 `task-local`。
- Stage contract 变化判定为 `stage-wide`；Slice proof index / dependency / contract /
  执行范围变化及可归属的权威引用变化判定为精确 `slice-wide`（目标 Slice + transitive
  downstream Slices）；全局 Authority 改变且无法归属单个 Slice 时升级为 `stage-wide`；
  无法完整证明影响范围时 fail-closed 为 `unresolved`，不猜测为 local。
- 验收基准（整改方案 §8.2）：Slice A/B 与 C 无依赖且已完成，修改 C Proof Index 后
  A/B=CURRENT（carry forward）、C=REPLAN、D(依赖 C)=INVALIDATED，而不是全 Stage 失效。
- `task-local` 的 `carry_forward_task_ids` 只能来自变更集合之前、contract digest 完全匹配
  且已有合法 `TASK_COMPLETE` 的 Task；当前被 replan 的 Task 及其受影响后续 Task 必须重做。

#### Epoch / Receipt / Evidence 边界

- 旧 Stage Plan、SPV、Worker、CV、Commit、Integration、Gate、Review Receipt 均保持
  write-once、原路径和原 digest；它们成为历史 epoch 事实，不被覆盖、删除或静默升级。
- Runtime 新增 append-only `REPLAN_EPOCH` authority，携带 parent epoch refs/digests、
  old/new Manifest/Plan digests、impact scope、carry-forward Task refs、invalidated Task
  refs、fresh snapshot 和新 SPV/Stage Plan refs。epoch-qualified admission refs 必须可
  从 Receipt 链重建，不能依赖 mutable current pointer。
- 新 epoch 的 Stage Plan/SPV admission、Worker/CV/Commit/Integration、Gate 和 Review
  都绑定新 epoch。旧 Gate/Review 永不复用；Stage Close 只接受当前 epoch 的 Gate PASS、
  Review ACCEPTED 与 integrated snapshot。
- carry-forward Task 的旧 `TASK_COMPLETE` 不改写为新 Receipt；Runtime 通过 Task contract
  digest、Evidence binding、changed-file scope 和 epoch carry-forward 事实验证其当前性。
  当前 replan Task 的旧 Receipt 只作历史，不能产生新的 Worker/CV 授权。
- Evidence 的 binding/Refresh 由 Runtime 根据每个 Task/Slice disposition 处理：可继承的
  前置 Task 保留其内容，当前/失效 Task 使用新的绑定与重新执行证据；Brain/Worker 不手改
  binding header 或 Receipt。

#### 永久 Runtime 子流程

<!-- proofloop:entity id="PLUGINV2-REPLAN-ROTATION-SEAM" kind="seam" -->

- `plan refresh-evidence(mode=replan)` 是永久的 Runtime preparation/rotation seam：它读取 current epoch、候选 Manifest、前后 Task/Receipt/Evidence/Git facts，机械生成 `ReplanDisposition`，再以 root-bound transaction journal + compare-and-swap 归档旧 Evidence、生成当前 skeleton、恢复 bounded mutable projection。任何 preflight 或 commit 阶段失败都必须 no-write 或 journal rollback。
- `plan admit-spv` 与 `plan admit-stage-plan` 只接纳带 parent epoch/disposition binding 的新 epoch authority；它们不接受 caller 传入的 impact/carry-forward/invalidated 集合。

<!-- proofloop:entity id="PLUGINV2-SLICE-LOCAL-CV-SEAM" kind="seam" -->

- `stage admit-cv` 保持现有 public operation：外层 command envelope 继续是 schema 2；嵌套 `CV_RESULT` 在 legacy/vNext Stage 使用 schema 2，在 slice-local Stage 使用 schema 3。Runtime 必须先判别 Manifest binding mode，再通过 shared validator 验证 binding fields、Worker tip、Context、Proof Index、current epoch 和 snapshot；任何跨模式混链都返回 `BINDING.MODE_MIXED` 并零写入。
- `readCurrentEpoch` 必须同时验证 requested `stage_id`、epoch refs 的 `stage_id`、canonical epoch-qualified path 和 parent chain；自洽但属于其他 Stage 的 epoch 不能成为当前 parent。

<!-- proofloop:entity id="PLUGINV2-REPLAN-ROTATION-ORACLE" kind="oracle" -->

Replan rotation oracle：post-admission non-pristine Evidence 只能由 Runtime 归档/轮换；旧 Evidence、Receipt、SPV、Gate、Review 不覆盖；中断、identity/CAS、symlink、缺失 parent/disposition 任一失败均 zero-write 或可验证 rollback；重启后只从 journal/epoch chain 恢复。

<!-- proofloop:entity id="PLUGINV2-SLICE-LOCAL-CV-ORACLE" kind="oracle" -->

Slice-local CV oracle：nested CV_RESULT 的 v3 credential 必须包含并匹配 Manifest 的三个 binding digests；v3 必须可经 source CLI、built CLI、public dispatcher、shared validator 与 consumer 完整抵达；v2 在 slice-local Stage 必须 fail-closed；测试不得以直接调用内部 consumer 替代 public route。

#### 执行与收口流程

```text
停新动作
→ 读取 current epoch
→ 编译候选 Plan/Manifest
→ Runtime 判定 task-local / 精确 slice-wide / stage-wide
→ Runtime 建立 Evidence/epoch replan disposition
→ final clean Git boundary
→ fresh SPV
→ 新 epoch Stage Plan admission
→ carry-forward 未受影响 Task / 重做 invalidated Task
→ 当前 epoch Gate PASS
→ 当前 epoch Stage Review ACCEPTED
→ Stage Close
```

S13 当前 `S13-A-T01` 是被重新审视的 Task，因此旧 T01 Worker Receipt/代码成果不能作为
当前 carry-forward；新增的 public CV route Task 与 T01 必须在新的当前 epoch 下重新建立完整
证明。旧 T01 文件和 Receipt 仍保留作恢复/审计事实，不构成当前授权。

<!-- proofloop:entity id="PLUGINV2-REPLAN-IMPACT-ORACLE" kind="oracle" -->

Replan oracle：Task-local 只保留 contract 完全不变的此前 `TASK_COMPLETE` Task；Slice-wide
或无法判定时不保留受影响成果；任何新 epoch 的 Gate/Review 必须绑定新 epoch/current snapshot；
旧 Receipt 永不覆盖或删除。

<!-- proofloop:entity id="PLUGINV2-REPLAN-EPOCH-RISK" kind="risk" -->

主要风险：影响闭包误判会造成旧成果静默复用或无谓重做；epoch 链、Evidence disposition、
current epoch 读取和 Gate/Review 绑定必须由 source/dist/public CLI parity、正向/零写入/旧
模式回归和 restart recovery 测试共同覆盖。

### 10.11 开放项（不阻塞）

| 项 | 影响 | Blocking? | 建议默认 |
|---|---|---|---|
| `execution_binding_digest.dependency_bindings` 串行形态与 `integration_head_sha` 来源 | 契约矩阵细节 | No | 实施时按现有 Integration Receipt 字段核实 |
| 新模式首个 Stage 编号 | 排期 | No | S13（S12 为 legacy 过渡；用户决策 A） |
| compile 时点 binding 字段的默认切换 | 兼容性 | No | 新 Stage 默认 slice-local，旧 Stage 保持 legacy |

### S12 binding oracle（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-BINDING-ORACLE" kind="oracle" -->
整改验收 oracle（FR-020..024）：只改 Slice C 时 A/B 与 stage 契约不变、A/B 证明保持有效（Case 1）；依赖链局部失效（Case 2）；Stage 全局契约变化全量失效（Case 3）；仅运行证明变化不重跑 Worker/CV（Case 4）；权威引用局部失效（Case 5）；legacy 无 binding 行为零变化（Case 6）；当前 `AGENTS.md` 与 `tech-spec/process-discipline-matrix.md` 红线不得触碰。

### S13 binding-mode oracle（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S13-BINDING-MODE-ORACLE" kind="oracle" -->
S13 首用 oracle：candidate input 明确传 `binding_mode: "slice-local"` 时，public plan compile 产出 Manifest `binding.mode: "slice-local"` 与每 Slice `slice_contract_digest`，后续 v3 凭证链保持同一模式；缺省值仍产出 legacy Manifest；未知值在 Materializer、candidate adapter 或 Compiler 任一边界 fail-closed；不得以直接调用 Compiler 的 fixture 替代 candidate input → public CLI 的真实路径。

### S12 test oracle（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-TEST-ORACLE" kind="oracle" -->
S12-A 验收 oracle：fresh clone 冒烟后全量测试全绿；配置无污染断言（测试前后项目配置文件不变）；`.proofloop/**` 不入 git。

### S12 process oracle（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-PROCESS-ORACLE" kind="oracle" -->
S12-F 验收 oracle（FR-021/022/024）：replan 后已受理 Slice 状态由 Receipt 推导不丢；Evidence 标题规则派发即知、报错明确；13 条问题均有防复发机制归属且对照表可审计。
