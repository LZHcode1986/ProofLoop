# AI Coding Architecture — ProofLoop v2 通用 CLI 与 OpenCode Plugin

## 1. Metadata

- Project: proofloop-v2（本仓库；ProofLoop v2 通用 CLI；OpenCode Plugin 已退役 2026-08-14）
- PRD source: `PRD.md`（CONFIRMED, 2026-08-09 已吸收 harness-neutral CLI-first 用户需求；2026-08-15 已吸收整改需求 FR-020..024）
- Technical reference: `ProofLoop_pluginv2_流程优化方案.md`（仅作为技术设计输入；不作为第二个产品权威）；
  `docs/ProofLoop-v2-slice-binding-parallel-refactor-blueprint.md` + `docs/初步实施方案.md`（2026-08-15 整改输入）
- Architecture version: 0.3.0
- Date: 2026-08-15（Slice 级证明绑定整改架构）
- Owner: Brain（技能 prd-to-ai-architecture；输入蓝图 + 现状代码）
- Target implementation scope: `packages/kernel` + `packages/runtime`（vNext 分层绑定）；OpenCode Plugin 已退役，无 adapter 义务
- Status labels: `confirmed` / `assumed` / `open`

## 2. Product Scope

### Must Implement
- [confirmed] harness-neutral `proofloop` CLI 命令表面：不同 harness 的 Agent 调用相同命令，不依赖 host tool API
- [confirmed] CLI 覆盖 Authority/Plan 机械检查、角色 Context、AI 结果受理、Commit/Integration、Gate、Review、Project Acceptance、恢复和 doctor
- [confirmed] S10 CLI-first self-host：S10 的机械流程用通用 CLI 推进，不以 OpenCode `proofloop_*` tools 替代
- [confirmed] S09 一次性 bootstrap：在 S10 final Plan boundary 前闭合 executable Runtime
  Proof candidate contract、Gate executor schema 和 candidate Evidence safe refresh，避免再次以
  `not_applicable` 冒充真实运行证明
- [confirmed] 插件包 `packages/opencode-plugin`（workspace 成员；开发期放入项目级 `.opencode/plugins/**` 或用户级 `~/.config/opencode/plugins/**`，npm 发布不在本版本范围；2026-08-14 已退役，条目仅作历史）
- [confirmed] CLI 成熟后完善 5 个粗粒度 OpenCode tools：`proofloop_plan` / `proofloop_stage` / `proofloop_review` / `proofloop_project` / `proofloop_doctor`（FR-002..006；插件退役后不构成交付义务）
- [confirmed] 4 个 hooks：Protected Artifact / Dirty-State / Command Policy / Context Compaction（FR-008..011；插件退役后由 CLI 侧等效机制承担）
- [confirmed] 项目检测（ProofLoop 标识）+ `.proofloop/runtime.lock` 校验 + fail closed（FR-001/FR-013）
- [confirmed] 按角色隔离工具：全局 deny + 角色 allow + 运行时二次校验（FR-007）
- [confirmed] Token 预算与 compact 输出（FR-012）
- [confirmed] CLI/插件 parity 测试 + 真实 Git workflow 测试 + 会话恢复测试（FR-014..016）

### Explicit Non-Goals
- [confirmed] npm 发布（发布清单记录，后续执行）
- [confirmed] Pi、Claude Code 或其他 harness 的专用 extension/tool adapter（通用 CLI 本身必须可直接调用）
- [confirmed] 新流程语义（kernel/runtime 权威；插件不定义任何 PASS/COMPLETE）
- [confirmed] 旧 Receipt 自动迁移（仅显式 migration 命令）
- [confirmed] Windows/macOS 完整验证（代码跨平台注意，验收 Linux）
- [confirmed] 非 ProofLoop 项目任何 ProofLoop 行为（doctor 除外）

### Future / Out of Scope
- [open] npm 发布；更多宿主适配（pi-extension）

### 整改范围（2026-08-15，FR-020..024）

#### Must Implement（整改）
- [confirmed] 三级绑定：`stage_contract_digest` / `slice_contract_digest` / `execution_binding_digest`（FR-020）
- [confirmed] 已集成且未受影响的 Slice 在 replan 后保持有效；旧模式行为零变化（FR-020 Case 1-7）
- [confirmed] replan 保留已受理 Slice 执行状态 / Evidence 规则固化 / validate 豁免 / 纪律防复发对照表（FR-021..024）
- [confirmed] 测试 fixture 自包含 + 测试环境隔离（工程卫生，Task 0）

#### Explicit Non-Goals（整改）
- [confirmed] 并行执行 / worktree 工作区 / Brain 与宿主并发改造（蓝图 Phase 2-5）
- [confirmed] 删除 tasks.md 状态、改集成 Git 工作流、会话 id 持久化、固定 repair 次数、CV PASS 后自动 rebase

## 3. PRD to Architecture Mapping

