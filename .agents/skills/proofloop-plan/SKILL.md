---
name: proofloop-plan
description: STAGE_PLANNING：唯一 Planning 方法来源；读取四类 canonical Authority 与 current code reality，维护公共 Project Stage Map 并产出 candidate Thin Plan（fresh SPV PLAN_READY 后由 Brain 接纳为 accepted）；提供 Execute 投影所需 planning facts，不拥有 JIT Work Packet schema/projection；SPV 只读 falsify 后收敛为 PLAN_READY|FINDINGS|BLOCKED；Replan 按 carry_forward|invalidated|new/changed 推进。
disable-model-invocation: true
---

# proofloop-plan

本 Skill 是 Planning 的唯一方法来源：维护公共 Project Stage Map（`delivery/project-stage-map.md`）并把 canonical Authority 与当前代码现实翻译成 execution-owned 的 current Stage candidate Thin Plan（Stage → Slice → Task）；Planning 拥有公共 Project Stage Map 与 current Stage Thin Plan，定义 WHAT / WHEN / BOUNDARY；Planner 不拥有 JIT Work Packet schema/projection（JIT Work Packet 是 derived execution input，projection owner 是 Execute / `proofloop-execute`：Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker）；Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body，并决定该 Task 的 HOW。它不产生 Manifest/Evidence、不写 Receipt、不做 Admission，也不调用任何旧 Runtime CLI；计划成为可执行输入的前提是 Brain 采纳 Plan 并路由给 `proofloop-execute`，且 MES integrity hard-freeze 已解除或当前 Plan 明确属于 Authority-defined remediation lane。Brain dispatch 只传 current target/facts/refs/binding 与 mutation boundary，不把 Brain prompt 当第二方法源。旧 Runtime/CLI 与 admission 链已被删除，本 Skill 不再依赖任何 legacy 控制链。

## Phase ownership

- **进入**：四类 canonical Authority（PRD、Architecture、Contracts、Acceptance）已就绪，或上一 Stage `STAGE_ACCEPTED` 后进入下一 Stage Planning，或收到 Brain 仲裁接纳的 Replan 请求；`NORMAL` 要求 Authority + relevant MES/Git facts + Project Stage Map（若已存在），且不存在 S06 MES integrity hard-freeze；`PRE_MES_BOOTSTRAP` 下进入只要求 Authority + current code reality + Git baseline/current facts，不要求 MES 或 accepted Plan；`RECOVERY_REBASELINE` 仅在 `MES_RECOVERY_REQUIRED`、exact pre-image branch 已被 forensic/audit 证伪且 recovery Authority current 时进入，读取 Authority + current code/Git + forensic/audit refs + existing dirty recovery patch，不读取或声称 current NORMAL MES scope/work/result；S06 remediation planning 只能在 Authority-defined maintenance/recovery seam 已 current 后进入，且不写 NORMAL PVR/PA。初始 candidate 创建/revision（含 bootstrap/recovery）与 Replan（需既有 accepted Plan + MES facts）分开判定。
- **Planner action 终点**：Planner 产出/修订 candidate Thin Plan（及按需更新 Project Stage Map）并冻结四项 invariant 后，返回 `CANDIDATE_PLAN_READY` 结束当前 Planner action。Planner 不 dispatch SPV。
- **Phase 完成与接纳**：Planner action 结束后，由 Brain / Contract 负责建立 candidate Git boundary 并调度独立的 `stage-plan-verifier`（SPV）；candidate Thin Plan 经独立 SPV 返回 `PLAN_READY` 后，`NORMAL` 由 Brain 授权 semantic planning event，先经 MES transaction layer materialize `PLANNING_VERIFICATION_RESULT` 再 materialize `PLAN_ACCEPTANCE`（`PRE_MES_BOOTSTRAP` 采纳 Git-tracked Thin Plan）；S06 hard-freeze 下禁止 NORMAL acceptance；`RECOVERY_REBASELINE` 的 `PLAN_READY` 只是 maintenance/recovery evidence，closure 前不写 PVR/PA、不进入 Execute。
- **交接**：accepted Thin Plan 交给 `proofloop-execute`；Brain running `proofloop-execute` 每个 Step 读取完整 accepted Plan、选择当前 dependency-ready Task、并只把该 Task 的 JIT input 投影给同一 Worker；Worker 只执行被投影的 current Task，不自行选择或重排 successor，不接收 future Task body。
- **回退**：Authority 缺口回对应 authority Skill；技术未知回 Researcher/Prototype；SPV finding 经 Brain 仲裁后由本 Skill 修复。

## 加载链与事实源

