# AI Coding Architecture — ProofLoop v2 通用 CLI 与 OpenCode Plugin

## 1. Metadata

- Project: proofloop-v2（本仓库；ProofLoop v2 通用 CLI；OpenCode Plugin 已退役 2026-08-14）
- PRD source: `PRD.md`（CONFIRMED, 2026-08-09 已吸收 harness-neutral CLI-first 用户需求）
- Technical reference: `ProofLoop_pluginv2_流程优化方案.md`（仅作为技术设计输入；不作为第二个产品权威）
- Architecture version: 0.2.1
- Date: 2026-08-09（S09/S10 canonical Stage ID revision）
- Owner: Brain（技能 prd-to-ai-architecture；输入蓝图 + 现状代码）
- Target implementation scope: `packages/runtime` 通用 CLI + pluginv2 Runtime seams；`packages/opencode-plugin` 作为 CLI 成熟后的后续 adapter，依赖 `@proofloop/kernel`、`@proofloop/runtime`
- Status labels: `confirmed` / `assumed` / `open`

## 2. Product Scope

### Must Implement
- [confirmed] harness-neutral `proofloop` CLI 命令表面：不同 harness 的 Agent 调用相同命令，不依赖 host tool API
- [confirmed] CLI 覆盖 Authority/Plan 机械检查、角色 Context、AI 结果受理、Commit/Integration、Gate、Review、Project Acceptance、恢复和 doctor
- [confirmed] S10 CLI-first self-host：S10 的机械流程用通用 CLI 推进，不以 OpenCode `proofloop_*` tools 替代
- [confirmed] S09 一次性 bootstrap：在 S10 final Plan boundary 前闭合 executable Runtime
  Proof candidate contract、Gate executor schema 和 candidate Evidence safe refresh，避免再次以
  `not_applicable` 冒充真实运行证明
- [confirmed] 插件包 `packages/opencode-plugin`（workspace 成员；开发期放入项目级 `.opencode/plugins/**` 或用户级 `~/.config/opencode/plugins/**`，npm 发布不在本版本范围）
- [confirmed] CLI 成熟后完善 5 个粗粒度 OpenCode tools：`proofloop_plan` / `proofloop_stage` / `proofloop_review` / `proofloop_project` / `proofloop_doctor`（FR-002..006）
- [confirmed] 4 个 hooks：Protected Artifact / Dirty-State / Command Policy / Context Compaction（FR-008..011）
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
  Worker/CV/Committer/Gate/Review 按对应 admission 边界推进。
- Boundary: candidate、checkbox、progress、Agent narrative 和 SPV 结果本身不能授权执行；
  candidate Plan、candidate input 和 Evidence skeleton 必须先完成最终 Git boundary；只有
  admitted Manifest/Receipt 与当前 snapshot 一致、且 SPV/admission 之间没有相关 dirty
  或 commit 变化时才允许进入 Stage action。
- Formal Stage interpretation: S08 是正式 execution Stage。`tasks.md` 和
  `candidate-input.json` 中的 `candidate_only` 只描述 admission 之前的候选投影和
  Materializer 的写入边界；Stage Plan admission 成功后，S08 的 Worker、CV、Committer、
  Integration、Gate 和 Review 属于 Stage Goal 的正式执行范围。它们不能被 candidate
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
  SPV/Stage Plan admission、role-specific Context、Worker/CV/Commit/Integration、Gate、Stage
  Review、Project Acceptance、doctor/recovery 收敛到稳定 CLI command family。
- Role transfer: AI 负责把用户决定写入 PRD/Tech Spec 并完成语义工作；CLI 根据当前 action
  从 Authority/Plan/Manifest/Receipt/Evidence/Git 解析对应角色的最小 Context。Planning、
  SPV、Worker、CV、Committer、Reviewer 收到的内容必须不同，且由 ref/digest 绑定。
- Persistence: candidate Plan、Context、Evidence skeleton、Agent result Receipt、Gate/Review/
  Project Receipt 均由各自 Runtime owner 写入；CLI 只调 public service，不提供任意文件写接口。
- Preflight: 每次 Authority→Planning、Planning→Execution、Task→CV、CV→Commit、
  Commit→Integration、Gate→Review、Stages→Project Acceptance 前执行目标边界检查，并返回
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
