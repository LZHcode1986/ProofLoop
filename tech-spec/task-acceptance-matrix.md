# Architecture Work Item Matrix — ProofLoop v2 通用 CLI（OpenCode Plugin 已退役）

> AWI-* 是项目级工作单元（非 Stage Task / Worker Task）。旧 Plugin/Host 规划（AWI-001..024）已归档；当前可执行范围从 AWI-025 开始。
> 本矩阵只索引当前 AWI、依赖和 Authority References；详细产品验收回到 `PRD.md`，技术 seam/verification 回到 architecture/Contract，禁止捷径和残余风险回到 Hard Parts。Historical 行保留用于迁移审计，不作为 Stage Task 的第二事实源。

## Dependency Groups
1. **当前整改（Phase 1 串行）**：AWI-025..031（测试基线自包含 → kernel binding contract → Manifest/Compiler binding 输出 → serial currentness → replan 端到端 → 流程执行问题整改 → candidate binding mode 传播）
2. **当前分级 Replan epoch 与永久 slice-local CV**：AWI-032..034（影响判定与 epoch authority → Evidence rotation → current epoch downstream/CV/Gate/Review）

## Matrix

| Work Item ID | Architecture Work Item | Depends on | Files/modules | Definition of done | Test/acceptance evidence | Forbidden shortcuts |
|---|---|---|---|---|---|---|
| AWI-001..024 | Historical Plugin/Host foundation and CLI cutover work | — | Historical paths and adapters | Archived on 2026-08-14 after Plugin retirement; these items do not authorize current Stage work | Historical receipts/acceptance only; current CLI behavior is covered by AWI-025..034 and Runtime tests | Do not recreate Plugin package, Host tools/hooks, or old cutover path |
| AWI-025 | 测试基线自包含与隔离（Task 0） | — | `packages/runtime/test/` 与 vNext/CLI 测试 fixture、临时 HOME/配置目录隔离 | fresh clone（无本地 `.proofloop`）后 Node 25 内置 `node:test` 测试通过；测试不写项目配置 | fresh clone 冒烟、`node --test` 通过、配置无污染断言 | 把 `.proofloop` 加进 git；继续依赖本地遗留文件；跳过失败测试（HP-019） |
| AWI-026 | Kernel binding contract（Task A） | AWI-025 | `packages/kernel/src/vnext/bindings.ts`（新增）、`types.ts`、`manifest.ts`、`index.ts` | 三级指纹 canonical projection + digest + closed validators；唯一 oracle；单测全绿 | bindings.spec.ts：只改 C 不影响 A/B/stage 契约；畸形输入 fail-closed | 复制 hash 逻辑；非 canonical 投影；宽松校验（HP-016 前置） |
| AWI-027 | Manifest/Compiler binding 输出（Task B） | AWI-026 | `packages/runtime/src/vnext/compiler.ts`、kernel manifest validator | compile 输出 `binding{version:1,mode:"slice-local",stage_contract_digest}` + 每 slice `slice_contract_digest`；旧 Manifest（无 binding）仍可读取 | compile 输出断言 + legacy manifest 兼容测试 + 畸形 binding fail-closed | 输出非 closed 字段；破坏旧 manifest 读取 |
| AWI-028 | Serial currentness 消费（Task C） | AWI-027 | `packages/runtime/src/vnext/binding-currentness.ts`（新增）、`next.ts`、`validate-vnext-stage.ts` | next.ts 约 20 处整本 digest 绑定改 slice 级 currentness（legacy 路径不动）；validate 对已受理且 current 的 Slice 豁免（FR-023）；单 active Slice 不变 | Case 1/2/5 currentness 单测 + legacy 回归全绿 + 改造点清单 | 漏改绑定点；legacy 路径行为漂移；豁免写成无条件（HP-016） |
| AWI-029 | REPLAN 端到端 fixture（Task D） | AWI-028 | fixture 测试集（A/B 完成、C replan）、refresh-vnext-slice-evidence 接入、admission 消费 binding、凭证 v3 判别 | A/B 集成完成、C replan → refresh C evidence → fresh SPV → 新 admission → A/B current、C 重跑；凭证 schema_version 3 判别与 fail-closed；Case 6 回归 | Case 1-5 端到端 fixture + Case 6 回归 + v3 混链拒绝测试 | 手工改 evidence 绑定；复用旧 SPV/admission；跳过 refresh；无条件豁免（HP-017/018） |
| AWI-030 | 流程执行问题整改（FR-021/022/024） | AWI-028（FR-021 验收依赖） | worker 派发模板、admission 错误信息、proofloop-plan/execute 技能、brain-workflow、纪律对照表文档 | FR-021：replan 后已受理 Slice 状态由 Receipt 推导不丢；materialize 禁令入技能；FR-022：模板固化 Evidence 标题规则 + 受理错误明确提示；FR-024：13 条历史编号逐条映射到防复发机制与固化位置；映射不等于机制已验证，状态由各落点与 Gate 记录 | FR-021/022 验收测试 + 对照表逐条审计（Stage Review 可审计） | 只写文档不验证；对照表无落点；纪律仅口号 |
| AWI-031 | Candidate binding mode 传播与 S13 首用前置 | AWI-027/030 | active candidate schema/materializer、`packages/runtime/src/vnext/candidate-input.ts`、public `plan compile` adapter、source/dist/CLI parity tests | candidate input 明确传 `binding_mode: "slice-local"` 时，真实 `plan materialize` → `plan compile` 输出 slice-local Manifest 与每 Slice binding；缺省保持 legacy；未知值、类型错误或字段静默丢弃均 fail-closed；S12 历史证据不迁移 | candidate contract/materializer test + candidate adapter/compiler test + built public CLI E2E；三分支（slice-local/legacy/unknown）均有证据 | 直接调用内部 Compiler；把未知值降级 legacy；只改 fixture 不改 public path；用 progress/叙事声明模式 |
| AWI-032 | 分级 Replan impact classifier 与 epoch authority | AWI-028/030/031 | `packages/runtime/src/vnext/replan-impact.ts`、`replan-epoch.ts`、现有 `plan admit-spv` / `admit-stage-plan` seams、Runtime epoch schema/reader | Runtime 从 current 与候选 Manifest 的 Task contract/依赖闭包机械判定 `task-local` / `slice-wide`；生成 parent-bound disposition/epoch preparation fact；不接受 caller 派生集合；旧 Receipt write-once、initial/legacy 零行为变化；public operation set 不增加 | Task-local/Slice-wide/unresolved/parent-mismatch 单测；epoch/disposition digest/parent-chain/readback；source/dist/public CLI parity；legacy/initial 回归；伪造 disposition no-write；跨 Stage/path epoch 拒绝 | 新增 public CLI；把逻辑放入 Materializer；Agent 自报影响；覆盖旧 Receipt；mutable current pointer；新 Stage 逃避 Replan（HP-021） |
| AWI-033 | Runtime Evidence rotation 与 mutable projection 恢复 | AWI-032 | `packages/runtime/src/vnext/evidence-refresh.ts`、`evidence-rotation.ts`、`packages/runtime/src/cli/refresh-vnext-slice-evidence.ts`、Evidence history、bounded mutable projection writer、transaction journal/restart tests | 现有 `plan refresh-evidence(mode=replan)` 在 post-admission 安全归档旧 Evidence、生成当前 canonical skeleton，并只恢复 carry-forward Task projection；Runtime 派生 disposition；root/identity/CAS/journal/rollback/restart 完整；旧 Evidence/Receipt 不覆盖或删除 | pristine/non-pristine、symlink、identity mismatch、competitor、interruption/restart、历史归档 digest、carry-forward/current Task 对照；closed request/result；built CLI process E2E；rotation 中断后 zero-write/rollback | 手工 Evidence/header；覆盖 non-pristine；把旧 Evidence 当当前；扩大 mutable scope；caller 提供派生集合；无 journal 的多文件写（HP-021） |
| AWI-034 | Current epoch downstream、永久 slice-local CV v3 route 与 Gate/Review/Close | AWI-032/033 | `packages/runtime/src/vnext/next.ts`、`cv-admission.ts`、`cv-validation.ts`、Worker/CV/Commit/Integration consumers、`packages/runtime/src/cli/proofloop-stage.ts`、Gate/Review/Stage Close admission、S13 E2E fixture | next/所有下游 admission/Gate/Review/Close 只消费 current epoch；旧 Gate/Review 不复用；nested `CV_RESULT` v3 只有在 CV Evidence gate 的 Context/observation handoff 已闭合时，才可经过 outer CLI schema 2 的 public `stage admit-cv` route、shared validator、Stage/path oracle 后受理；当前源码的 `RUN_CV` 不返回 `task_id`/Worker tip，`stage admit-cv` 不消费 observation，故当前 route 未闭合，不能宣称已有完整 executable `PASS` 链 | S13 T01/T02 full built CLI chain；v2/v3 mode matrix；old Gate/Review refusal；Task-local/Slice-wide currentness；Stage/path/Worker-tip/three-digest mismatch zero-write；current HEAD/clean boundary/fresh SPV；legacy v1/v2 isolation；Gate→Review→Close restart/parity | 用 progress/checkbox；复用旧 Gate/Review；把 Worker patch 伪装 carry-forward；直接注入 Manifest/CV fixture 或调用内部 consumer；把外层 CLI schema 改为 3；跳过 public CV route（HP-022）