1. 本 Skill：规划步骤、分支与完成标准。
2. `.agents/skills/proofloop-plan/references/stage-plan-verifier-template.md`：SPV dispatch packet、Result schema 与必要 binding（结果为 `PLAN_READY|FINDINGS|BLOCKED`）；独立审查 procedure（验证顺序、challenge 方法、结果纪律）唯一来源是 `.agents/skills/stage-plan-verifier/SKILL.md`；SPV 作为 `stage-plan-verifier` review-loop Role 经 Herdr Link configured start 启动（role_skill=config_agent=stage-plan-verifier），不复用 Planning 实例。
3. `.agents/contracts/brain/agent-lifecycle.md`：one-shot/continuation/review-loop 生命周期；本 Skill 只引用，不定义。
4. Brain dispatch 指定的 active Authority 稳定 ref：只读取，不复制正文。
5. 条件方法 pointer（branch-only，按需加载）：
   - **Project Stage boundary test**：当 Map absent 需创建首份 Map，或 Map present 发生 material recomposition（Stage 新增、删除、拆分、合并或阶段边界重大调整）时，读取 `.agents/skills/codebase-design/SKILL.md` 的 `Project Stage boundary test`。
   - **Vertical Slice composition（Tracer bullet）**：`COMPOSE SLICES` 每次 fresh 首次形成 Slice topology，或 `DECOMPOSE TASKS BY SLICE` 反向触发 Slice material repartition（新增、删除、拆分、合并、重新划分）时，在冻结 Dependencies 与 execution scope 前读取 `.agents/skills/codebase-design/SKILL.md` 的 `Vertical Slice boundary test`。
   - **Verification seam validity**：当当前 obligation 需要新增 verification/test seam 或 materially 改变已有 seam 时，定向读取 `.agents/skills/test-driven-development/SKILL.md` 的 `What a good test is` / `Seams — where tests go` / `Anti-patterns`，只借「通过什么边界证明」的判断，不承担 Worker 的 RED/GREEN HOW。
   - **Binding closure**：仅当同一 binding-critical 字段、标识、digest、credential 或其他绑定值跨越 producer、validator、persistence、consumer 或 recovery 任一边界传递时，在冻结相关 Task/Dependencies 前读取 `references/transaction-binding-closure.md`。该 reference 只映射当前 Contract/Authority 已有对象和字段；schema/object ownership 继续由原有 authority 定义。

Canonical Authority 只来自四类文件：`PRD.md`、`tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md`。root `CONTEXT.md`、Working Material、旧 Receipt/Manifest/MES 都不是 Product/Technical Authority。Project Stage Map 是 `delivery/project-stage-map.md`，由 Planner 拥有，不属于 MES fact/status，不缓存 operational readiness。Thin Plan 只保存 execution-owned facts，不复制 Authority 正文。

## Authority handoff（PRD → tech-spec，Planner 职责）

Planner 输入仍按 phase 读取 `PRD.md` + tech-spec Pack + current code/MES/Git + current Map；PRD 只用于识别 Product intent 并完成 handoff 验证。candidate Map/Plan 的 downstream `authority_refs` 只指向 Technical Authority Pack（`tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md`）。Planner 对 current Stage 显式完成：
Recovery branch handoff：`RECOVERY_REBASELINE` 的 recovery candidate downstream refs 仍只指向 tech-spec Pack；forensic/audit ref 只作 Brain/Planner/SPV recovery input，不写入 Plan 的 narrative/progress，也不把 frozen MES snapshot 当作已重建 NORMAL planning fact；S06 maintenance candidate 必须以 exact frozen SHA/count、current Authority/Git basis 与独立 seam 语义为输入。

1. 识别 current Stage relevant PRD intent（目标、场景、FR、Scope、Decision ledger）；
2. 在 current tech-spec Pack 中找到其 representation（Architecture / Contracts / Acceptance）；
3. 若 relevant PRD requirement 在 tech-spec 缺失或矛盾，或 Product intent 不变但 bounded current code/runtime reality 证明 current Technical Authority 已不成立/不足且继续 Planning 必须更新 canonical tech-spec，返回 `AUTHORITY_GAP`；不得把 PRD-only requirement 直接塞入 Plan。
4. Map/Plan 的 `authority_refs` 只引用 Architecture / Contracts / Acceptance（tech-spec-only）；
5. Plan 保持 thin：只携带稳定小粒度 tech-spec ref，不复制 tech-spec 正文；
6. accepted Plan 之后 Worker/CV/SR 不再需要 PRD 即可实现/验证。

`AUTHORITY_GAP` 的正式定义是：Planning/SPV 在 Product intent → current Technical Authority → grounded current reality 的 handoff closure 中证明 canonical Technical Authority 缺失、矛盾或已被反证，且合法形成 downstream Plan 需要更新该 Authority。它不是通用“我不确定”：Planner implementation/schema/test choice 走 `PLAN_GAP`，技术可行性/事实未验证走 `TECHNICAL_UNKNOWN`，Authority 已充分而 Runtime 未实现/实现错误走 normal implementation/repair。`PLAN_READY` 的含义仍是 current Stage 之后 downstream（Worker/CV/SR）不需要 PRD 才能实现/验证。

## 规划模型

采用 Rolling-Wave Planning，只对 dependency-ready Stage 做 JIT 详细规划：

```text
Canonical Authority + Project Stage Map
→ MAP CHECK (create if absent / review-revise if present)
→ dependency-ready Stage
→ CURRENT STAGE PLAN (Thin Plan)
→ Execute 拥有 JIT Work Packet projection (Brain running `proofloop-execute` 每个 Step 选择 current Task 并只投影该 Task 的 JIT Read Set 给同一 Worker)
```

**Planning 与 Execute 分工**：
- Planning = WHAT / WHEN / BOUNDARY；
- Execute（`proofloop-execute` + `worker-template`）= accepted Plan + current facts → Slice Work Packet / per-Task JIT Read Set；
- Worker = 被投影 current Task 的 HOW。
- Task 边界：每个 Task 必须自足（local closure / verification closure / future-HOW independence），自然 TDD（RED → 最小实现 → GREEN）属同一 Task 的 HOW，不跨 Task 切碎。
Planner 不拥有 JIT Work Packet schema/projection，只提供 Execute 投影所需的 planning facts。

**Thin Plan** 只包含：Stage/Slice/Task goals、dependencies、semantic scope、code anchors、verification refs、Task 级 `obligation_state`、done/stop conditions、小粒度 tech-spec Authority refs（tech-spec-only）。不承载 Receipt/Gate、不承载 mutable execution state。