| PRD item | Technical implication | Architecture decision | Status |
|---|---|---|---|
| FR-001 项目检测 | 需要确定性项目标识 + 非 ProofLoop 无感 | 标识 = `.proofloop/runtime.lock`（主）+ manifests/delivery 存在性（辅）；检测失败 → 不注册工具（doctor 除外） | confirmed |
| FR-002 plan 工具 | 封装规划与计划认可 | candidate plan 只引用 PRD/Tech Spec/AWI；Runtime 编译/验证；Stage Plan admission 是独立的 Runtime authority boundary，不由 candidate 或 SPV narrative 代替 | confirmed（vNext admission seam 仍需完成 Host/Runtime parity） |
| FR-003 stage 工具 | 单动作阶段执行 | Runtime 派生唯一 next action、最小 Context Projection、4 类 admit 与 Gate；Brain 不替代 Runtime 状态判断 | confirmed（vNext Context/next seam 仍需完成） |
| FR-004 review 工具 | 封装评审受理 | admit stage_review（ACCEPTED/REPAIR）；REPAIR 无 Receipt 分支 | confirmed |
| FR-005 project 工具 | 项目验收 | compileProjectAcceptance / runProjectAcceptanceE2E（`PROJECT_E2E_PASS/FAIL/BLOCKED`）/ finalizeProjectReview（S5 planned） | confirmed |
| FR-006 doctor | 诊断 | 本地检查：版本/Git/artifact 根/schema/宿主 API 兼容 | confirmed |
| FR-007 角色隔离 | 宿主权限 + 插件校验 | 依赖宿主 tool permission（OC-0 已验证）；插件内二次校验调用上下文 | confirmed（实现仍须满足 AWI-011） |
| FR-008..011 hooks | 宿主生命周期 | 映射到 opencode plugin hooks（before/after tool、事件）；未覆盖触发路径保留真实宿主集成验证 | confirmed（实现仍须满足 AWI-012） |
| FR-012 token | 输出预算 | ToolResult 统一形状 + compact renderer（status ≤1000、next ≤1500、findings ≤20、receipt ref+digest） | confirmed |
| FR-013 版本锁 | runtime.lock | kernel `validateRuntimeLock` + fail closed | confirmed |
| FR-014 parity | 多入口一致性 | Runtime source/dist、通用 CLI 与后续插件 adapter 对同一 fixture 调用同一 Runtime 语义；CLI 是稳定主表面，adapter 不能改变语义 | confirmed |
| FR-015/016 | git workflow / 恢复 | 复用 runtime reconcile（Receipt 权威）+ B3 已验证链路 | confirmed |
| FR-017/018 | 单一权威 / 受控切换 | vNext CLI、Host 和 Runtime 共享同一 schema discriminator、consumer 与 Receipt binding；先迁移 parity oracle，再删除 v1 CLI route，旧制品只保留显式 fail-closed 读取边界 | confirmed（S10 实施） |
| FR-019 | harness-neutral CLI / self-host | 一个稳定 CLI command family 覆盖完整机械流程；根据 action/role 生成不同 Context；所有受理与转换检查走 Runtime；S10 用该 CLI 自举 | confirmed（用户 2026-08-09） |

## 4. Architecture Views

### System Context
- User: OpenCode、Pi、Claude Code 等 harness 的使用者与 ProofLoop Agent 角色
- System: `@proofloop/runtime` 的 harness-neutral CLI（S10 主交付）+ 后续 `@proofloop/opencode-plugin` adapter
- External systems: Agent harness（只需 shell/command 能力）；Git 仓库；业务项目目录（`.proofloop/`）；后续 OpenCode plugin API
- Local boundary: 全部本地；网络 deny-by-default

### Containers
| Container | Responsibility | Technology | Port/path | Persistent state | Notes |
|---|---|---|---|---|---|
| @proofloop/kernel | 领域规则/契约/Receipt 校验 | TypeScript 库 | — | 无 | 现有，零依赖 |
| @proofloop/runtime | 应用服务与通用 CLI：resolve/reconcile/admit/next/context/runner | TypeScript 库 + stable CLI command family | `proofloop <domain> <operation>`；repo 内 built entry | 无（读写项目 artifacts） | S10 主交付；不得 import harness SDK |
| @proofloop/opencode-plugin | 后续宿主适配：工具/hooks/context | TypeScript 库（plugin 入口） | 开发期 `.opencode/plugins/**`；发布期 `opencode.json` npm 包名 | 无 | CLI 成熟后完善；不作为 S10 机械路径 |
| 业务项目目录 | ProofLoop 项目工作区 | — | `.proofloop/`、`delivery/` | receipts/manifests/runtime/runtime.lock | CLI/Runtime 主操作目标；后续插件复用 |

