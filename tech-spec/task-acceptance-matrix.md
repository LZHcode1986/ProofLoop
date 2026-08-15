# Architecture Work Item Matrix — ProofLoop v2 通用 CLI 与 OpenCode Plugin

> AWI-* 是项目级工作单元（非 Stage Task / Worker Task）。依赖顺序：Setup → 阻塞基础（OC-0）→ 用户可见功能 → 集成验证 → pluginv2 切换。用户可见功能切片不得在阻塞基础完成前开始。
> 本矩阵只索引 AWI、依赖和 Authority References；详细产品验收回到 `PRD.md`，技术 seam/verification 回到 architecture/Contract，禁止捷径和残余风险回到 Hard Parts。历史行保留用于迁移审计，不作为 Stage Task 的第二事实源。

## Dependency Groups

1. **Setup**: AWI-001（包骨架）
2. **Foundational blocking**: AWI-004（OC-0 Host API Spike → HP-001）、AWI-002（Context/检测/lock）、AWI-003（ToolResult/compact/错误模型）
3. **User-visible feature slices**: AWI-005..012（doctor、stage、plan、review、project、角色隔离、hooks）
4. **Integration and polish**: AWI-013..016（parity、git workflow、恢复、token benchmark）
5. **Final verification**: AWI-017（host integration + 发布清单 + 全量验证）
6. **pluginv2 active vNext boundary and CLI-first cutover**: AWI-018..024（显式分流、Stage Plan admission、Context handoff、正式执行链、executable proof bootstrap、harness-neutral 通用 CLI/self-host/cutover）

## Matrix