**Future Thin Plan shape（只约束 future candidate Plans，不回写已 accepted 的 S01 Plan）**：Task 级只保留 task-specific facts——goals、dependencies、semantic scope、code anchors、task-specific `code_paths`/`test_paths`、verification refs、`obligation_state`、done/stop、required Skills 与 Skill 要求的 Proof Obligation binding；可证明为 Stage/Slice 共享 invariant 的 protected/forbidden scope、机械 metadata 与重复的 Authority refs 提升为共享的 Stage/Slice 默认，不在每个 Task 重复；重复 Authority refs 只收窄为稳定小粒度 ref，不用摘要替代 canonical Authority；candidate Plan 正文不记录 mutable acceptance/progress state（candidate/accepted 状态由 lifecycle/MES/Git facts 持有）。该 shape 是 execution-owned 的 prose/template 指导，不新增第二个 Plan 事实源、不新增 schema/phase/status。

## Planner 职责与 invariant

Planner 基于 canonical Authority 与 current code reality 维护公共 Project Stage Map（`delivery/project-stage-map.md`，缺失时创建，存在时 review/revise），选定 dependency-ready Stage，并生成/修订该 Stage 的 candidate Thin Plan（Stage → Slice → Task）；同时负责 dependencies、scope、verification 安排与 PLAN_GAP 评估，但不得修改 canonical Authority。公共 Map 与 candidate Thin Plan 都是 execution-owned planning input，不是新的 Authority 或 phase。每个 candidate Plan 必须满足现有四项 invariant，缺一即视为未闭合，不新增第五个 invariant：

```text
USER_INTENT_COVERED
TECH_AUTHORITY_RESPECTED
CODE_REALITY_GROUNDED
WORKER_EXECUTABLE
```

### Planner currentness（语义 basis）与 SPV currentness（exact tuple）分离

Planner lifecycle currentness 绑定 Planning lane 的 relevant **semantic input basis**：当前 Stage/dependency-ready 选择、Project Stage Map/candidate binding（`project_stage_map_ref`）、canonical Authority refs/digests、current code reality、branch/trust root 与合法 planning write scope。在 map-absent 分支下，Planner 首次创建公共 Map 属于本 action 的正向 output，不因自身写入 Map 输出而自动判定为 basis 变化使 Planner 失效。机械 `stage-plan` Git boundary 若只是为 Planner 已返回的同一 candidate blob（包含 candidate Plan 与 candidate Map entry）建立 durable tracked boundary（Authority/code reality/branch/scope 无额外变化），不单独使 Planner binding invalid：Planner 保持 live/passive，由 Brain 在新 candidate Git ref 上启动 fresh SPV。Git HEAD 变化只有在改变上述 relevant semantic input basis 时才使 Planner binding invalid；不把 repository HEAD 当作 semantic currentness 的唯一代理，也不新增 `PLANNER_REBOUND`/`POST_COMMIT_WAITING` 等特殊 phase/status。

SPV lifecycle 继续严格绑定 candidate revision 的 **exact candidate Plan/Git tuple**：candidate Thin Plan + 引用的 Project Stage Map entry（同一 Git basis 下）+ canonical Authority verification basis + exact candidate Git basis；任何 Plan 或 Map material revision 都必须重新建立 fresh full initial 验证（不复用旧 verdict、不存在默认 bounded recheck），Planner 的 semantic currentness 不放宽 SPV 的 exact tuple 绑定。


## 有序规划循环

主流程按真实顺序展开，每次只处理当前 dependency-ready Stage：

```text
MAP CHECK
→ BIND
→ TRACE
→ COMPOSE SLICES
→ VALIDATE SLICE TOPOLOGY
→ DECOMPOSE TASKS BY SLICE
→ RECONCILE
→ CLOSE
→ FREEZE
→ RETURN CANDIDATE_PLAN_READY
```

### 1. MAP CHECK

进入规划后，首先检查公共 Project Stage Map（`delivery/project-stage-map.md`），执行固定执行顺序：持久化/读取准入谓词定义（persist/read predicate definition）→ 依据当前 execution_mode 允许的当前事实求值（evaluate against current facts permitted by the active execution_mode，事实边界遵循本 Skill 的 execution_mode / BIND 规则，不无条件要求 MES）→ 选定依赖就绪 Stage（select dependency-ready Stage）：

- **Map absent（首次 Planning）**：
  - 读取 canonical Authority 与当前代码现实；
  - 按需加载 `.agents/skills/codebase-design/SKILL.md` 的 `Project Stage boundary test`（独立交付 outcome、stable downstream seam、真实 dependency、避免技术层横切、entry criteria、exit outcome）；
  - 创建首份公共 Project Stage Map（`delivery/project-stage-map.md`），定义并持久化各 Stage 的 Stage id / depends_on / goal / entry criteria 准入谓词定义（persist predicate definition，不持久化当前评估结果）/ Technical Authority refs（tech-spec-only）；
  - 依据当前 execution_mode 允许的当前事实对 entry predicate 进行求值评估（evaluate against current facts permitted by the active execution_mode；`NORMAL` 模式依据 relevant MES/Git 与 Planning 输入，`PRE_MES_BOOTSTRAP` 模式依据 Git/Authority/代码现实输入，不读取/不依赖 MES）；
  - 选定当前 dependency-ready Stage（select dependency-ready Stage）。