## Historical Plugin/Host retirement (2026-08-14)

> OpenCode Plugin、Host tools/hooks 与旧切换路径已退役。AWI-001..024 仅保留为历史审计标识，不是当前 Stage Task、执行授权或回退路径。

> 当前机械能力由 public `proofloop <domain> <operation>`、kernel/runtime、Agent 权限配置和 AWI-025..034 承载；字段/状态语义以 Contract 为准，步骤以 Skill 为准，packet/schema 以 Template 为准。
## Historical AWI-018..024 entities

> Stable markers below are retained for audit/reference only. They do not authorize current execution; current work is AWI-025..034.
### AWI-018 goal
<!-- proofloop:entity id="AWI-018" kind="goal" -->
Historical AWI-018 的语义：v1/vNext consumer 之间显式分流；candidate Plan 是可审查的候选投影，不能单独授权执行。Authority refs：`PRD.md` FR-002/FR-017、当前 Contract/architecture seam。

### AWI-019 goal
<!-- proofloop:entity id="AWI-019" kind="goal" -->
Runtime 必须以 fresh SPV 和完整 Stage/Manifest/Plan/snapshot digest 绑定建立唯一 Stage Plan admission authority，并保持 Receipt write-once。Authority refs：`PRD.md` FR-002/FR-017/FR-018、S08-B oracle/seam/risk/acceptance。