| Work Item ID | Architecture Work Item | Depends on | Files/modules | Definition of done | Test/acceptance evidence | Forbidden shortcuts |
|---|---|---|---|---|---|---|
| AWI-001 | 插件包骨架 | — | `packages/opencode-plugin/`（package.json、tsconfig、src/index.ts 空入口、test 空壳） | workspace 注册；`npm run build` 含该包；开发期入口放入项目 `.opencode/plugins/**` 后可被 opencode 自动加载（空实现） | 构建通过；项目级 `.opencode/plugins/**` 加载冒烟（空插件无错） | 跳过 workspace 注册；入口不导出；把本地路径写入 `opencode.json` |
| AWI-002 | Host Context / Config / 项目检测 / runtime.lock | AWI-001 | `host-context.ts`、`config.ts`、`adapters/logger.ts` | RuntimeContext（projectRoot=worktree 根、currentDir、callerRole、cancellation、logger）；检测 ProofLoop 标识；lock 校验 fail closed；非 ProofLoop 零注册 | 单测（检测矩阵、lock 校验）；加载冒烟（ProofLoop/非 ProofLoop 各一） | 用裸 cwd 作信任根；lock 不校验；非 ProofLoop 也注册 |
| AWI-003 | ToolResult 统一形状 + compact renderer + 错误模型 | AWI-002 | `generated/tool-schemas.ts`（部分）、`tools/_shared.ts`（或等价） | ToolResult {ok, data?, findings, refs, runtime}；预算截断（status ≤1000 / next ≤1500 / findings ≤20 / receipt ref+digest） | 单测（截断边界、错误映射） | 输出不截断；错误非结构化 |
| AWI-004 | OC-0 Host API Spike → Compatibility Matrix | AWI-001 | spike 工程（独立验证脚本）+ `tech-spec/host-compatibility.md` | 验证：plugin 加载、工具注册+权限、hook 触发、directory/worktree、cancellation、logging、agent identity；产出可复核矩阵 + 决策（影响 AWI-011/012） | 宿主文档/真实 spike 结果 + 矩阵文档 + Stage Review（HP-001）；已清理的旧 spike 文件不得作为唯一证据 | 不 spike 直接假设；矩阵缺失；把不可复核文件当唯一证据 |
| AWI-005 | proofloop_doctor | AWI-002/003 | `tools/doctor.ts` | 6 项检查输出结构化诊断；非 ProofLoop 可用 | 单测 + 冒烟 | 检查项为占位 |
| AWI-006 | proofloop_stage 只读（status/next） | AWI-002/003 | `tools/stage.ts`（status/next 操作） | 调 NextActionService；输出 15 值 action + compact；fail closed | 单测 + parity（vs CLI next-action） | 绕过 NextActionService 自实现派生 |
| AWI-007 | proofloop_plan | AWI-002/003 | `tools/plan.ts` | compile/initialize_evidence/validate/status/admit_spv_result 全部接线 runtime 库 | 单测 + parity（vs CLI） | 部分操作缺失；不接 admit 管线 |
| AWI-008 | proofloop_stage 写入（4 类 admit + run_gate） | AWI-006 | `tools/stage.ts`（4 类 admit；S5 增加 run_gate） | `admit_worker_result` / `admit_cv_result` / `admit_slice_commit` / `admit_integration` 四类 stage admit 接线；S5 再接入 run_gate（facts→runGate→内部 gate-result admission）；`gate_result` / `gate_interrupted` 是跨工具 admission request 类型，不计入 stage 工具直接 operation 数 | S3 单测 + parity（vs CLI admit）；S5 增补 run-gate parity 与 gate interruption 测试 | 直接写 Receipt 文件绕过管线；把跨工具 admission 类型误报成 9 类 stage operation |
| AWI-009 | proofloop_review | AWI-003 | `tools/review.ts` | stage_status/prepare/finalize（ACCEPTED/REPAIR 分支）接线 | 单测 + parity | REPAIR 分支写 Receipt |
| AWI-010 | proofloop_project | AWI-003 | `tools/project.ts` | compile_acceptance/run_e2e/prepare/finalize/status 接线 project-acceptance 库 | 单测 + parity（vs CLI project CLI） | 绕过 E2E receipt 语义 |
| AWI-011 | 角色隔离 | AWI-004 决策后 | `generated/capability-map.ts`、tools 入口校验 | 全局 deny + 角色 allow + 插件内二次校验；角色×工具矩阵测试 | 角色矩阵测试全绿（HP-002） | 只依赖宿主权限；校验空操作 |
| AWI-012 | 4 个 Hooks | AWI-004 决策后 | `hooks/*.ts` | protect-artifacts / invalidate-cache / command-policy / compact-context 按宿主能力接线 | 真实触发场景测试（HP-003） | mock 声明当验证 |
| AWI-013 | CLI/Plugin parity 测试集 | AWI-006..010 | `test/parity/`（新） | 全部工具操作 × 代表性 fixture 五维对比；纳入每次 Stage Gate | parity 全绿 + Stage Gate 报告（HP-004） | 只测部分操作；字节级不一致放过 |
| AWI-014 | 真实 Git workflow 测试 | AWI-008 | `test/git-workflow/`（新） | 两个真实 Slice 闭环（CV→commit→no-ff integration→gate）→ Gate PASS | Stage Gate Receipt PASS + git log（HP-005） | mock git；单 slice |
| AWI-015 | 会话恢复测试 | AWI-006 | `test/recovery/`（新） | kill 后仅靠 Git/Receipts 恢复一致 | 恢复测试（HP-006） | 会话内存恢复 |
| AWI-016 | Token benchmark + compact 优化 | AWI-003/013 | benchmark 脚本 + renderer 调整 | 同一 fixture 对照 CLI 方案：总 token 不高于旧方案、目标 ≥10% 降低 | benchmark 记录 + 结论（HP-007） | 不测量直接声明 |
| AWI-017 | Host integration + 发布清单 + 全量验证 | AWI-005..016 | 发布清单文档 + 全量测试 | 发布清单（蓝图 §16 7 条）记录；全量测试全绿；非 ProofLoop 无感验证；存在启动真实 opencode CLI 并断言 `proofloop_doctor` / `proofloop_stage` 注册的集成测试（无 CLI 时可 skip，但测试本身必须存在） | 全量 vitest + 真实 CLI host integration 冒烟 + 清单文档 | 发布清单缺失；只做动态 import 而无真实 CLI 断言；全量未跑 |