- **Map present（后续 Rolling-Wave Planning）**：
  - 读取现有 `delivery/project-stage-map.md` 中持久化的 predicate definition，并读取当前 execution_mode 允许的当前事实与代码现实（read predicate definition；`NORMAL` 读取 relevant MES/Git 事实，`PRE_MES_BOOTSTRAP` 读取 Git/Authority/代码现实，不读取/不依赖 MES）；
  - 依据当前 execution_mode 允许的当前事实对 entry predicate 进行求值评估（evaluate against current facts permitted by the active execution_mode），选定/确认当前 dependency-ready Stage（select dependency-ready Stage）；
  - Review 当前 Stage 的 goal、dependencies 与 entry criteria 谓词定义：
    - 发生 material recomposition（Stage 新增、删除、拆分、合并或阶段目标重大调整）或 entry criteria 谓词定义本身发生实质修改（material predicate-definition change）时，加载 `codebase-design` 的 `Project Stage boundary test` 并修订 Map；
    - 仅因外部当前事实变化导致求值结果翻转（evaluation-result-only change）时，Map 保持不变（Map unchanged），求值结果不持久化进 Map；
    - 无 material change 则保持既有 Map 不变；
  - 冻结当前 Stage target（`stage_id` 与 Stage goal）。

**Checkable completion criteria**：
- `delivery/project-stage-map.md` 存在且当前 Stage 具有唯一规划来源；
- Map 仅持久化 entry criteria 谓词定义，不持久化当前 evaluation result；
- 当前 Stage 的 dependencies 与 entry criteria 谓词均可由当前 execution_mode 允许的事实求值闭合且判定为 ready；
- current/future Stage composition 无未解释 material contradiction；
- Map 写入与变更只由 Planner 落盘（General、Brain、MES 不代写 Map）。

### 2. BIND

锁定当前 Stage target 后建立本次规划的上下文与输入绑定：

- 绑定当前 Stage target、canonical Authority refs（PRD、Architecture、Contracts、Acceptance）、Git basis 与 durable facts（`NORMAL` 模式读取 MES facts，`PRE_MES_BOOTSTRAP` 模式读取 Git baseline/current facts 与 candidate/accepted Git Plan facts，不读取或声称 MES facts）；读取四类 Authority 以完成 handoff，但 candidate Map/Plan 的 downstream `authority_refs` 只指向 tech-spec Pack（见 Authority handoff）；
- 绑定 Planner mutation scope（仅限 planning artifacts：`delivery/project-stage-map.md` 与 candidate Thin Plan 写入路径，不等于 future Worker execution scope）；
- **执行纪律**：任务未形成前不进行仓库级代码扫描（不 repo-wide scan）；不读取无关模块；Brain dispatch 只陈述 current target/facts/refs/binding，不把 Brain prompt 当第二方法源。

**Checkable completion criteria**：
- Stage target 与四类 Authority 稳定 ref 完成映射；
- 候选 Plan 目标写入路径已锁定；
- 严守读取边界，无全局或无目标代码扫描。