### Components（插件包内）
| Component | Responsibility | Does not own | Inputs | Outputs | Dependencies |
|---|---|---|---|---|---|
| `index.ts` | 插件入口：注册 tools/hooks、加载配置 | 流程语义 | opencode plugin API | plugin 定义 | config、host-context、tools、hooks |
| `config.ts` | 读取项目配置 + runtime.lock 校验 | 版本决策 | 项目根 | Config、lock 状态 | kernel validateRuntimeLock |
| `host-context.ts` | RuntimeContext（projectRoot/worktree/currentDir/callerRole/cancellation/logger） | 信任根决策（用 worktree 根，禁裸 cwd） | 宿主上下文 | OpenCodeRuntimeContext | adapters/logger |
| `tools/plan.ts` | proofloop_plan 实现 | 不实现规划语义 | ToolInput | ToolResult | runtime 库 |
| `tools/stage.ts` | proofloop_stage 实现 | 不实现派生/受理语义 | ToolInput | ToolResult | NextActionService、admission、runGate |
| `tools/review.ts` | proofloop_review 实现 | 不替代评审判断 | ToolInput | ToolResult | admission（stage_review） |
| `tools/project.ts` | proofloop_project 实现 | 不定义验收语义 | ToolInput | ToolResult | project-acceptance 库 |
| `tools/doctor.ts` | 诊断检查 | — | ToolInput | ToolResult | runtime/环境检查 |
| `hooks/protect-artifacts.ts` | 阻止直接写受保护路径（receipts/manifests/runtime/runtime.lock） | 写入权限决策 | 写操作事件 | 阻止/放行 | receipt-layout 路径规则 |
| `hooks/invalidate-cache.ts` | 设置 stage_cache_dirty | 缓存内容 | 文件/Git/命令事件 | dirty 标记 | — |
| `hooks/command-policy.ts` | 阻止旧 CLI/拼接命令/未声明 cwd | 命令内容 | 命令事件 | 阻止/放行 | process-runner 校验语义 |
| `hooks/compact-context.ts` | 压缩后注入最小恢复指针 | 事实内容 | 压缩事件 | 恢复提示 | — |
| `adapters/logger.ts` | 日志（写 .proofloop/logs/） | — | 日志事件 | 日志文件 | — |
| `adapters/git.ts` | Git 读操作封装（可注入测试） | 不写 Git | 项目根 | Git 事实 | — |
| `adapters/process.ts` | 命令执行封装 | 命令决策 | CommandSpec | 执行结果 | runtime process-runner |
| `generated/tool-schemas.ts` | 工具 JSON schema（构建生成或手写维护） | schema 语义 | — | schemas | kernel 契约 |
| `generated/capability-map.ts` | 角色→工具能力映射 | 权限决策 | — | map | — |
| Runtime Context Resolver | 按 action/role 生成最小 root/digest-bound Context | 不复制完整 Authority/Plan，不授权状态 | Manifest、Receipts、Git、Evidence refs | ContextRef + digest | runtime vNext |
| Active Plan Materializer | 将已确认 AWI/Authority refs 生成 candidate Plan | 不生成 Manifest、Receipt、Evidence 或实现方案 | PRD/Tech Spec/AWI refs | candidate `tasks.md` | `proofloop-plan` |

### Components（通用 CLI / Runtime）
| Component | Responsibility | Does not own | Inputs | Outputs | Dependencies |
|---|---|---|---|---|---|
| `cli/proofloop.ts` | 稳定 command dispatcher；解析 domain/operation 并调用 command adapter | 不实现状态机、语义判断或 Receipt 写逻辑 | argv + structured request | canonical JSON + exit status | `cli/commands/*` |
| `cli/io.ts` | 统一 request-file/JSON input、root assertion、canonical stdout/stderr/exit contract | 不解释业务语义 | command args、JSON | parsed request / closed error | path guard、schema |
| `cli/commands/authority-plan.ts` | Authority ref 检查、candidate materialize、compile/validate/evidence/SPV/Stage Plan admission 的机械入口 | 不理解用户意图、不生成 Plan 语义 | closed AI result + refs | candidate/Manifest/Evidence/Receipt refs | materializer、vNext compiler/admission |
| `cli/commands/stage.ts` | status/next/context、Worker/CV/Commit/Integration admission、Gate | 不派发 Agent、不做 CV/Review 判断 | stage requests / Agent envelopes | NextAction/Context/Receipt/Gate refs | vNext services |
| `cli/commands/review-project.ts` | Stage Review 与 Project Acceptance 的 prepare/finalize/status/run 操作 | 不替 Reviewer 作结论 | persisted refs + AI verdict | role Context / Receipt refs | review/project services |
| Runtime Context Resolver | 按 action/role 从同一持久事实生成不同最小 Context | 不生成通用 Prompt，不复制全部 Authority | refs/digests/state/snapshot | content-addressed ContextRef | vNext resolver |
| Transition Preflight | 在每个机械边界校验所需制品、依赖、Git、digest 和 Receipt chain | 不判断产品语义是否正确 | target boundary + persisted facts | ready/blocked + Findings + next | validators/reconcile |

## 5. Technical Context

- Language/runtime: TypeScript（Node ≥ 20；当前 Node 25 实测通过）
- Frameworks: 无运行时框架；测试 vitest（workspace 现有）
- Package manager: npm workspaces（根 package.json 已配 `packages/*`）
- Target platform: Linux（验收）；代码注意跨平台（POSIX/Windows 进程树 kill 已有 platform-adapter）
- Storage: 项目目录 `.proofloop/`（receipts/manifests/runtime/runtime.lock/logs）——机器权威
- Test runner: vitest（include `packages/**/src/**/*.spec.ts`、`test/**/*.spec.ts`）
- Build: `npm run build`（tsc -b packages/kernel packages/runtime packages/opencode-plugin）
- External dependencies: 无运行时外部依赖（kernel/runtime 零宿主依赖；插件仅依赖两者）
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