| AWI-018 | pluginv2 v1/vNext 显式分流与 candidate boundary | AWI-002/003/006/007/009 | Runtime vNext route、candidate Plan boundary、Host route projection | v1/v2 fixture 进入互斥 consumer boundary；candidate 不授权执行；未知/跨版本输入 fail closed，无 silent fallback | PRD FR-002/017；architecture S08-A oracle；Contract S08-A seam；HP-009 | 不把 v2 输入交给 v1 consumer；不从 Markdown/checkbox 推断 authority |
| AWI-019 | vNext Stage Plan admission authority | AWI-018 | Runtime vNext admission、SPV/Stage Plan authority boundary | Runtime 先 compile/validate candidate Manifest，再按 Manifest initialize Evidence；candidate Plan/input/Evidence 完成最终 clean Git boundary 后仅 Runtime 受理 fresh SPV；Stage/Manifest/Plan/snapshot/SPV digest 完整绑定且 snapshot 等于当前 HEAD；Receipt write-once；未 admission 不授权执行；绑定未变化时 next 不重复 SPV | PRD FR-002/017/018；architecture S08-B oracle；Contract S08-B seam；HP-009/HP-012 | 不手写 Receipt；不在 dirty worktree 上 SPV/admission；不在 SPV/admission 后提交相关文件；SPV_PASS 不直接当 execution authority；不覆盖旧 Receipt |
| AWI-020 | canonical next/context handoff | AWI-019 | Runtime next/Context Resolver、Host stage next projection | `proofloop_stage(next)` 返回唯一 action 与 digest-bound ContextRef；只选择可证明 dependency-ready Slice；scope/evidence/skills 最小且 root-bound；每个 implement Task 的 Context 必须覆盖非空 code/test scope，不能退化为 Evidence-only scope | PRD FR-003/011/016/017；architecture S08-C oracle；Contract S08-C seam；HP-009 | 不复制完整 tasks.md；不手工构造 Context；不以 narrative/checkbox 推断下一 Task；scope 缺失时不得先 dispatch 后由 Worker 发现 |
| AWI-021 | unified CV、parity、安全与 cutover boundary | AWI-018..020/013/015 | CV contract、source/dist/CLI/Host parity、path/TOCTOU/recovery/cutover tests | initial CV 独立反驳且 Evidence 后读；repair 后 fresh recheck；source/dist/CLI/Host 一致；切换 Gate 未完成时旧 plugin 可回退 | PRD FR-004/014/015/016/018；architecture S08-D oracle；Contract S08-D seam；HP-010/011 | 不恢复 CV Level/Profile；不以 mock/internal seam 代替真实入口；不提前删除/迁移旧路径 |
| AWI-022 | vNext Stage formal execution loop | AWI-018..021 | Runtime vNext state machine、Worker/CV/Commit/Integration/Gate/Review admission、expected-dirty recovery | Stage Plan admission 后，Runtime 必须从 persisted facts 依次投影 Worker → CV → Slice Commit → Integration → Gate → Review；执行期允许且只允许声明 scope 内 dirty diff；每个结果绑定 Manifest/Plan/Context/snapshot，v1 consumer 不得读取 v2 facts | PRD FR-003/004/011/014/015/016/017/018；architecture S08-E oracle；Contract S08-E seam；HP-009/010/011/014 | 不用 clean-worktree planning gate 阻断合法执行 diff；不以 checkbox/narrative 推进状态；不把 v2 结果送入 legacy reconcile；不缺失 CV/Commit/Integration/Gate/Review 的 vNext admission |
| AWI-023 | harness-neutral ProofLoop v2 通用 CLI 与 CLI-first self-host | AWI-013/017/021/022/024 | `packages/runtime` stable CLI dispatcher/I/O/commands、Context Resolver、plan materializer/admission、stage/review/project/doctor Runtime seams、process/restart fixtures、legacy cleanup | `proofloop <domain> <operation>` 以统一 closed JSON/exit/ref+digest 合同覆盖 Authority/Plan、角色 Context、Worker/CV/Commit/Integration、Gate、Stage Review、Project Acceptance、recovery/doctor；不 import harness SDK；S10 Manifest 含真实 executable proof，S10-A 集成后全部机械动作使用该 CLI 自举；同一 fixture 在 OpenCode/Pi/Claude agent caller 模型下不改 command/schema；非法转换 no-write；全链 oracle 通过后删除 v1 stage CLI/legacy CV 残留；三个既有 Host 失败以 CLI 判根因，Runtime/CLI 问题修复，adapter-only 问题后置；AWI-023 验收依据含 git_facts 兜底 Gate + 受限 Stage Close（2026-08-14 用户裁决新先例，见 PLUGINV2-S08B-CLI-ACCEPTANCE 实体） | PRD FR-002..006/010/014/016..019；architecture S10 harness-neutral CLI oracle；Contract §0/§5.2 S10 seam；HP-004/010/011/014/015；S08-D/E risk | 不以 OpenCode `proofloop_*` tool 或 harness adapter 补 CLI 缺口；不用 all-skipped Gate 证明 S10；不提供任意文件写；不把同一 Context 发给全部角色；不在 self-host/oracle 前删除旧入口；不静默解释旧 artifact；不为全仓绿混入 Plugin 实现或放宽 CLI 断言；不在本项回填 S08-REVIEW-010 |
| AWI-024 | S09 executable Runtime Proof、canonical Stage ID 与 Evidence refresh bootstrap | AWI-019/022 | vNext candidate parser/compiler/dispatch、Gate proof executor、Stage ID validators、Evidence initializer/refresh、active Materializer contract/helper、built CLI bootstrap entry | active candidate closed 接受 canonical executable proof step，Runtime 独占 proof digest，dispatch/Gate 使用同一 `command\|service_start\|service_stop\|probe` schema；candidate/compiler/Validator/status/admit 共用 `^S\d+$` Stage ID grammar；`plan refresh-evidence` 仅对 pre-admission pristine skeleton 执行 root-bound、journaled、expected-binding refresh，non-pristine/stale/symlink/interrupted transaction fail closed；S09 restricted close 后 S10 可 replan 为真实 executable proof | architecture S09 bootstrap oracle；Contract §5.3 seam；HP-015；S09 acceptance；source/built PASS+FAIL、digest/type、Stage ID parity、refresh/restart/transaction tests | 不手写 Manifest/proof digest/Evidence；不维护第二套 proof type/Stage ID grammar；不覆盖已有执行内容；不 post-admission refresh；不把 S09 的 `not_applicable` 例外复用到 S10 或项目验收 |