### 3. TRACE
以当前 Stage obligation、Technical Authority entity 与 current MES/Git/code reality 为输入执行 bounded trace；不得先创建 provisional Slice/Task 再寻找代码依据：
- 对每个 relevant obligation 先分类，并把可进入 Plan 的分类落到 Task 级闭集 `obligation_state`（值域与语义见 `tech-spec/contracts.md` §4.1）：默认 `IMPLEMENTATION_MISSING`，仅当既有实现已真正满足该 obligation 时用 `EXISTING_SEAM`。其余分类不进入 Thin Plan Task：`TECHNICAL_UNKNOWN`（可行性未验证，转 Research/Prototype）、`AUTHORITY_GAP`（PRD→tech-spec 缺失/矛盾，或 unchanged Product intent 下 grounded current code/runtime 反证 current Technical Authority）与 normal implementation/repair（Authority 已充分但实现缺陷），按各自 route 处理。
- `EXISTING_SEAM` 必须携带 SPV 与 Stage Review 都能重跑的 seam：`verification_refs` 里给出具体 test/spec/contract ref，以及不依赖被测实现自身计算的 expected result。pre-accept SPV 在 candidate Git basis 上复核它，Stage Review 在 integrated snapshot 上再证一次。缺 seam、seam 证不出该 obligation、或把仍需新实现的工作写成 `EXISTING_SEAM`，一律按 `tech-spec/contracts.md` §4.1/§7 判 `PLAN_GAP`；不得据此跳过真实实现工作（`tech-spec/acceptance.md` E2E-29）。
- 只对当前 obligation 定向读取真实 public/cross-module seam、durable fact、state、producer/consumer、persistence 与 test oracle；不进行 repo-wide scan。
- 对 `EXISTING_SEAM` / `IMPLEMENTATION_MISSING` 确定可观察 outcome、relevant code/test paths、真实 producer/consumer dependencies 与 test oracle；由 `DECOMPOSE TASKS BY SLICE` 再将这些 reality 分配给所属 Slice 的 Task-specific `code_paths`/`test_paths` 与 Task dependencies；`TECHNICAL_UNKNOWN` / `AUTHORITY_GAP` 直接形成结构化 blocker，不猜测补全。
- 需要新增或 materially 改变 verification/test seam 的 obligation：先闭合 observable outcome → stable seam → independent expected result，再交给 `COMPOSE SLICES`；seam 至少直接观察该 obligation 的行为 / durable relation / machine contract / public seam，expected result 来自独立 Contract / invariant / known behavior（不复制 implementation 自己的计算或结构）；semantic-preserving 前提先确认：所谓变化确实不改变 public contract / machine-consumed input / observable behavior（公开 schema field 或 machine-consumed 结构 rename 是 public contract change，不是「纯内部 refactor」）——只有该前提成立时，普通内部重构或非机器消费 prose 整理使 proof 失败，才是 invalid oracle 的强反例，此时重选 seam/test（除非被检查源码/repository structure 本身是正式 machine contract）。
- **先识别验证对象（verification object → oracle）**：Planner 在 working reasoning 中先回答「这个 verification 实际在观察什么？」，再决定对应 oracle：程序 observable behavior / durable relation / recovery behavior、machine-consumed contract / parser / public surface、repository structure 本身作为明确 machine rule、还是非机器消费的说明性 prose。验证对象决定 oracle；不存在「静态测试天然坏 / Markdown 天然不能测试 / 字段名测试天然坏」的先验标签。
- 合法 machine/static verification 保留：parser 拒绝 unknown field、closed enum 含规定 value、public export surface exact、repository structure 本身就是 contract、machine-consumed config / Markdown format、durable relation restart 后仍闭合等仍可能完全合法。判断依据是被测试的结构/字段/文本本身是不是规范要求的可观察或机器消费契约：若是，它改变就可能是实际 Contract change，不能用「rename 后测试失败」自动推导它是坏测试。
- prose consistency 不冒充 behavior proof：只读取多份非机器消费 Markdown / Plan / Contract、复制字段 vocabulary、要求几份解释性文字使用同样措辞，并把文字一致当成 Runtime behavior closure，不能单独作为 implementation behavior proof；这类内容回 doc review / owner reference review，不建立第二套机器事实。
- mixed test 必须按 assertion class 分析：同一测试文件（如 static/source scanning test）可能同时含合法 machine/repository invariants 与可疑 cross-document prose consistency；不能看到 static test 就全部接受，也不能看到 Markdown 就把整个 test 全部拒绝；按实际 assertion class 分别判断（如 public export exact-once 可能是合法 machine invariant，而几份非机器文档 vocabulary 一致不能自动证明 Runtime behavior）。
- **existing verification impact trace**：Planner 不能只找新的目标测试文件，还必须定向检查本次 behavior change 必然影响的 existing regression fixtures / verification seams；TRACE 顺序保持 obligation → observable behavior → production seam → existing + new verification seams → relevant code/test reality，再交 `DECOMPOSE TASKS BY SLICE` 做 Task ownership；只沿当前行为影响链 bounded trace，不变成 repo-wide test scan；受影响的已有 fixture 必须落入某个 Task scope 或显式暴露为缺口，不能悬空。
- Existing Plan/test patterns 是 code-reality evidence，不是 Planning authority 或自动 precedent：旧 pattern 必须重新通过 current Authority + current Skill + current code reality + current verification-seam validity 才能沿用。
- Plan 自己引入而 PRD/Technical Authority 未要求的 helper、signature、schema、graph 或 protocol detail 属于 Plan choice；不反向升级 Authority，后续按 `PLAN_GAP` 回 Planner。
**Checkable completion criteria**：
- 每个 relevant obligation 都有可复核分类与对应 code/test reality 证据；
- 每个需要 verification 的 obligation 都有可观察 outcome + stable seam + valid verification/test oracle，或形成结构化 blocker；test path 不是仅因为旧 Stage 有同类文件而被选中；
- trace 在当前边界闭合后停止，不产生无目标扩读。
- 对每个 relevant obligation 已先识别 verification object 并选择对应 oracle（machine/public/repository invariant 保留或说明理由；非机器 prose consistency 不冒充 behavior proof）；mixed test 已按 assertion class 拆分判断；
- existing verification impact 已沿行为影响链 bounded trace：受 behavior change 影响的 existing regression fixture / verification seam 均有归属（落入 Task scope 或显式暴露为缺口），无 repo-wide test scan；
### 4. COMPOSE SLICES

分层的第一次：只形成 Stage → Slice topology，暂不创建 Task。消费 TRACE 已确认的 reality 与 classifications，先只选择最小可交付的 Slice 边界：

- 定义每个 Slice 的 goal、observable outcome、semantic scope、stable seam、verification/oracle basis、真实 `depends_on` 与 authority refs；
- 以 `Tracer bullet` 为 leading word：每个 Slice 是一条从可观察 outcome 直达独立验证的端到端轨迹；fresh 首次形成 Slice topology 或 Slice 发生 material repartition（新增、删除、拆分、合并、重新划分）时，加载 `.agents/skills/codebase-design/SKILL.md` 的 `Vertical Slice boundary test`；
- 分解方向固定为：observable Slice outcome → stable seam → independent verification → real blocking dependency；TRACE 得到的 code/test reality 保持为 evidence，具体 Task ownership 留到 `DECOMPOSE TASKS BY SLICE` 分配；
- 不得反过来按技术层横切直接切片（如 types.ts → Slice A、store.ts → Slice B），除非这些边界本身各自形成独立可验证 outcome；
- 每条 `A depends_on B` 必须能指出 A 实际需要 B 已产生的哪个 output / fact / seam / verified capability；回答不出就不是 blocking dependency，不因「通常先 schema 后 store」「实现顺序看起来合理」制造 dependency；
- Planning 只定义 WHAT / WHEN / BOUNDARY，不设计 Worker HOW；implementation choice 留在 execution-owned Plan scope，不写回 Technical Authority。

**Checkable completion criteria**：
- 每个 Slice 是一个 tracer-bullet outcome，具有可观察 seam/oracle 与真实 dependency，可在完整 Stage 完成前独立验证；
- Slice topology 足以作为后续 Task decomposition 的 skeleton，且每个 Slice 对应 TRACE 已确认的 outcome、seam 与 scope；
- 依赖只表达真实 prerequisite；dependencies 闭合，无循环、无隐藏 producer/consumer。

### 5. VALIDATE SLICE TOPOLOGY

创建 Task 前，对整个 Slice topology 做一次整体检查，作为 Slice composition 与 Task decomposition 之间明确的 reasoning checkpoint：