### Flow: 插件加载
- Trigger: opencode 自动加载项目级 `.opencode/plugins/**`（或用户级 `~/.config/opencode/plugins/**`）；发布版通过 `opencode.json` npm 包名加载
- Pre-conditions: 项目根可用；opencode plugin API 可用
- Steps: 读配置 → 检测 ProofLoop 标识 → 校验 runtime.lock（fail closed）→ 初始化 RuntimeContext → 注册工具（按角色）→ 注册 hooks（仅 ProofLoop 项目）
- State changes: 无持久状态
- Success: 工具/hooks 就绪；非 ProofLoop 项目零注册
- Failure: lock 缺失/版本不兼容 → fail closed（不注册，doctor 除外）
- Acceptance evidence: S1（OC-1）验收；加载冒烟

### Flow: stage next（核心）
- Trigger: S10 的 Brain/Agent 调通用 CLI `proofloop stage next`；后续 plugin tool 只作同语义 adapter
- Steps: CLI 校验 projectRoot/request → 调用 vNext NextAction/Context Resolver（Reconcile→Validate→Reduce→Action→role-specific Context）→ canonical JSON/compact projection
- Success: 唯一 Next Action + refs
- Failure: 阻断 finding / chain 断裂 → fail closed + Finding
- Acceptance evidence: parity（CLI next-action 对照）；S2（OC-2）

### Flow: admit（写入）
- Trigger: Agent 把 Worker/CV/Commit/Integration 等 closed result envelope 交给对应通用 CLI command
- Steps: 校验 AdmissionRequest（kernel 契约）→ 统一 admit 管线（validate→reconcile→precheck→按版本选择 Receipt writer→chain verify）→ 返回 ref+digest
- Success: 不可变 Receipt 落盘
- Failure: 请求非法 → 结构化拒绝，不写 Receipt
- Acceptance evidence: parity（CLI admit 对照）；S3（OC-3）

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
- Trigger: Brain/Agent 调通用 CLI Stage Gate command；后续 plugin tool 复用同一 Runtime seam
- Steps: prepareGateFacts → runGate（Process Runner，服务生命周期/超时/清理）→ admit gate_result
- Acceptance evidence: S5（OC-5）；B3 已验证 runtime 侧

### Flow: project acceptance
- Trigger: Brain 调通用 CLI Project Acceptance commands；后续 plugin tool 复用同一 Runtime seam
- Steps: compile_acceptance → run_e2e（`PROJECT_E2E_PASS/FAIL/BLOCKED` receipt）→ prepare/finalize_review（Project Review Receipt）
- Acceptance evidence: S5（OC-5）；B1c 已验证 runtime 侧

### Flow: pluginv2 S08 formal execution（candidate 到执行）
- Trigger: Brain 选择 dependency-ready AWI。
- Steps: Planning Skill 生成 candidate Plan（每个 implement Task 必须声明 immutable execution scope）→ Runtime
  compile/validate → Runtime 按已验证 Manifest 初始化 Evidence skeleton → 完成 candidate Plan/
  candidate input/Evidence 的最终 Git boundary → fresh SPV（绑定 clean worktree 的当前 Git
  HEAD）→ Runtime Stage Plan admission（再次
  校验 clean worktree 与 HEAD）→ `proofloop_stage(next)` → Runtime 返回最小 Context →
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

### Flow: pluginv2 S10 harness-neutral CLI-first self-host
- Trigger: S08 正式执行链已闭环；用户要求先形成跨 OpenCode/Pi/Claude Code 通用 CLI，
  OpenCode Plugin 完善后置。
- Scope: 将 Authority/Plan preflight、candidate materialization、Manifest/Validator/Evidence/
  SPV/Stage Plan admission、role-specific Context、Worker/CV/Slice Commit/Integration、Gate、Stage
  Review、Project Acceptance、doctor/recovery 收敛到稳定 CLI command family。
- Role transfer: AI 负责把用户决定写入 PRD/Tech Spec 并完成语义工作；CLI 根据当前 action
  从 Authority/Plan/Manifest/Receipt/Evidence/Git 解析对应角色的最小 Context。Planning、
  SPV、Worker、CV、Reviewer 收到的内容必须不同，且由 ref/digest 绑定。
- Persistence: candidate Plan、Context、Evidence skeleton、Agent result Receipt、Gate/Review/
  Project Receipt 均由各自 Runtime owner 写入；CLI 只调 public service，不提供任意文件写接口。
- Preflight: 每次 Authority→Planning、Planning→Execution、Task→CV、CV→Slice Commit、
  Slice Commit→Integration、Gate→Review、Stages→Project Acceptance 前执行目标边界检查，并返回
  ready/blocked、Findings、refs 与唯一 next action。
- Bootstrap prerequisite: 原 S08B（现 canonical S10）首次 compile/Validator/Evidence initialization 复核发现
  `runtime_proof.resolved_steps` 仍只有 `not_applicable`；active candidate parser 与 Materializer
  不接受 executable step，Evidence initializer 对旧非空 skeleton 也没有 manifest rebind。
  因此不能等 S10-A 集成后再修改已 admitted Manifest。
- Self-host order: 先执行一次性 S09 bootstrap Stage → 统一 candidate/parser/dispatch/Gate 的
  executable Runtime Proof step schema，并提供仅限 pre-admission pristine skeleton 的 Runtime-owned
  `plan refresh-evidence` → 重新 materialize/compile S10 并写入至少一个真实 executable step →
  建立 final Plan/Evidence boundary 和 fresh SPV/admission → S10-A 集成 public CLI bootstrap →
  后续 S10 mechanics 全走 public CLI → restart/harness-neutral process tests → 删除 v1 stage CLI
  和旧概念。