### AWI-020 goal
<!-- proofloop:entity id="AWI-020" kind="goal" -->
Runtime 必须从 admitted 持久事实投影唯一 next action 和最小 root/digest-bound Context，缺失或 stale binding 时不得 dispatch Worker。Authority refs：`PRD.md` FR-003/FR-011/FR-016/FR-017、S08-C oracle/seam/risk/acceptance。

### AWI-021 goal
<!-- proofloop:entity id="AWI-021" kind="goal" -->
Historical AWI-021 的语义：统一 adversarial-first CV、入口级 parity、安全边界和恢复约束，旧切换 Gate 仅作为审计背景，不提供回退入口。Authority refs：`PRD.md` FR-004/FR-014/FR-015/FR-016/FR-018、当前 Contract/architecture seam。

### AWI-022 goal
<!-- proofloop:entity id="AWI-022" kind="goal" -->
S08 作为正式 execution Stage 时，admitted Stage Plan 必须能够沿 persisted vNext facts 完成 Worker、CV、Slice Commit、Integration、Stage Gate 和 Stage Review；planning 的 clean Git boundary 与 execution 期 scope-bound dirty diff 必须是两个明确边界。Authority refs：`PRD.md` FR-003/FR-004/FR-011/FR-014/FR-015/FR-016/FR-017/FR-018、S08-E oracle/seam/risk/acceptance。

### AWI-023 goal
<!-- proofloop:entity id="AWI-023" kind="goal" -->
Historical/open AWI-023 的语义：曾规划建立不依赖 harness tool API 的 ProofLoop v2 通用 CLI，使用同一 command/schema 覆盖机械流程，并根据阶段和角色投影不同 Context、验证并保存 closed AI 结果、在转换前检查制品和从本地事实恢复。S09 bootstrap 后 S10 以该 CLI 自举是历史目标，不是当前执行前置；当前 public CLI contract 与 Runtime facts 以 §0/§5.2 及现行源码为准。Plugin 已退役，不创建后置实现或 Host tool fallback。旧 v1 stage CLI/legacy CV 清理仅作历史记录；S08-REVIEW-010 单独排期。Authority refs：`PRD.md` FR-002..006/FR-010/FR-014/FR-016..019、S10 CLI oracle/seam/acceptance、HP-004/HP-010/HP-011/HP-014/HP-015、S08-D/E risk。

### AWI-024 goal
<!-- proofloop:entity id="AWI-024" kind="goal" -->
Historical/open AWI-024 的语义：曾规划在 S10 final Plan boundary 前补齐 executable Runtime Proof candidate contract 与 Runtime-owned pristine Evidence refresh，并统一 candidate/compiler/dispatch/Gate schema、由 Runtime 计算 proof digest；Manifest 变化时仅允许安全 Evidence rotation。当前 active candidate/compile 不接受/生成 `runtime_proof`，Gate 不执行或绑定它，故该目标未作为当前 Stage 前置或完成事实。Stage ID grammar 仍由现行 Runtime/Contract 约束；旧 `S08B0`/`S08B` 仅作历史导航。Authority refs：`PRD.md` FR-014/FR-016/FR-019、S09 bootstrap oracle/seam/acceptance、HP-012/HP-015。

## Historical S08/S09/S10 acceptance entities

### S08-A acceptance
<!-- proofloop:entity id="PLUGINV2-S08-A-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-018。
- Acceptance：对 plan/stage/review 的 v1/v2 paired fixture，显式 schema/version 选择互斥
  consumer；v2 不回退 v1；未知、跨版本、path 不可信输入返回 bounded Finding，且不写执行权威。
- Required evidence（历史）：真实 Runtime CLI/source/dist route matrix、failure projection 和 no-silent-fallback regression；不接受 checkbox、progress 或 narrative 作为结果。

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
- Acceptance：合法 admitted state 的 public `proofloop stage next` 只返回一个 Runtime-derived
  Primary Next Action 和 digest-bound ContextRef；Context 包含最小 refs/skills/Evidence 和
  admitted Plan 的 execution scope。implement Task 必须同时有非空 code/test scope；只含
  Evidence、缺失、越界、篡改或 digest 不一致时不产生 Worker dispatch。
- Required evidence：next/context structured projection、scope source/digest binding、
  root/scope checks、missing-scope/ evidence-only negative cases、restart recovery 和
  bounded `VALIDATE` cases。