## 暂停 Stage 关闭登记（2026-08-14 用户裁决：S4/S5/S6 不再实施）

旧插件规划中的暂停 Stage（S4 保护钩子 / S5 Gate-Project / S6 Token 优化）经评估不再实施，对应 AWI 的能力由更强的 vNext/CLI-first 机制覆盖。相关 PRD 需求（FR-008..012）语义不变，仍由下列机制满足：

## OpenCode Plugin 退役登记（2026-08-14 用户裁决）

CLI 已自举验证并完成项目验收（PROJECT_REVIEW_PASS `37a30b69`）。全部机械校验由
`proofloop <domain> <operation>` CLI + kernel/runtime 承担，插件不贡献校验逻辑；角色权限
隔离由各 harness 的 Agent 配置承担。`packages/opencode-plugin`、`.opencode/plugins/proofloop.js`
与 3 个 v1 legacy 单用途入口（compile-manifest / validate-stage / initialize-slice-evidence）
已删除。以下 AWI 及其承载需求由 CLI 机制覆盖：

| AWI | 承载 | 退役后覆盖机制 |
|---|---|---|
| AWI-001..003 插件骨架/doctor/stage 工具 | 插件包与 Host 工具 | CLI authority/doctor/stage 域（10 域 closed set） |
| AWI-005..010 插件 plan/stage 写入/review/project 工具 | 插件 Host 工具 | CLI plan/context/stage/review/project 域 |
| AWI-011 角色隔离 | 插件内二次校验 | 各 harness Agent 配置权限 + CLI root/role Context 最小投影 |
| AWI-013 CLI/Plugin parity 测试集 | Host 工具 vs CLI parity | Runtime source/dist 与 CLI 入口 parity（vNext 夹具） |
| AWI-017 Host integration + 发布清单 | 真实 opencode CLI 注册断言 | 项目验收 E2E（build + 全量测试 + CLI 冒烟 + 归档识别）已覆盖同等验证 |

| AWI | 原 Stage | 关闭原因 / 覆盖机制 |
|---|---|---|
| AWI-011 角色隔离 | S4 | vNext 角色 Context（不同角色最小、digest-bound Context）+ Host 权限 fail-closed（direct role 禁止 ProofLoop 工具与 admission CLI）覆盖 |
| AWI-012 4 个 Hooks | S4 | bounded writer（root-fd/O_NOFOLLOW/write-once）+ Worker Context forbidden_paths + CLI closed 域/root assertion 覆盖 FR-008/FR-010；Git 事实重派生取代脏缓存（FR-009）；恢复重读持久事实规则覆盖压缩指针（FR-011） |
| AWI-010 proofloop_project | S5 | CLI project 域（proofloop-project.ts：compile/run-e2e/prepare-review/finalize-review/status）覆盖 |
| AWI-014 真实 Git workflow 测试 | S5 | S09/S10/S11 真实执行链实证（Worker→CV→Commit→Integration→Gate→Review 多次真实通过，Gate Receipt + Git 历史可审计）覆盖 |
| AWI-008 S5 增补（run_gate parity / gate interruption） | S5 | CLI gate 域（proofloop-gate.ts：run/status）+ S10/S11 真实 Gate 通过覆盖 |
| AWI-016 Token benchmark + compact 优化 | S6 | FR-012 实现已交付（S1 compact.ts：status≤1000 / next≤1500 / findings≤20 / Receipt ref+digest）；CLI-first 后旧插件方案退役，benchmark 无对比基线，不实施 |
| AWI-015 会话恢复测试 | 独立 AWI（未挂 Stage） | vNext restart-recovery 覆盖闭合（2026-08-14）：S08-C-T04/S11 实现并验证“kill 后仅靠 Git/Receipts 恢复”语义（restart-recovery-vnext.spec.ts：tampered receipt fail-closed、out-of-scope artifact 拒绝、checkbox 不推进状态等）；S10-E-T01 selfhost restart fixture 同覆盖 |