- Bootstrap exception: S09 自身可以使用一次、显式标注的 `not_applicable` Runtime Proof，
  因为它的唯一目标正是建立 executable proof seam；该例外必须由测试/CV/Review 记录为
  restricted bootstrap，不得计入 AWI-023/S10/项目验收，也不得被后续 Stage 复用。
- Boundary: S10 不以 OpenCode `proofloop_*` tools 证明完成；不同 harness 只需允许 Agent
  执行相同 command，不得新增 harness-specific tool implementation。
- Failure: unknown/cross-version、stale binding、root escape、不完整 envelope、缺失角色 Context、
  非法 transition 或 broken chain 均 canonical Finding + no-write；不得只放宽断言。
- Out of scope: 专用 Pi/Claude/OpenCode adapter、OpenCode hooks/tools 完善、S08-REVIEW-010
  的旧 S08 Runtime Proof 回填。

## 6.2 pluginv2 S08/S09/S10 oracle entities

### S08-A oracle
<!-- proofloop:entity id="PLUGINV2-S08-A-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-002..004、FR-017；`ProofLoop_pluginv2_流程优化方案.md` §4、§9.5、§11。
- Oracle：显式 v1/vNext schema/version 才能决定 consumer boundary；v2 输入不得静默回退到
  v1，未知或不匹配输入必须返回 bounded Finding。
- 观察要求：真实 plan/stage/review 入口对 v1/v2 paired fixture 得到明确分流结果，拒绝路径
  不产生执行事实。

### S08-B oracle
<!-- proofloop:entity id="PLUGINV2-S08-B-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-002、FR-017、FR-018；`ProofLoop_pluginv2_流程优化方案.md` §9.4、§9.5。
- Oracle：candidate Manifest 和 fresh SPV 都不是执行授权；只有 Runtime Stage Plan admission
  在最终 Plan/Evidence Git boundary 之后，同时绑定 Stage、Manifest、Plan、SPV 和当前
  snapshot 后，Manifest 才能成为执行前权威。
- 观察要求：缺失、陈旧、篡改、重复或 digest 不一致的 admission 输入都 fail closed，旧
  Manifest/Receipt 不能通过修改恢复；dirty worktree 或 admission request 的 snapshot
  不等于当前 HEAD 时不得写入新的 Stage Plan authority。

### S08-C oracle
<!-- proofloop:entity id="PLUGINV2-S08-C-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-003、FR-011、FR-016、FR-017；`ProofLoop_pluginv2_流程优化方案.md` §11、§14。
- Oracle：`proofloop_stage(next)` 只能由 Runtime 从持久事实派生一个 Primary Next Action，并
  返回最小、root-bound、digest-bound Context；Context 必须携带来自 admitted Plan 的非空
  execution scope，Brain、Worker 和 checkbox 不得手工补造 Context。
- 观察要求：合法 admitted state 返回结构化 action/ContextRef，且 implement Task 的
  Context 同时覆盖 code/test scope 与 Evidence path；缺少 scope、scope 只覆盖 Evidence、
  scope 越界、未 admission、stale digest 或 identity mismatch 时只返回 bounded `VALIDATE`，
  不得先返回 `DISPATCH_WORKER` 再由 Worker 发现 `PLAN_GAP`。

### S08-D oracle
<!-- proofloop:entity id="PLUGINV2-S08-D-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-014、FR-015、FR-016、FR-018；`ProofLoop_pluginv2_流程优化方案.md` §19、§20。
- Oracle：Runtime source/dist、CLI 和 Host tool 对同一 fixture 的 action、Finding、Receipt/digest
  和 fail-closed 行为一致；path escape、symlink、TOCTOU、stale snapshot 和 unadmitted next
  不得产生执行 authority。
- 观察要求：使用真实入口、filesystem/Git 和重启边界验证，不以内部函数或 narrative 替代。

### S08-E oracle
<!-- proofloop:entity id="PLUGINV2-S08-E-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-003、FR-004、FR-011、FR-014、FR-015、FR-016、FR-017、FR-018；
  `ProofLoop_pluginv2_流程优化方案.md` §11–§20。
- Oracle：在 admitted S08 上，Runtime 从当前 persisted facts 投影唯一的 Worker/CV/
  Commit/Integration/Gate/Review action；执行期 scope 内 dirty diff 不使 Stage 回到
  planning；每个 vNext Receipt/Context 绑定当前 Manifest/Plan/前序 digest 和适用 snapshot。
- 观察要求：真实 Host/Runtime/source/dist/CLI/filesystem/Git fixture 必须覆盖 Worker
  完成后 RUN_CV、CV PASS/REPAIR、Slice Commit、Integration、Gate、Review、recovery 和
  v1/vNext mixed-consumer fail-closed；不接受只验证内部函数或 checkbox。

### S10 harness-neutral CLI oracle（稳定 entity id 保留历史 `S08B` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B-CLI-ORACLE" kind="oracle" -->
- 独立来源：`PRD.md` FR-002..006、FR-010、FR-014、FR-016..019；Context Resolver/Proof
  Index/Runtime admission contracts；用户 2026-08-09 的 harness-neutral、CLI-first 和
  “不同 harness 只改 Agent、不改工具”决策。