### S08-D acceptance
<!-- proofloop:entity id="PLUGINV2-S08-D-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-021。
- Acceptance：同一 v1/v2 fixture 在 Runtime source/dist、public Runtime CLI 和真实 filesystem/Git 边界的 action/Finding/digest/fail-closed 结果一致；path escape、symlink、TOCTOU、stale snapshot 和 unadmitted next 均不能产生执行 authority。
- Required evidence：入口级 parity、digest comparison、真实 path/security 反例和重启恢复
  记录；不接受内部函数或 mock 代替 public seam。

### S08-E acceptance
<!-- proofloop:entity id="PLUGINV2-S08-E-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-022。
- Acceptance：在当前 Manifest/Plan/Stage Plan admission 下，Worker Result 能进入 vNext
  CV；CV PASS/REPAIR、Slice Commit、Integration、Stage Gate 和 Stage Review 均有显式
  Runtime consumer、Receipt schema 和 Manifest/snapshot binding。Worker 产生的 scope 内 dirty diff 不得被 planning clean gate 误判为 stale；scope 外、旧 snapshot、旧 Context、v1 Receipt 或未 admission 的结果必须 fail closed。
- Required evidence：真实 Runtime/CLI action matrix、Worker→CV→Commit→Integration→Gate→Review end-to-end fixture、dirty execution boundary、recovery/recheck、v1/vNext isolation、Receipt digest/readback 和 no-silent-fallback regression。

### S09 executable Runtime Proof bootstrap acceptance（Historical/open；稳定 entity id 保留历史 `S08B0` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B0-BOOTSTRAP-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-024。
- Status：Historical/open；AWI-024 及以下 S09 acceptance 仅保留稳定引用导航，不授予当前 Stage admission 或执行权。
- Acceptance A（历史目标）：若未来重新立项，才验证 executable step schema、unknown/type/args/cwd/timeout 及 caller digest 的 fail-closed；Runtime-owned digest 必须由同一明确 producer/consumer contract 产生。
- Acceptance B（当前独立 Evidence contract）：现行 `plan refresh-evidence` 的安全 rotation 按 §5.3 后续 contract 执行；它不证明 executable Runtime Proof 已存在，也不把历史 `runtime_proof` 写回 active Manifest。
- Acceptance C（历史目标）：S09 一次性 all-skipped `not_applicable` 不能计入 AWI-023、项目验收或当前 Gate/Review；当前没有 restricted bootstrap admission 可供宣称完成。
- Current code fact：active candidate/materializer 不接受 `runtime_proof`，`plan compile` 不生成该字段；Gate 不执行 Manifest `runtime_proof`，也不绑定 `runtime_proof_digest`。
- Required evidence（未来重新立项时）：source + built process 的 PASS/FAIL、schema/digest negative matrix、producer/dispatch/Gate process evidence、Evidence rotation/restart matrix 与 Stage ID fail-closed；当前不得把缺失的证据改写为完成。

### S10 harness-neutral CLI/self-host acceptance（Historical/open；稳定 entity id 保留历史 `S08B` 名称）
<!-- proofloop:entity id="PLUGINV2-S08B-CLI-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-023。
- Acceptance A（stable public seam）：真实 built `proofloop <domain> <operation>` 提供统一
  request-file/JSON input、canonical JSON envelope、closed operation、root assertion、ref+digest
  和 exit contract；unknown domain/op 在任何写入前 fail closed。Runtime package 不依赖任何
  harness SDK；现有单用途 scripts 不是公共合同。
- Acceptance B（Authority/Plan/Context）：CLI 能检查所选 Authority refs、保存 closed AI plan
  input/candidate、compile/validate/initialize/refresh/admit Plan，并为 Planning、SPV、Worker、initial
  CV、CV recheck、Stage Reviewer、Project Reviewer 生成各自不同且 digest-bound
  的 Context；initial CV Evidence read gate 保持有效。
- Acceptance C（execution persistence）：Worker/CV/Slice Commit/Integration/Gate 的 structured
  result 只能经 CLI→Runtime public admission 保存；每次重验 Context/scope/snapshot/changed
  files/前序 Receipt，成功返回 Receipt ref+digest，非法/stale/cross-version/root escape/
  duplicate/broken chain 均 canonical Finding + no-write。
- Acceptance D（Review/Project/Doctor）：Stage Review prepare/finalize、Project Acceptance
  compile/run-e2e/prepare/finalize/status 与 doctor/recovery 均可从同一
  public CLI 调用，不依赖已退役 Host tools；Project/Stage verdict 仍由 AI Reviewer 提供，CLI 不替代判断。