## Machine-readable pluginv2 AWI entities

### AWI-018 goal
<!-- proofloop:entity id="AWI-018" kind="goal" -->
pluginv2 必须在 v1/vNext consumer 之间显式分流；candidate Plan 是可审查的候选投影，不能单独授权执行。Authority refs：`PRD.md` FR-002/FR-017、S08-A oracle/seam/risk/acceptance。

### AWI-019 goal
<!-- proofloop:entity id="AWI-019" kind="goal" -->
Runtime 必须以 fresh SPV 和完整 Stage/Manifest/Plan/snapshot digest 绑定建立唯一 Stage Plan admission authority，并保持 Receipt write-once。Authority refs：`PRD.md` FR-002/FR-017/FR-018、S08-B oracle/seam/risk/acceptance。

### AWI-020 goal
<!-- proofloop:entity id="AWI-020" kind="goal" -->
Runtime 必须从 admitted 持久事实投影唯一 next action 和最小 root/digest-bound Context，缺失或 stale binding 时不得 dispatch Worker。Authority refs：`PRD.md` FR-003/FR-011/FR-016/FR-017、S08-C oracle/seam/risk/acceptance。

### AWI-021 goal
<!-- proofloop:entity id="AWI-021" kind="goal" -->
pluginv2 必须以统一 adversarial-first CV、入口级 parity、安全边界、恢复和 cutover Gate 证明可回退、可审计和不隐式迁移。Authority refs：`PRD.md` FR-004/FR-014/FR-015/FR-016/FR-018、S08-D oracle/seam/risk/acceptance。

### AWI-022 goal
<!-- proofloop:entity id="AWI-022" kind="goal" -->
S08 作为正式 execution Stage 时，admitted Stage Plan 必须能够沿 persisted vNext facts 完成 Worker、CV、Slice Commit、Integration、Stage Gate 和 Stage Review；planning 的 clean Git boundary 与 execution 期 scope-bound dirty diff 必须是两个明确边界。Authority refs：`PRD.md` FR-003/FR-004/FR-011/FR-014/FR-015/FR-016/FR-017/FR-018、S08-E oracle/seam/risk/acceptance。

### AWI-023 goal
<!-- proofloop:entity id="AWI-023" kind="goal" -->
S10 必须建立不依赖 OpenCode、Pi、Claude Code tool API 的 ProofLoop v2 通用 CLI，使用同一
command/schema 覆盖完整机械流程，并根据阶段和角色投影不同 Context、验证并保存 closed AI
结果、在转换前检查制品和从本地事实恢复。S09 bootstrap 后 S10 必须用该 CLI 自举；OpenCode
Plugin 完善后置，不能用 Host tool 掩盖 CLI 缺口。全链 oracle 通过后才删除 v1 stage CLI 和
legacy CV 残留；S08-REVIEW-010 单独排期。Authority refs：`PRD.md` FR-002..006/FR-010/
FR-014/FR-016..019、S10 CLI oracle/seam/acceptance、HP-004/HP-010/HP-011/HP-014/HP-015、
S08-D/E risk。

### AWI-024 goal
<!-- proofloop:entity id="AWI-024" kind="goal" -->
S09 必须在 S10 final Plan boundary 前补齐 executable Runtime Proof candidate contract 与
Runtime-owned pristine Evidence refresh：统一 candidate/compiler/dispatch/Gate schema，由 Runtime
计算 proof digest；manifest 变化时只允许 pre-admission、无执行内容的 skeleton 通过 journaled
refresh 更新 binding；candidate/compiler/Validator/status/admit 必须统一拒绝非 `^S\d+$`
Stage ID。S09 的一次性 `not_applicable` 只作 restricted bootstrap，不得证明
AWI-023。Authority refs：`PRD.md` FR-014/FR-016/FR-019、S09 bootstrap oracle/seam/acceptance、
HP-012/HP-015。

## Machine-readable pluginv2 S08/S09/S10 acceptance entities

### S08-A acceptance
<!-- proofloop:entity id="PLUGINV2-S08-A-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-018。
- Acceptance：对 plan/stage/review 的 v1/v2 paired fixture，显式 schema/version 选择互斥
  consumer；v2 不回退 v1；未知、跨版本、path 不可信输入返回 bounded Finding，且不写执行权威。