- Oracle：普通命令行进程必须能完成 ProofLoop v2 全部机械操作，并根据 action/role 产生
  不同 Context；OpenCode、Pi、Claude Code 只需调用相同命令和 schema。CLI 与 Runtime
  source/dist 产生相同 action、Finding、Context/Receipt canonical JSON、digest、Gate verdict
  和 no-write 结果；不得依赖 Host tool 或 SDK 才能通过。
- 观察要求：真实 built CLI 从干净 fixture 走 Authority/Plan preflight→plan admission→
  Worker/CV/Commit/Integration→Gate/Review→Project Acceptance，并执行会话/harness 重启；
  每个角色 Context 的内容边界可区分；非法 transition 和旧制品 fail closed。S10 自身必须
  在 bootstrap 后使用该 CLI 推进，不能用 `proofloop_*` tool 替代；三个既有 Host 失败按
  canonical CLI 行为判根因，Runtime/CLI 问题本阶段修复，纯 adapter 问题登记到后续 Plugin 工作。
- Runtime Proof 要求：S10 Manifest 必须含至少一个非 `not_applicable` step；Gate 必须实际执行
  canonical `command | service_start | service_stop | probe` step 并持久化逐步结果。all-skipped
  不能证明本 Oracle。

### S09 executable Runtime Proof bootstrap oracle（稳定 entity id 保留历史 `S08B0` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B0-BOOTSTRAP-ORACLE" kind="oracle" -->
- 独立来源：原 S08B（现 canonical S10）首次 Runtime compile/Validator/Evidence persisted artifacts、S08-REVIEW-010、
  kernel Runtime Proof step contract 与用户 2026-08-09 批准的一次性 bootstrap 决策。
- Oracle：active candidate input 能 closed 接受 canonical executable proof steps、Runtime 计算
  `proof_digest` 且 caller 不可注入；dispatch 与 Gate runner 接受同一 type/field set。Manifest
  digest 变化时，只有 Runtime `plan refresh-evidence` 能在 pre-admission 且 skeleton 仍为原始空
  模板时原子刷新 Plan/Manifest/Proof Index binding；已有 Task Evidence、CV 状态或 Receipt 时
  fail closed。多 Slice 更新必须有 transaction journal，不能把中断后的部分更新伪装为成功。
- 观察要求：source + built process fixture 必须覆盖 executable command PASS/FAIL、未知字段/type、
  caller digest、S10 ProofSpecification 的 executable-step requirement、canonical `^S\d+$` Stage
  ID grammar、pristine refresh success、non-pristine/stale/symlink/partial-write refusal。S09 的一次性
  `not_applicable` 只记录 bootstrap 限制，不得当作本 Oracle
  或 AWI-023 已完成的证据。

## 7. Decision Log