- Acceptance E（Historical/open）：S09 executable proof bootstrap、S10 Manifest proof step 与完整 self-host/Gate/E2E process 是历史目标，不是当前 admission 前置；当前 candidate/compile 不接受/生成 `runtime_proof`，Gate 仅校验集成事实且不绑定 `runtime_proof_digest`。若未来恢复，必须用真实 built public CLI、角色 Context、重启和跨 harness fixture 重新验收。
- Acceptance F（Historical cutover）：A–E 曾用于确认旧 v1 consumer/Host 权限清理；当前 Plugin 已退役，旧 artifact 仅显式检测并 fail closed，不创建回退入口。
- Required evidence（当前 CLI contract）：真实 CLI process stdout/exit/canonical envelope、各角色 Context、Receipt/Context digest/no-write readback、restart fixture、harness-neutral caller fixture 与 build/Runtime tests；当前不要求或声称 Runtime Proof step/Gate execution 已存在，完整 Gate/E2E 仍 open。
- Acceptance evidence note（2026-08-14 历史裁决）：受限关闭可使用显式 `git_facts` Gate（`verification_source: git_facts`、absence-gated、事实可审计），但这不产生 executable Runtime Proof 证据；正常 Stage 仍须以当前 Contract 的 Gate/Review 事实和 fresh evidence 为准，不能用旧 Receipt 或 all-skipped proof 代替。
- Out of scope（Historical/open）：S08-REVIEW-010 的 Runtime Proof、Manifest/Gate/Review 重验不得混入当前 S10；若恢复必须先重新确认 current contract。

## Historical S08/S09/S10 authority traceability

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
| FR-002 plan | §6 plan flow | §0/§5.2/§5.3 | AWI-018/019/024（历史） | plan/admission/refresh parity |
| FR-003 stage | §6 next/admit/gate flow | §0/§5.1/§5.2 | AWI-020/022/023（历史） | next/context/admission parity |
| FR-004 review | §6 review flow | §0/§5.1/§5.2 | AWI-022/023（历史） | parity |
| FR-005 project | §6 project / CLI flow | §0/§5.2 | AWI-023（历史） | CLI process + project parity |
| FR-006 doctor | §6 CLI/doctor | §0 doctor | AWI-023（历史） | CLI structured diagnostics |
| FR-007 角色隔离 | ADR-005/§4 | §0 role Context + §5 scope | AWI-011（历史） | Agent/CLI role matrix |
| FR-008..011 hooks | 历史 Host hooks 方案 | §0/§5 bounded writer 与持久事实 | AWI-012（历史） | Runtime/security regression |
| FR-012 token | ADR-006/§5 | §0 compact budget | AWI-003/016（历史） | 历史 benchmark/预算证据 |
| FR-013 版本锁 | §6 加载 | §3 runtime.lock | AWI-002（历史） | lock 测试 |
| FR-014 parity | §6 / historical S09/S10 CLI flow | §0 + §5.2/§5.3 | AWI-013/021/024/023（历史） | current CLI/source/dist parity；executable Runtime Proof 与完整 harness-neutral process evidence 为 Historical/open |
| FR-015 git workflow | §6 | §5 | AWI-014（历史） | Gate Receipt PASS |
| FR-016 恢复 | §6 | §5/§5.3 | AWI-015/024（历史） | 恢复测试 + Evidence refresh transaction/restart |
| FR-017 单一权威与派生投影 | ADR-010/011 | §3/§5.1 | AWI-018/019/020（历史） | invalidation + no-unapproved-dispatch |
| FR-018 Plugin 切换与回退 | 历史 ADR-011/012/015 | §0/§5.1/§5.2 | AWI-021/022/023（历史） | 历史 cutover/recovery/fail-closed tests |
| FR-019 harness-neutral CLI/self-host | ADR-015..018 + historical S09/S10 flow/oracle | §0 + §5.2/§5.3 | AWI-023/024（历史） | public CLI contract current；S10 self-host、executable proof bootstrap、Gate/E2E 与 restart/harness-neutral full-chain evidence 为 open |
| §16 发布要求 | ADR-003 | — | AWI-017（历史） | 历史清单文档 |

## Testing Guidance

- 纯逻辑 → 单测（renderer、检测、lock 校验）。
- 契约边界 → 单测 + process-level parity（Runtime source/dist vs public CLI；后续 adapter 另行对照）。
- 跨模块流 → 集成测试（CLI request→Context/admission→Receipt/Gate/Review）。
- 宿主边界 → public CLI process 夹具 + Agent permission/config 断言（已退役 Host adapter 不作为当前证据）。
- 手工证据仅在自动化不合理时使用，且需精确步骤（如 token 测量说明）。

## Gate

- [x] 每个 must-have PRD 需求映射到至少一个 AWI（Traceability 全行覆盖）
- [x] 每个 AWI 有 definition of done
- [x] 每个 AWI 有 acceptance evidence
- [x] 历史 AWI-001..024 与当前 AWI-025..034 分离；历史条目不作为当前 Stage Task 或执行授权
- [x] 没有只写 "implement X" 的工作项（全部有文件/模块与验收）

## 整改 AWI 机器可读实体（2026-08-15）

### AWI-025 goal
<!-- proofloop:entity id="AWI-025" kind="goal" -->
测试基线必须自包含且环境隔离：fresh clone（无本地 `.proofloop`）后 Node 25 内置 `node:test` 测试通过，测试不写项目配置。Authority refs：`PRD.md` FR-020..024、`tech-spec/ai-coding-architecture.md` §10.1、HP-019。

### AWI-026 goal
<!-- proofloop:entity id="AWI-026" kind="goal" -->
Kernel 必须以唯一 canonical oracle 实现三级绑定指纹（stage_contract / slice_contract / execution_binding）及 closed validators，投影为 closed 字段清单。Authority refs：`PRD.md` FR-020、架构 §10.2/§10.7、契约 §8.2、HP-016。