- Required evidence：真实 Host tool/Runtime seam 的 route matrix、failure projection 和
  no-silent-fallback regression；不接受 checkbox、progress 或 narrative 作为结果。

### S08-B acceptance
<!-- proofloop:entity id="PLUGINV2-S08-B-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-019。
- Acceptance：candidate Plan、candidate input 和 Evidence skeleton 必须先完成最终 clean
  Git boundary；只有 Runtime Stage Plan admission 在同一 Stage、Manifest、Plan、当前
  HEAD/snapshot 和 fresh SPV digest 全部绑定且 Receipt write-once 成功后，v2 Manifest 才可
  授权执行；SPV_PASS 后绑定未变化时不重复 SPV；缺失/过期/篡改/重复输入、dirty worktree
  或 HEAD mismatch 必须 fail closed。
- Required evidence：admission success/failure matrix、Receipt ref/digest readback、旧
  Receipt 不覆盖、clean-boundary gate、stale HEAD/dirty worktree rejection 和
  no-admission dispatch refusal。

### S08-C acceptance
<!-- proofloop:entity id="PLUGINV2-S08-C-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-020。
- Acceptance：合法 admitted state 的 `proofloop_stage(next)` 只返回一个 Runtime-derived
  Primary Next Action 和 digest-bound ContextRef；Context 包含最小 refs/skills/Evidence 和
  admitted Plan 的 execution scope。implement Task 必须同时有非空 code/test scope；只含
  Evidence、缺失、越界、篡改或 digest 不一致时不产生 Worker dispatch。
- Required evidence：next/context structured projection、scope source/digest binding、
  root/scope checks、missing-scope/ evidence-only negative cases、restart recovery 和
  bounded `VALIDATE` cases。

### S08-D acceptance
<!-- proofloop:entity id="PLUGINV2-S08-D-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-021。
- Acceptance：同一 v1/v2 fixture 在 Runtime source/dist、Runtime CLI、Host tool 和真实
  filesystem/Git 边界的 action/Finding/digest/fail-closed 结果一致；path escape、symlink、
  TOCTOU、stale snapshot 和 unadmitted next 均不能产生执行 authority。
- Required evidence：入口级 parity、digest comparison、真实 path/security 反例和重启恢复
  记录；不接受内部函数或 mock 代替 public seam。

### S08-E acceptance
<!-- proofloop:entity id="PLUGINV2-S08-E-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-022。
- Acceptance：在当前 Manifest/Plan/Stage Plan admission 下，Worker Result 能进入 vNext
  CV；CV PASS/REPAIR、Slice Commit、Integration、Stage Gate 和 Stage Review 均有显式
  Runtime/Host consumer、Receipt schema 和 Manifest/snapshot binding。Worker 产生的
  scope 内 dirty diff 不得被 planning clean gate 误判为 stale；scope 外、旧 snapshot、旧
  Context、v1 Receipt 或未 admission 的结果必须 fail closed。
- Required evidence：真实 Host/Runtime action matrix、Worker→CV→Commit→Integration→Gate→Review
  end-to-end fixture、dirty execution boundary、recovery/recheck、v1/vNext isolation、
  Receipt digest/readback 和 no-silent-fallback regression。

### S09 executable Runtime Proof bootstrap acceptance（稳定 entity id 保留历史 `S08B0` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B0-BOOTSTRAP-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-024。
- Acceptance A（proof schema）：active candidate input closed 接受 `command | service_start |
  service_stop | probe` executable steps 和个别 `not_applicable`；unknown field/type、非法
  executable/args/cwd/timeout、caller `proof_digest` 在 Manifest write 前 fail closed。Runtime
  canonical 计算 digest；candidate/compiler/dispatch/Gate 不得存在第二套 type/field semantics。
- Acceptance B（Evidence refresh）：`plan refresh-evidence` 只在 pre-admission、无 Stage execution
  Receipt 且 Manifest 声明的全部 skeleton 仍为 pristine template 时允许；验证 expected old
  binding、root/no-follow 和 file identity，使用 transaction journal + per-file compare-and-swap。
  non-pristine/stale/missing/extra/symlink/competitor/interruption 必须 no-success；中断后的部分状态
  可检测、可 rollback/recover，final validator 不允许混合 binding 进入 SPV。
- Acceptance C（bootstrap boundary）：S09 可一次使用 all-skipped `not_applicable`，但 Evidence、
  Gate 和 Review 必须标记 `restricted bootstrap`；它不关闭 AWI-023，也不进入项目验收。Stage close
  后必须能 replan/recompile 当前 blocked S10、refresh 5 个 pristine skeleton，并生成至少一个
  executable proof step 的 S10 Manifest。