- **outcome coverage**：所有 Stage obligations 都映射到一个或多个明确 Slice outcome；
- **Slice coherence**：每个 Slice 的 goal、seam、consumer 与 verification 指向同一个 coherent capability；
- **dependency closure**：每条 Slice dependency 都能指出实际消费的 predecessor output / fact / seam / verified capability；
- **parallelism**：具有独立 outcome 且无真实 prerequisite 的 Slice 保持独立，便于 Execute 沿 dependency-ready topology 推进；
- **interface closure**：跨 Slice 输入输出关系具有明确 producer 与 consumer，后续 Task decomposition 基于这些稳定边界工作。

**Checkable completion criteria**：
- Slice topology 形成可执行的 decomposition skeleton，无未解释的 obligation coverage、coherence、dependency 或 interface 缺口；
- 随后进入逐 Slice Task decomposition。

### 6. DECOMPOSE TASKS BY SLICE

一次聚焦一个 Slice，把该 Slice 的 TRACE reality 与 Slice contract 分解为 Tasks，完成该 Slice 的 local planning closure 后再进入下一个 Slice。只处理当前 Slice 所需的 implementation obligations、`EXISTING_SEAM` satisfied predecessor、Task goals、dependencies、semantic scope、code anchors、task-specific `code_paths`/`test_paths`、verification refs、Proof Obligations、`obligation_state`、done/stop conditions 与 required Skills。

Task decomposition 顺序固定为：Slice outcome → Slice obligations → Task-local outcome → verification closure → ownership boundary → real Task dependency → code/test path allocation。

每个 Task 继续满足当前 ProofLoop 已有的 closure 原则：

- local closure；
- verification closure；
- future-HOW independence（implementation choice 留在 execution-owned Plan scope）；
- natural TDD `RED → implementation → GREEN` 保持在自然实现闭环内，不跨 Task 切碎；
- dependency 指向真实 predecessor result/seam；
- code/test ownership 清楚且可追踪。

- `code_paths`/`test_paths` 是 ownership boundary，不是 decomposition source；
- `obligation_state: EXISTING_SEAM` 的 Task 是 satisfied predecessor：它由 current snapshot 的既有实现满足，可由 machine-verifiable seam 独立证明，不要求新的实现工作，也不阻塞依赖它的 Task（`tech-spec/contracts.md` §4.1/§4.3）。

**Slice-local 反馈路径**：逐 Slice Task decomposition 同时承担对 Slice topology 的第二次验证。当 decomposition 显示当前 Slice 实际包含多个独立 outcome、某个 Task 必须持续理解另一个 Slice 的内部实现、当前 dependency 与已定义 Slice interface 不一致，或 ownership 无法在当前 topology 中形成清楚边界时，在同一 Planner action 内回到 `COMPOSE SLICES`，基于新证据重新形成 Slice composition，再重新执行 `VALIDATE SLICE TOPOLOGY` 与受影响 Slice 的 Task decomposition。

**Checkable completion criteria**：
- 每个 Task 自足：local closure、verification closure、future-HOW independence 与 natural TDD 闭环成立；
- 每个 Task 的 obligation、outcome、seam、oracle、ownership 与 dependency 均可反向闭合到所属 Slice outcome；
- 每个 Slice 的 Tasks → Slice outcome 反向闭合完成后才进入下一个 Slice；
- 所有 Slice 的 Task decomposition 完成，且无遗留的 Slice boundary 反馈。

### 7. RECONCILE

所有 Slice 完成 Task decomposition 后，执行一次 Stage-level global reconciliation：

- **obligation coverage**：Stage obligations 已完整映射到 Slice / Task closure，existing seams 与 implementation work 均有明确归属；
- **ownership**：mutable production/test paths 的 ownership 与 Plan semantic scope 一致，并能支持后续 isolated Slice execution；
- **dependency**：Task dependency 与 Slice dependency 一致；跨 Slice dependency 对应已定义的 stable seam / output；
- **verification**：每个 Task verification closure 汇聚成 Slice oracle，每个 Slice oracle 汇聚成 Stage outcome proof（Task proof → Slice proof → Stage proof）；
- **cross-Slice interface**：downstream Slice 使用的 predecessor output 确实由 upstream Slice done condition 提供；
- **parallel execution readiness**：独立 Slice 的 ownership 与 dependencies 保持解耦，使 Execute 可以沿 dependency-ready topology 推进。

**Checkable completion criteria**：
- 完整 Stage Plan 同时满足 Task closure、Slice closure、Stage closure、ownership closure、dependency closure 与 verification closure；
- ownership、required Skills、Proof Obligation 与后续 CLOSE 所需 binding 输入均可继续追踪；
- reconciliation 发现的 Slice boundary 问题同样回到 `COMPOSE SLICES` 处理。
### 8. CLOSE

核对跨边界数据与事务绑定：

- **仅在真实 binding crossing 时**读取 `.agents/skills/proofloop-plan/references/transaction-binding-closure.md`：只有同一 binding-critical 字段、标识、digest、credential 或其他绑定值跨越 producer、validator、persistence、consumer 或 recovery 任一边界传递时才加载；无真实跨边界时跳过；
- 核对跨边界值的 canonical equality、replay/idempotency、restart/recovery 与 no-write failure boundary；
- 缺失 ref 或无法闭合的边界直接记录结构化 blocker，不猜路径、不造 schema。

**Checkable completion criteria**：
- 真实跨边界的 binding-critical 值均在 Contract/Authority 中有明确归属与闭合依据；
- 无法闭合的缺口以结构化 blocker 暴露，无隐式假设。

### 9. FREEZE