### AWI-027 goal
<!-- proofloop:entity id="AWI-027" kind="goal" -->
Compiler/Manifest 必须在 slice-local 模式输出 `binding{version:1,mode:"slice-local",stage_contract_digest}` 与每 slice `slice_contract_digest`，且 legacy Manifest（无 binding）仍可读取、行为零变化。Authority refs：`PRD.md` FR-020 Case 6、架构 §10.3、契约 §8.1。

### AWI-028 goal
<!-- proofloop:entity id="AWI-028" kind="goal" -->
Runtime 必须以 slice 级 currentness 消费历史 Slice 证明（legacy 路径不动）：已集成且契约未变、依赖绑定仍 current 的 Slice 不因整本 plan/manifest digest 变化而失效；validate 对已受理且 current 的 Slice 豁免绑定校验。Authority refs：`PRD.md` FR-020 Case 1/2/3/5、FR-023、架构 §10.5/§10.6、契约 §8.4/§8.5/§8.6、HP-016。

### AWI-029 goal
<!-- proofloop:entity id="AWI-029" kind="goal" -->
REPLAN 端到端必须闭环：A/B 集成完成、C replan 后，refresh C evidence → fresh SPV → 新 admission → A/B 保持 current、C 单独重跑；凭证 schema_version 3 判别 fail-closed（不得混链）；旧模式 Case 6 零变化。Authority refs：`PRD.md` FR-020 全部验收、FR-023、架构 §10.4/§10.5、契约 §8.3/§8.6、HP-017/HP-018。

### AWI-030 goal
<!-- proofloop:entity id="AWI-030" kind="goal" -->
流程执行问题整改需建立可审计映射：replan 后已受理 Slice 状态由 Receipt 推导不丢（FR-021）；Evidence 标题规则固化到 Worker 派发模板且受理错误明确提示（FR-022）；13 条历史编号逐条映射到防复发机制与固化位置（FR-024）。映射不等于全部机制已验证，状态以各落点和 Gate 事实为准。Authority refs：`PRD.md` FR-021/022/024、架构 §10.8、HP-016 相关。

### AWI-031 goal
<!-- proofloop:entity id="AWI-031" kind="goal" -->
Candidate planning 的 binding mode 必须从 `candidate-input.json` 经 active Materializer 与 Runtime candidate adapter 完整传递到 public `plan compile`：`binding_mode: "slice-local"` 输出 slice-local Manifest 与三层绑定，缺省保持 legacy，未知值和静默丢弃 fail-closed。Authority refs：架构 §10.3/§10.9/§10.10、契约 §8.1/§8.1.1、HP-020。

### AWI-032 goal
<!-- proofloop:entity id="AWI-032" kind="goal" -->
Runtime 必须在不新增 public CLI/operation、且不扩大 Materializer 职责的前提下，从 current 与候选
Manifest 的 Task contract/依赖闭包机械判定 `task-local` / `slice-wide` Replan，建立 parent-bound
append-only epoch authority；此前边界未变的 `TASK_COMPLETE` 可继承，当前/受影响 Task 不得继承，
无法判定必须 fail-closed。Authority refs：`PRD.md` FR-016/017/020/021 Case 8/9、架构 §10.10、
契约 §0.3/§4/§8.8、HP-021、`PLUGINV2-REPLAN-EPOCH-CONTRACT-SEAM`。

### AWI-033 goal
<!-- proofloop:entity id="AWI-033" kind="goal" -->
Runtime 必须通过既有 `plan refresh-evidence(mode=replan)` 完成 post-admission Evidence 安全轮换：
旧 Evidence 归档、当前 canonical path 生成新 skeleton、carry-forward Task projection bounded 恢复，
并以 root-bound identity/CAS/journal/restart 保障不覆盖历史事实、不报告部分成功。Authority refs：
`PRD.md` FR-016/017/021、架构 §10.10、契约 §3/§4/§5.3/§8.8、HP-021、
`PLUGINV2-REPLAN-ROTATION-CONTRACT-SEAM`、`PLUGINV2-REPLAN-ROTATION-ORACLE`。

### AWI-034 goal
<!-- proofloop:entity id="AWI-034" kind="goal" -->
所有 current epoch downstream consumer、Stage Gate、Stage Review 和 Stage Close 必须只消费最新
epoch；旧 Gate/Review 不复用；S13 的 public CV route 必须走 candidate → Materializer → public
compile → admission 的真实链，完成当前 Task/继承未受影响 Task 后可达 Gate PASS → Review ACCEPTED
→ Close。Authority refs：`PRD.md` FR-016/017/020/021、架构 §10.4/§10.6/§10.7/§10.10、契约 §0.3/§8.3/§8.6/§8.7/§8.8、HP-021/HP-022、
`PLUGINV2-SLICE-LOCAL-CV-SEAM`、`PLUGINV2-SLICE-LOCAL-CV-ORACLE`、
`PLUGINV2-SLICE-LOCAL-CV-CONTRACT-SEAM`、`PLUGINV2-SLICE-LOCAL-CV-CONTRACT-ORACLE`。