- Required evidence：source + built process PASS/FAIL、unknown/digest negative matrix、proof step
  Gate execution、pristine/non-pristine/stale/symlink/competitor/interruption/restart refresh matrix、
  journal recovery、final all-binding Validator、S10 recompile/refresh dry run，以及旧
  `S08B0`/`S08B` stage_id 在 compile/Validator/status/admit 全部 fail closed。不得手写 Manifest、
  digest 或 Evidence header。

### S10 harness-neutral CLI/self-host acceptance（稳定 entity id 保留历史 `S08B` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B-CLI-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-023。
- Acceptance A（stable public seam）：真实 built `proofloop <domain> <operation>` 提供统一
  request-file/JSON input、canonical JSON envelope、closed operation、root assertion、ref+digest
  和 exit contract；unknown domain/op 在任何写入前 fail closed。Runtime package 不依赖任何
  harness SDK；现有单用途 scripts 不是公共合同。
- Acceptance B（Authority/Plan/Context）：CLI 能检查所选 Authority refs、保存 closed AI plan
  input/candidate、compile/validate/initialize/refresh/admit Plan，并为 Planning、SPV、Worker、initial
  CV、CV recheck、Committer、Stage Reviewer、Project Reviewer 生成各自不同且 digest-bound
  的 Context；initial CV Evidence read gate 保持有效。
- Acceptance C（execution persistence）：Worker/CV/Slice Commit/Integration/Gate 的 structured
  result 只能经 CLI→Runtime public admission 保存；每次重验 Context/scope/snapshot/changed
  files/前序 Receipt，成功返回 Receipt ref+digest，非法/stale/cross-version/root escape/
  duplicate/broken chain 均 canonical Finding + no-write。
- Acceptance D（Review/Project/Doctor）：Stage Review prepare/finalize、Project Acceptance
  compile/run-e2e/prepare/finalize/status 与 doctor/recovery 均可从同一 public CLI 调用，不依赖
  OpenCode tools；Project/Stage verdict 仍由 AI Reviewer 提供，CLI 不替代判断。
- Acceptance E（self-host/harness independence）：S09 必须先闭合 executable proof 与 Evidence
  refresh；S10 Manifest 至少一个 executable Runtime Proof step。S10-A CLI bootstrap boundary
  提交并集成后，S10 的 next/context、后续 Slice admission、Gate 和 Stage Review 全部通过
  public CLI。同一 built executable/request fixture 模拟 OpenCode/Pi/Claude caller 时
  command/schema/output 不变，只允许 Agent definition/permission fixture 不同；重启后仅靠
  本地持久事实恢复。
- Acceptance F（cutover）：A–E 全绿后才迁移旧 oracle并删除 v1 stage CLI consumer、
  `cv_level`/`sync-cv-status`、旧注释/fixture/Host legacy 权限；旧 artifact 继续显式检测和
  fail closed。三个既有 Host 失败记录 canonical 根因；Runtime/CLI 错则本阶段修复，纯
  OpenCode adapter 错则形成后续 Finding，不为全仓绿把 Plugin 实现混入 S10。
- Required evidence：真实 CLI process stdout/exit/canonical envelope、各角色 Context diff、
  Receipt/Context digest/no-write readback、S10 self-host transcript/
  Receipts、实际执行的 Runtime Proof step/Gate/Review、restart fixture、三类 harness-neutral caller
  fixture、legacy scan、build、Runtime/CLI full tests 与 plugin known-failure/no-new-regression 记录。
  不得用 Host tool 结果替代 CLI 证据。
- Acceptance evidence note（2026-08-14 用户裁决，新先例）：Stage Review ACCEPTED 缺失时，
  AWI-023 验收可接受 S10 的 git_facts 兜底 Gate（`verification_source: git_facts`，显式声明、
  absence-gated、git 事实可审计）与受限 Stage Close 作为验收依据；该先例仅适用于受限关闭
  场景，正常 Stage 仍要求 `STAGE_REVIEW_PASS` 与真实 executable Gate proof。
- Out of scope：S08-REVIEW-010 的 Runtime Proof、Manifest/Gate/Review 重验不得混入 S10。

## pluginv2 S08/S09/S10 authority traceability