| ID | Context | Decision | Consequences | Status |
|---|---|---|---|---|
| ADR-001 | 插件如何调用 runtime | 后续插件进程内调用 runtime 库 API，**不** shell 出 CLI 子进程；通用 CLI 与插件 adapter 同时复用这些 public services | 插件无子进程/解析开销；CLI 仍是 harness-neutral 主机械合同与自举入口，不再只是 parity 对照 | confirmed（2026-08-09 补充 CLI-first 边界） |
| ADR-002 | opencode plugin API 不稳定 | 宿主交互全部收敛在 host-context + adapters；工具/hooks 内部不直接触碰宿主 API 细节 | 版本升级只改 adapter；OC-0 产出 Compatibility Matrix | confirmed |
| ADR-003 | 分发 | 开发期本地插件放入项目级 `.opencode/plugins/**`（或用户级 `~/.config/opencode/plugins/**`）；发布版在 `opencode.json` 使用 npm 包名；npm 发布记录清单后续执行 | 验收不依赖发布；版本 0.1.0 | confirmed（2026-08-03 按宿主官方加载规则更正） |
| ADR-004 | 信任根 | projectRoot = canonical worktree root；禁止裸 process.cwd() 作为 artifact 信任根 | 多项目/会话安全 | confirmed |
| ADR-005 | 角色识别 | 优先宿主 tool permission（角色 allow）；宿主不提供身份时插件运行时二次校验调用上下文；能力边界 OC-0 验证后定稿 | 影响 FR-007 实现细节 | confirmed（OC-0 定稿：agent.tools 默认 deny + 按 agent allow + execute(context.agent) 二次校验；宿主提供 agent name 非 ProofLoop role，角色映射为插件策略） |
| ADR-006 | 工具数量 | 5 个粗粒度工具（每工具多操作），不为每个 Validator 注册独立工具 | token 面小、误用面小 | confirmed |
| ADR-007 | 缓存 | stage_cache 仅进程内；跨会话一律从 Receipt 重算 | 一致性由 Receipt 权威保证 | confirmed |
| ADR-008 | 版本基线与蓝图差异 | 蓝图基线 v2/3.0.0 为历史参考；实际以 packages 0.1.0 实现为权威 | 文档记录差异，不按蓝图版本号实施 | confirmed |
| ADR-009 | 宿主版本约束 | 开发/验收锁定 OpenCode CLI 1.18.11 + @opencode-ai/plugin 1.18.4（OC-0 实测环境）；兼容范围需 CI 矩阵 | 宿主升级需重跑 host compatibility 测试 | confirmed（OC-0） |
| ADR-010 | pluginv2 权威分层 | PRD 是产品权威；Tech Spec 分别拥有架构/合同/Hard Part/AWI；candidate、Manifest、Receipt、Evidence、Git 各自只承担其事实域 | 避免方案文档、Plan、progress 或 Agent narrative 成为第二事实源 | confirmed（PRD/方案整合） |
| ADR-011 | pluginv2 执行前边界 | Planning Skill 只生成 candidate；Runtime 负责 compile/validate/admission/Context；Stage action 只能从 admitted facts 进入 | 旧 plugin 可回退；不隐式迁移旧制品；stale digest 必须阻断 | confirmed（方案 §4、§9、§11、§19） |
| ADR-012 | Runtime 与 Agent 分工 | Runtime 派生确定性状态和唯一 next action；Worker/CV/Reviewer 负责语义判断；Brain 只做全局路由和一个动作 | 减少重复上下文；禁止 Agent 手工构造 Context/Receipt/Gate verdict | confirmed（方案 §5、§11–§17） |
| ADR-013 | SPV 前 Git boundary | candidate Plan/input 先由 Runtime compile/validate，Runtime 再按 Manifest initialize Evidence；Plan/input/Evidence 随后进入 final Git boundary，fresh SPV/admission 绑定 clean worktree 的当前 HEAD；SPV 通过后无相关变化则不重复 SPV | 防止在脏树上取得 PLAN_READY、随后 commit 使旧 Receipt 失效；相关变化必须 fail closed 并 fresh SPV | confirmed（用户 2026-08-05 明确确认；2026-08-09 对齐 Runtime initializer 顺序） |
| ADR-014 | S08 formal execution 与两种 Git boundary | S08 在 Stage Plan admission 后正式执行；admission 前使用 planning clean boundary，admission 后使用 admitted scope-bound dirty boundary；Runtime 必须提供 Worker→CV→Commit→Integration→Gate→Review 的 vNext 状态和 consumer | 不再把合法 Worker diff 当作 stale planning；所有下游结果仍绑定 Manifest/Plan/Context/Receipt/snapshot；v1 回退保持显式 | confirmed（用户 2026-08-06 明确选择 S08 为正式执行 Stage；需通过 S08-E 完成验证） |
| ADR-015 | S10 harness-neutral CLI-first | 通用 CLI 是 S10 主机械表面；OpenCode、Pi、Claude Code 的 Agent 调同一命令，只调整 Agent 定义；S10 用 CLI 自举，OpenCode Plugin 完善后置 | CLI 必须覆盖完整流程与角色 Context，不能把 Host tool 当缺口替代；专用 harness adapter 不进 S10；S08-REVIEW-010 单独排期 | confirmed（用户 2026-08-09；2026-08-09 canonical Stage ID migration） |
| ADR-016 | 稳定 CLI command family | 对 Agent 暴露一个稳定 `proofloop <domain> <operation>` command family；现有 `dist/cli/*.js` 作为迁移期内部 entry，最终由 dispatcher 复用同一 command adapters，不能成为各 harness 不同的公共合同 | 小公共表面隐藏 Runtime 复杂度；统一 root/request/output/exit；后续 plugin 直接复用 Runtime service 而不改变 CLI | confirmed（基于 FR-019 与现有多脚本入口缺少 package `bin` 的代码事实） |
| ADR-017 | S09 executable proof bootstrap | S10 final boundary 前先建立独立 S09：统一 executable Runtime Proof schema，并增加 Runtime-owned pristine Evidence refresh；S09 可一次性使用明确的 `not_applicable` bootstrap 例外，但 S10 必须真实执行 proof steps | 避免在 S10-A 后修改 admitted Manifest 导致全部 binding 失效；bootstrap restricted，不计入 AWI-023 或项目完成；后续 Stage 禁止复用例外 | confirmed（用户 2026-08-09；首次 S08B persisted Manifest 复核） |
| ADR-018 | Canonical Runtime Stage ID | Runtime admission/status 的 Stage ID 只使用 `^S\d+$`；bootstrap = `S09`，通用 CLI = `S10`。旧标签 `S08B0`/`S08B` 只作为 invalid candidate/历史导航，不得进入 Runtime request | 避免 compile/Validator 宽松接受、status/admission 再拒绝；S09 同时补齐 compiler/Validator/status/admit 的 grammar parity 回归 | confirmed（用户 2026-08-09 批准 S09；Runtime status 实测） |

## 8. Open Questions / Verification Residuals

| Question | Why it matters | Blocking? | Resolution / residual |
|---|---|---|---|
| opencode plugin API 能力边界（tool permission、hook 生命周期、agent 身份、取消） | 决定 FR-007/008..011 的实现方式 | No（OC-0 已定稿） | 以 `host-compatibility.md` 的能力矩阵和 adapter 方案为准；permission.ask / command.execute.before / compaction 仍需真实宿主集成测试复核 |
| 最小 opencode 版本 | 发布矩阵与测试环境 | No（基线已锁定） | 开发/验收基线为 OpenCode CLI 1.18.11 + `@opencode-ai/plugin` 1.18.4；未来版本通过 CI 矩阵扩展 |

## 9. Pre-Code Readiness