### S12 binding acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-BINDING-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-026/027。
- Acceptance：三级指纹 canonical projection 为 closed 字段；只改 Slice C 时 A/B 与 stage 契约不变；binding 字段未知/缺失/畸形 fail-closed；legacy Manifest（无 binding）可读且行为零变化。
- Required evidence：bindings.spec（隔离性 + 畸形输入）+ compiler 输出断言 + legacy 兼容回归；不接受手工构造 digest。

### S12 currentness acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-CURRENTNESS-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-028。
- Acceptance：已集成且 current 的 Slice 不因整本 plan/manifest digest 变化失效（Case 1/2/5）；validate 豁免仅限"已受理且 current"；legacy 路径行为零变化；单 active Slice 语义不变。
- Required evidence：Case 1/2/5 currentness 单测 + legacy 全量回归 + 改造点清单核对。

### S12 replan acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-REPLAN-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-029。
- Acceptance：A/B 集成完成、C replan → A/B current、C 重跑；凭证 schema_version 3 进入 v2 消费端 fail-closed；同一 Stage 混用两种模式凭证被拒；Case 6（旧模式）回归零变化。
- Required evidence：端到端 fixture（Case 1-5）+ 回归（Case 6）+ v3 混链拒绝测试。

### S12 process-fix acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-PROCESS-FIX-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-030。
- Acceptance：FR-021（replan 后已受理 Slice 状态不丢）、FR-022（Evidence 标题规则 + 明确错误提示）、FR-024（13 条历史编号逐条映射到防复发机制与固化位置，并分别标注验证状态）；对照表随流程文档可审计。
- Required evidence：FR-021/022 验收测试 + 对照表文档评审（Stage Review）。

### S13 binding-mode acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S13-BINDING-MODE-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-031。
- Acceptance：真实 candidate input → Materializer → Runtime adapter → public `plan compile` 路径保留 `binding_mode: "slice-local"`，产出 Manifest `binding.mode: "slice-local"` 与每 Slice `slice_contract_digest`；缺省 input 维持 legacy；未知/类型错误/静默丢弃 fail-closed；S12 legacy 历史证据不被迁移或覆盖。
- Required evidence：active Materializer contract/schema 测试、candidate adapter/compiler 测试、built public CLI 三分支 E2E（slice-local / legacy / unknown），不接受只调用内部 Compiler 的 fixture。

### Replan epoch acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-REPLAN-EPOCH-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-032。
- Acceptance：不增加 public CLI/operation；Runtime 对前后 Task contract/依赖闭包稳定地产生
  `task-local` / `slice-wide` disposition 与 parent-bound epoch；此前边界未变的 `TASK_COMPLETE`
  可继承，当前/受影响 Task 不继承；unresolved、parent mismatch、caller 伪造派生集合均
  fail-closed；旧 Receipt 与 initial/legacy 路径零变化。
- Required evidence：source/dist/public CLI parity、Task-local/Slice-wide/unresolved/parent-mismatch
  matrix、epoch digest/parent-chain readback、旧 Receipt 不覆盖、legacy/initial regression。

### Replan Evidence acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-REPLAN-EVIDENCE-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-033。
- Acceptance：`plan refresh-evidence(mode=replan)` 在 post-admission 只由 Runtime 执行；旧 Evidence
  归档至 epoch history，当前 canonical path 生成新 skeleton；carry-forward Task 的内容与 bounded
  projection 保持，当前/invalidated Task 不复用；non-pristine、identity、symlink、竞态、中断和
  journal recovery 均 fail-closed/no-partial-success。
- Required evidence：Evidence history digest、rotation 正向/失败/中断重启、CAS/identity/symlink
  matrix、Runtime 派生 disposition closed result、carry-forward/current Task 对照、built CLI E2E；
  不得手工改 header、提供派生集合或覆盖旧 Evidence。

### Current epoch downstream acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-REPLAN-CURRENT-EPOCH-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-034。
- Acceptance（目标链，当前未闭合）：`next`、Worker/CV/Commit/Integration、Gate、Review、Close 只消费最新 epoch；旧 Gate/Review 拒绝复用；S13 T01/T02 目标为 candidate → Materializer → public compile → public CV route → current epoch Gate PASS → Review ACCEPTED → Close。源码事实是 `RUN_CV` 不返回 `task_id`/Worker tip，`stage admit-cv` 不消费 observation，因此 current CV Evidence-gated route 未闭合，不能把 direct credential/admission 或 fixture 记为 executable `PASS`；旧模式、stale HEAD、dirty boundary、legacy/vNext 混链仍须 fail-closed。
- Required evidence：真实 built CLI full chain、current HEAD/clean boundary/fresh SPV、old Gate/Review
  refusal、Task-local/Slice-wide、restart/parity、legacy isolation 与 Stage Close receipts。