组装并冻结 candidate Thin Plan：
- **Working context is not Plan content**：MAP CHECK / BIND / TRACE / Replan 中可知的「candidate 尚未接纳」「第几轮 replan」「SPV history」「TRACE classification」「为何选择某 seam」「当前 planning work / session」都是 working context，FREEZE 时不得自动写入 Thin Plan；
- **Thin Plan 只保存 downstream Execute 真正需要的 planning facts**：Stage/Slice/Task goals、dependencies、semantic scope、stable authority/verification refs、code anchors、task-specific `code_paths`/`test_paths`、Proof Obligations、done/stop conditions、required skills、真实 cross-boundary binding facts；
- **Working context scrub**：清理 MAP/BIND/TRACE narration、「当前尚未接纳」「这是 replan」「map_change:none」之类当前过程状态、SPV finding history、Agent / Link / pane / session / actionToken 元数据、选择 oracle 的 reasoning、复制的 Authority / Contract prose；描述目标系统本身的稳定 lifecycle semantics 可以保留，描述当前 Plan artifact 自己此刻的流程状态则禁止；

- 采用 Future Thin Plan shape：
  - 共享的 protected/forbidden scope、机械 metadata 与重复 Authority refs 提升为共享的 Stage/Slice 默认，不在每个 Task 重复；
  - Task 级只保留 task-specific facts：goals、dependencies、semantic scope、code anchors、task-specific `code_paths`/`test_paths`、verification refs、`obligation_state`、done/stop conditions、required Skills 与 Proof Obligation binding；
  - 重复 Authority refs 收窄为稳定小粒度 ref，不用摘要替代 canonical Authority；
  - candidate Plan 正文不记录 mutable acceptance/progress state（不承载 Receipt/Gate、不记录 mutable checkbox）；
  - 经 `project_stage_map_ref` 引用同一 Git basis 下对应的 Project Stage Map entry；
- 保持现有的四个 invariant，不新增第五个：
  1. `USER_INTENT_COVERED`
  2. `TECH_AUTHORITY_RESPECTED`
  3. `CODE_REALITY_GROUNDED`
  4. `WORKER_EXECUTABLE`
- 将 candidate Thin Plan（及按需更新的 `delivery/project-stage-map.md`）写入磁盘。

**Checkable completion criteria**：
- 四项 invariant 全部满足；
- Thin Plan 只含 downstream-needed planning facts；working context / mutable planning state 已 scrub；
- candidate Thin Plan 与 Map entry 成功落盘；
- candidate Plan 不含任何 mutable execution state 或 Runtime-owned 制品（无 Manifest/Evidence skeleton/Receipt）。

### 10. RETURN CANDIDATE_PLAN_READY

- Planner 产出/修订落盘后，通过 Herdr Link 返回 `CANDIDATE_PLAN_READY` 结果，结束当前 Planner action；
- Result envelope 携带 `candidate_plan_ref`、`project_stage_map_ref`、`stage_id`、`authority_refs`、`git_basis`、`actionToken` 等闭合元数据；
- **Planner 不 dispatch SPV**：由 Brain / Contract 负责建立 candidate Git boundary（mechanical `stage-plan` boundary）并经 Herdr Link configured start 调度独立的 `stage-plan-verifier`；
- Planner 进入 passive 等待状态，等待 SPV 验证结果与 Brain 仲裁。

**Checkable completion criteria**：
- 返回合法的 `CANDIDATE_PLAN_READY` 信号与完整 packet 元数据；
- Planner action 完整结束，无多余的后台调用或越权调度。

## SPV 结果与失败路由

SPV 是独立的 review-loop Role（经 Herdr Link configured start 启动，role_skill=config_agent=stage-plan-verifier），对 pre-accept candidate Thin Plan 做只读独立 falsify（全量 structural closure + 高风险 edge counterexample challenge）。SPV 结果一律回 Brain，由 Brain 重读事实后做 finding disposition：

- `PLAN_READY`：Brain 先授权 semantic planning event，经 MES transaction layer materialize `PLANNING_VERIFICATION_RESULT`（`candidate_plan_ref` 必填、`accepted_plan_ref: null`），再 materialize `PLAN_ACCEPTANCE` 并接纳为 accepted（`NORMAL`；`PRE_MES_BOOTSTRAP` 采纳 Git-tracked Thin Plan，不写 MES），随后将 accepted Plan 路由至 `proofloop-execute`；S06 hard-freeze 下不执行 NORMAL acceptance。
- `FINDINGS`：SPV 发现 concrete counterexample 或 structural gap。SPV 的 `claimed_route_code` 只是 evidence；Brain 重读 Authority / Plan / scope / code reality 后发起 `FINDING_DISPOSITION` semantic event，由 MES transaction layer materialize（如适用）。若判定为 `VERIFIER_OVERREACH`，`accepted_route_code` 为空，不触发 Replan；若确认为有效 Finding，Brain 派发 Replan 修复。
- `BLOCKED`：SPV 缺少输入、Authority 存在缺口、技术未知或环境受阻，带结构化 blocker 回 Brain。
- `AUTHORITY_GAP`：Product intent → Technical Authority → grounded reality handoff failure（含 PRD requirement 在 tech-spec 缺失/矛盾，或 unchanged Product intent 下 current code/runtime 反证/证明 Authority 不足），回当前 Propose Authority owner；owner 完成 bounded update 后由 Brain acceptance + `authority-update` 固化，再 fresh Planning/SPV。
- `TECHNICAL_UNKNOWN`：回 Researcher/Prototype；未经验证不改 Authority 或 Plan 语义。
- 缺少 entity/ref、code reality 或输入不闭合：fail closed，不由 progress、checkbox、Agent narrative 或旧缓存补齐。