- [x] Scope and non-goals are explicit（§2）
- [x] Critical architecture decisions labeled（§3/§7）
- [x] Components have clear owners and boundaries（§4 Components）
- [x] APIs/files/state represented in contract matrix → artifact 2（contract-state-matrix.md，已按 kernel 权威对齐）
- [x] Hard parts registered → artifact 3（hard-parts-register.md，HP-001 VALIDATED；HP-002/003 方案已定）
- [x] Product requirements have been re-confirmed in `PRD.md`（2026-08-09）
- [x] S08 Final Plan/Evidence Git boundary、fresh SPV 与 Stage Plan admission 已完成
- [x] S08 external acceptance/seam/oracle/risk entities 已 root-bound 且可解析
- [x] S08 formal execution loop 已闭环 Worker/CV/Commit/Integration/Gate/Review（受 S08-REVIEW-010 限制）
- [x] S10（旧标签 S08B）的 AWI-023、harness-neutral CLI seam/oracle/acceptance refs 完成 authority boundary（`51d80a2`）
- [ ] S09 executable Runtime Proof/Evidence refresh bootstrap authority、Plan 和 restricted execution 完成
- [ ] 当前旧 S08B candidate/Manifest/Evidence 保持 parked/blocked；S09 后由 Materializer 以 S10 replan/rebind
- [ ] stable `proofloop <domain> <operation>` 覆盖完整机械流程和角色 Context
- [ ] S10 bootstrap 后通过通用 CLI self-host 完成 Execution→Review，并用 fresh candidate fixture 验证 Plan 全链；不依赖 OpenCode tools
- [ ] v1 CLI/legacy 概念只在新 CLI 全链 oracle 通过后移除，并完成 restart/harness-neutral process tests

## 10. 整改架构：Slice 级证明绑定（2026-08-15，Phase 1 串行）

> 本节承接 PRD FR-020..024 与蓝图第 4-8 节、初步实施方案；只收录架构决策，实施细节见后续制品。

### 10.1 范围

- [confirmed] 目标：FR-020 连坐消除 + FR-021 replan 保留状态 + FR-022 Evidence 规则固化 + FR-023 validate 豁免 + FR-024 纪律防复发 + 测试自包含。
- [confirmed] 永久能力边界：post-admission Task-local/Slice-wide Replan、epoch currentness、Evidence rotation 与 slice-local CV v3 public admission 都是正式 Runtime 能力；不是只为 S13 历史恢复案例提供的一次性迁移工具。
- [confirmed] 非目标：并行执行 / worktree / Brain 与宿主并发改造（蓝图 Phase 2-5）；删除 tasks.md 状态；改集成 Git 工作流；会话 id 持久化；固定 repair 次数；CV PASS 后自动 rebase。

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
| `packages/runtime/src/vnext/worker/cv/commit/integration-admission.ts` | 消费 local binding、验证 epoch carry-forward 与 dispatch revision | 绕过 Runtime 写凭证 |
| `packages/runtime/src/vnext/gate-admission.ts` + `review-admission.ts` | 只消费当前 epoch，重新绑定 Gate/Review | 复用旧 epoch 的 Gate/Review 结论 |

- [confirmed] 禁止：AI/代码搜索推断依赖、新增 concurrency analyzer、新增并行 planner agent、用 progress.md 判断 lane 完成、保存 session id 用于恢复 authority（蓝图 §38 红线）。

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

### PLUGINV2-S12-BINDING-ORACLE（oracle）
<!-- proofloop:entity id="PLUGINV2-S12-BINDING-ORACLE" kind="oracle" -->
整改验收 oracle（FR-020..024）：只改 Slice C 时 A/B 与 stage 契约不变、A/B 证明保持有效（Case 1）；依赖链局部失效（Case 2）；Stage 全局契约变化全量失效（Case 3）；仅运行证明变化不重跑 Worker/CV（Case 4）；权威引用局部失效（Case 5）；legacy 无 binding 行为零变化（Case 6）；蓝图 §38 红线不得触碰。

### PLUGINV2-S13-BINDING-MODE-ORACLE（oracle）
<!-- proofloop:entity id="PLUGINV2-S13-BINDING-MODE-ORACLE" kind="oracle" -->
S13 首用 oracle：candidate input 明确传 `binding_mode: "slice-local"` 时，public plan compile 产出 Manifest `binding.mode: "slice-local"` 与每 Slice `slice_contract_digest`，后续 v3 凭证链保持同一模式；缺省值仍产出 legacy Manifest；未知值在 Materializer、candidate adapter 或 Compiler 任一边界 fail-closed；不得以直接调用 Compiler 的 fixture 替代 candidate input → public CLI 的真实路径。

### PLUGINV2-S12-TEST-ORACLE（oracle）
<!-- proofloop:entity id="PLUGINV2-S12-TEST-ORACLE" kind="oracle" -->
S12-A 验收 oracle：fresh clone 冒烟后全量测试全绿；配置无污染断言（测试前后项目配置文件不变）；`.proofloop/**` 不入 git。

### PLUGINV2-S12-PROCESS-ORACLE（oracle）
<!-- proofloop:entity id="PLUGINV2-S12-PROCESS-ORACLE" kind="oracle" -->
S12-F 验收 oracle（FR-021/022/024）：replan 后已受理 Slice 状态由 Receipt 推导不丢；Evidence 标题规则派发即知、报错明确；13 条问题均有防复发机制归属且对照表可审计。