### Slice-local CV acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-SLICE-LOCAL-CV-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-034。
- Acceptance（前置 CV Evidence gate route，当前未闭合）：outer CLI result envelope 保持 schema 2；nested `CV_RESULT` 在 slice-local Manifest 使用 schema 3 + 三个 binding digests，经 `proofloop-stage.ts` → shared validator → vNext CV consumer 真实 public route 受理；legacy/v2 零行为变化；Stage/path-bound current epoch、Worker tip、Context、Proof Index、snapshot 和 Receipt chain 全部匹配。源码中 `RUN_CV` 不返回 `task_id`/Worker tip，`stage admit-cv` 不消费 observation，因此不能把当前 credential/admission 写成 executable `PASS` chain。
- Required evidence：built/source/public parity；v3 正向；v3→legacy、v2→slice-local、其他 Stage
  epoch、过期 Worker tip、digest mismatch、mixed-mode、重复 Receipt 的 zero-write；独立 CV
  refutation observation 不得被 Worker Evidence 替代；restart reader 与 legacy regression。

## 整改 Traceability（FR-016..024 → AWI）

| PRD 需求 | 架构 | 契约 | AWI | 验收证据 |
|---|---|---|---|---|
| FR-020 slice 绑定 | 架构 §10.2/10.3/10.5/10.10 | 契约 §8.1/8.2/8.6/8.8 | AWI-026..034 | Case 1-9 fixture + bindings.spec + epoch matrix |
| S13 首用模式传播 | 架构 §10.3/10.9/10.10 | 契约 §8.1.1 | AWI-031 | candidate → Materializer → adapter → public compile 三分支 E2E |
| FR-021 replan 保留状态 | 架构 §10.5/10.8/10.10 | 契约 §5.3/§8.5/§8.8 | AWI-028/030/032..034 | Task carry-forward、Evidence rotation、投影恢复与 current epoch 测试 |
| 永久 slice-local CV v3 route | 架构 §10.4/§10.6/§10.7/ADR-026 | 契约 §0.3/§4/§8.3/§8.4/§8.8 | AWI-034 | outer schema 2 + nested v3 public route、Stage/path oracle、source/dist/public parity、legacy/mixed-mode zero-write |
| FR-022 Evidence 规则 | 架构 §10.8 | 契约 §8.4 | AWI-030 | 模板 + 错误提示测试 |
| FR-023 validate 豁免 | 架构 §10.6/10.10 | 契约 §8.4/8.6/8.8 | AWI-028/029/034 | 豁免 + refresh/rotation + current epoch 路径测试 |
| FR-024 纪律防复发 | 架构 §10.8 | — | AWI-025/030 | 对照表 + 回归 |
| FR-016/017 会话恢复与单一权威 | 架构 §10.10 | 契约 §4/§5.3/§8.8 | AWI-032..034 | epoch parent-chain、Evidence rotation、current epoch restart/parity |
| FR-020/021 Task-local / Slice-wide Replan | 架构 §10.5/§10.6/§10.10 | 契约 §8.5/§8.6/§8.8 | AWI-032..034 | Case 8/9、carry-forward、当前 Task 失效、Gate/Review/Close |

## Gate（整改增补）

- [x] 每个整改 PRD 需求（FR-020..024）映射到至少一个 AWI（Traceability 全行覆盖）
- [x] 每个整改 AWI 有 definition of done / acceptance evidence / forbidden shortcuts
- [x] 基础工作项（AWI-025/026）不与功能切片混合
- [x] 依赖顺序正确：AWI-025（HP-019）→ 026 → 027 → 028 → 029；AWI-030 的 FR-021 验收依赖 AWI-028，AWI-031 依赖 AWI-027/030；AWI-032 → 033 → 034 且均依赖现有 currentness/binding 基础
- [x] 机器可读 goal/acceptance entities 已登记 marker（AWI-025..034 goal、PLUGINV2-S12-* / PLUGINV2-S13-* / PLUGINV2-REPLAN-* / PLUGINV2-SLICE-LOCAL-CV-* acceptance）

### S12 test-baseline acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-TEST-BASELINE-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-025。
- Acceptance：fresh clone（无本地 `.proofloop` 遗留文件）后全量测试绿；测试不写项目真实配置；`.proofloop/**` 保持 gitignore，不加入 git。
- Required evidence：fresh clone 冒烟、Node 25 内置 `node:test` 通过 + 配置无污染断言。

### S12 schema-v3 acceptance（stable entity id retains `PLUGINV2-...`）
<!-- proofloop:entity id="PLUGINV2-S12-SCHEMA-V3-ACCEPTANCE" kind="acceptance" -->
- AWI：AWI-028（receipt payload binding 字段）/ AWI-029（v3 判别与混链拒绝）。
- Acceptance：slice-local 模式 receipt payload 携带 binding 三字段（stage/slice/execution binding digest 必填校验）；schema_version 3 判别——v2 消费端遇 3 显式 fail-closed（BINDING.SCHEMA_FUTURE）；同一 Stage 混用两种模式凭证被拒（BINDING.MODE_MIXED）；legacy 对 ≠1 整链阻塞保持；共享 CV 校验器接受 v3 且不产生第二套校验逻辑。
- Required evidence：v3 进入 v2 消费端被拒测试；混模式拒绝测试；cv-validation 共享 seam 覆盖 v3 测试；binding 字段缺失/畸形 fail-closed 测试。