| Stage/Slice | Architecture oracle | Contract seam | Risk entity | Acceptance entity | AWI |
|---|---|---|---|---|---|
| S08-A | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08-A-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08-A-SEAM` | `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-A-RISK` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08-A-ACCEPTANCE` | AWI-018 |
| S08-B | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08-B-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08-B-SEAM` | `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-B-RISK` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08-B-ACCEPTANCE` | AWI-019 |
| S08-C | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08-C-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08-C-SEAM` | `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-C-RISK` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08-C-ACCEPTANCE` | AWI-020 |
| S08-D | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08-D-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08-D-SEAM` | `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-D-RISK` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08-D-ACCEPTANCE` | AWI-021 |
| S08-E | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08-E-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08-E-SEAM` | `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-E-RISK` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08-E-ACCEPTANCE` | AWI-022 |
| S09 | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08B0-BOOTSTRAP-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08B0-BOOTSTRAP-SEAM` | `tech-spec/hard-parts-register.md#/entities/HP-015-EXECUTABLE-PROOF-BOOTSTRAP` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08B0-BOOTSTRAP-ACCEPTANCE` | AWI-024 |
| S10 | `tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08B-CLI-ORACLE` | `tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08B-CLI-SEAM` | `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-D-RISK` + `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-E-RISK` | `tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08B-CLI-ACCEPTANCE` | AWI-023 |

## Traceability

| PRD requirement | Architecture section | Contract/state row | Work Item IDs | Acceptance evidence |
|---|---|---|---|---|
| FR-001 项目检测 | §3/§6 加载流程 | §3 runtime.lock/manifests | AWI-002 | 检测矩阵 + 冒烟 |
| FR-002 plan | §6 plan / pluginv2 flow | §1.1 + S08-B + S09 | AWI-007/018/019/024 | plan/admission/refresh parity |
| FR-003 stage | §6 next/admit/gate / pluginv2 flow | §1.2 + S08-C/E + S10 CLI | AWI-006/008/020/022/023 | next/context/admission parity |
| FR-004 review | §6 review | §1.3 + S08-E + S10 CLI | AWI-009/022/023 | parity |
| FR-005 project | §6 project / S10 CLI flow | §0 project + §1.4 + §5.2 | AWI-010/023 | CLI process + project parity |
| FR-006 doctor | §6 CLI/doctor | §0 doctor + §1.5 | AWI-005/023 | CLI structured diagnostics |
| FR-007 角色隔离 | ADR-005/§4 | §7 HOST 错误 | AWI-011 | 角色矩阵 |
| FR-008..011 hooks | §4 hooks | §2 | AWI-012 | 真实触发测试 |
| FR-012 token | ADR-006/§5 | §1 预算 | AWI-003/016 | 单测 + benchmark |
| FR-013 版本锁 | §6 加载 | §3 runtime.lock | AWI-002 | lock 测试 |
| FR-014 parity | §6 / S09/S10 CLI flow | §0 + §1 各操作 + §5.2/§5.3 | AWI-013/021/024/023 | executable proof + CLI/source/dist 与后续 adapter parity；harness-neutral process fixtures |
| FR-015 git workflow | §6 | §5 | AWI-014 | Gate Receipt PASS |
| FR-016 恢复 | §6 | §5/§5.3 | AWI-015/024 | 恢复测试 + Evidence refresh transaction/restart |
| FR-017 单一权威与派生投影 | ADR-010/011 | §3/§5.1 | AWI-018/019/020 | invalidation + no-unapproved-dispatch |
| FR-018 pluginv2 切换与回退 | ADR-011/012/015 | §4/§5.1/§5.2 | AWI-021/022/023 | cutover/recovery/fail-closed tests |
| FR-019 harness-neutral CLI/self-host | ADR-015..018 + S09/S10 flow/oracle | §0 + §5.2/§5.3 | AWI-024/023 | executable proof bootstrap、全命令矩阵、角色 Context、S10 CLI self-host、restart/harness-neutral fixtures |
| §16 发布要求 | ADR-003 | — | AWI-017 | 清单文档 |

## Testing Guidance

- 纯逻辑 → 单测（renderer、检测、lock 校验）。
- 契约边界 → 单测 + process-level parity（Runtime source/dist vs public CLI；后续 adapter 另行对照）。
- 跨模块流 → 集成测试（CLI request→Context/admission→Receipt/Gate/Review）。
- 宿主交互 → 真实加载冒烟 + hook 触发测试（HP-003）。
- 手工证据仅在自动化不合理时使用，且需精确步骤（如 token 测量说明）。

## Gate

- [x] 每个 must-have PRD 需求映射到至少一个 AWI（Traceability 全行覆盖）
- [x] 每个 AWI 有 definition of done
- [x] 每个 AWI 有 acceptance evidence
- [x] 基础工作项（AWI-001..004）不与功能切片混合
- [x] 没有只写 "implement X" 的工作项（全部有文件/模块与验收）