## Replan

Replan 接收 Brain disposition 接纳的 structured finding evidence（不接收 raw verifier narrative 或未接纳 claim），按 impact-based 推进：

```text
carry_forward
invalidated
new / changed
```

1. **Impact 范围判定**：
   - **Plan-local impact**：Finding 仅涉及当前 Stage 内部 Task/Slice（如 Task seam 修正、test oracle 补全、局部 scope 调整），不改变 Stage 目标、依赖图或边界。直接进入当前 Stage Plan revision，仅修订 candidate Thin Plan。
   - **Stage-Map impact**：Finding 改变 Stage goal、dependencies、entry criteria 谓词定义（material predicate-definition change，而非外部当前事实变化引发的 evaluation change）、Stage 划分或后续 Stage composition。必须先在 MAP CHECK 中按需加载 `codebase-design` 的 `Project Stage boundary test` 修订 `delivery/project-stage-map.md`，再修订 candidate Thin Plan。仅外部当前事实演变引起 entry criteria 求值结果变化不属于 Stage-Map impact，不修订 Map。
2. **三分类更新**：
   - `carry_forward`：未受影响的 Slice/Task 与 Map 条目保持原样；carry_forward 不是免检标签，其语义是「当前 finding / current Planning method 变化经 impact check 后，没有使该 planning choice 失效」：已 integrated 的 Slice/Task 无新 invalidation evidence 就保持 durable history，不重做；尚未执行的 Task 若本轮方法变化直接约束其已有 verification seam / Slice composition / ownership / dependency 选择，标记 carry_forward 前必须重新核对对应 choice（不重新规划整个 Task，只核对受方法变化影响的 planning decision）；该 reasoning 留在 Planner working context，不写入 Thin Plan；
   - `invalidated`：受影响的 Slice/Task 与 Map 条目重新生成；`invalidated` 不等于 Git rollback，已有的代码与测试保留为 current code reality；
   - `new / changed`：新增或调整的 Slice/Task 与 Map 条目。
3. **完成与重新验证**：
   - 受影响 artifact（Map 和/或 candidate Thin Plan）修订落盘后，再次通过 `RETURN CANDIDATE_PLAN_READY` 结束当前 Planner action；
   - 任何 Plan 或 Map material revision，都在新的 exact tuple（candidate Plan + referenced Map entry + Authority + exact candidate Git basis）上由 Brain 建立 candidate boundary 并调度 fresh full initial SPV，严禁复用旧 verdict 或执行增量复查；
   - **Planner 不 dispatch SPV**。
   - 同一 delivery cycle 内的 Plan revision 追加一代 accepted generation：fresh SPV `PLAN_READY` 后由 Brain materialize 一次新的 `PLAN_ACCEPTANCE`，其顶层 predecessor 字段指向该 (stage, cycle) 当时的链 tip；revision 不新建 `delivery_cycle_id`，也不改写早前 generation 或 support（`tech-spec/architecture.md#/entities/planning-acceptance-succession`、`tech-spec/contracts.md` §2.2.2）。

## 重启验证

`NORMAL` 重启后从 Git、四类 Authority、Project Stage Map、既有 Thin Plan、Findings 与 MES 事实重新建立上下文；`PRE_MES_BOOTSTRAP` 重启后只从 Git、四类 Authority、Project Stage Map、candidate/accepted Git Plan、Findings 与结构化 Link evidence 建立上下文，不读取或声称 MES。
验证以文件、真实命令与 Git 状态为准：

```text
git diff --check
```

## Pre-MES bootstrap（一次性例外）

在 MES persistence 集成并 seed accepted Plan/bootstrap facts 前，accepted Thin Plan 是该 Stage 唯一 Git-tracked durable truth：只使用 Git Plan ref + baseline HEAD/current HEAD 作为 binding 与验证基础；不写入 MES/Status、不声称 MES/Status 事实；不产生 MES Result、也不产生 Receipt、Manifest、Gate 或第二状态机，也不把 bootstrap 状态描述为更高完成度。

- bootstrap 只在 MES persistence 集成且 accepted Plan/bootstrap facts 已被 seed 前有效；seed 之后 `PRE_MES_BOOTSTRAP` 永久禁止，恢复正常 Planning → MES transaction → Execute → Review；S06 integrity hard-freeze 时 NORMAL transaction/continuation 仍被禁止。
- 本 Skill 不声称 MES 已实现；MES 是否就绪以 mes Contract 与 Git 事实为准。
- 在 map-absent 分支下，由 bootstrap 首次 Planning 创建首份公共 `delivery/project-stage-map.md` 并选定首个 MES-persistence Stage。
- `PLAN_READY` 的 bootstrap handoff：Planner 返回 `CANDIDATE_PLAN_READY`，经 Brain 调度 fresh SPV 验证返回 `PLAN_READY` 后，Brain 直接采纳 Git-tracked Thin Plan（不写 MES），只把首个 MES-persistence Stage 以 bootstrap binding 路由给 Execute；seed 前不接受、不依赖 MES 写入。seed 后恢复 Planning → MES → Execute → Review 的正常路径。

## 硬边界

- 不启动正式 Stage，不派发 Worker/CV，不调用任何旧 Runtime CLI 或 admission 流程。
- 不写 Manifest、Context、Evidence、Receipt、Gate/Review 状态，不修改 Authority。
- 不复制 Brain dispatch、SPV dispatch、Host lifecycle、Execute packet projection 或具体 Worker HOW。
- 任务未形成前不进行仓库级代码扫描（不 repo-wide scan），不把 Brain prompt 当第二方法源。
- 不恢复旧 materializer/Receipt/admission 语义作为 fallback。
