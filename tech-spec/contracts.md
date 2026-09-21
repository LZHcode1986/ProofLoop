# Contracts & State — ProofLoop 新流程模型

> canonical Authority 按 phase 分层：`PRD.md` 是 Product Authority；`tech-spec/architecture.md`、`tech-spec/contracts.md`、`tech-spec/acceptance.md` 是 Technical Authority Pack。`PLAN_READY` / `PLAN_ACCEPTANCE` 后 downstream normative truth 仅为 tech-spec Pack；`.agents/contracts/brain/mes.md` 是实现语义 Contract，不替代 canonical Authority。实现状态以 Git facts 与 Runtime 源码为准，不由本文件跟踪。
> `CONTEXT.md` 仅作 Working Memory 参考，不是 Authority source。
> 本文锁定 MES facts、status 一级/二级、Project Stage Map / Thin Plan / Work Packet、Subagent host lifecycle、
> Git worktree lifecycle、错误契约与文件制品契约；不重定义 Product/Technical Authority。
>
> 标记：`confirmed` = 已确认；`assumed` = 架构默认，实施时需验证；`open` = 未验证。

## 1. Public CLI 契约

### 1.1 Mechanical CLI

```text
proofloop <domain> <operation> --request <root-relative-json> [--project-root <path>]
proofloop <domain> <operation> --json <closed-json> [--project-root <path>]
proofloop status [--detail] [--json] [--project-root <path>]
```

- Consumer: `packages/runtime/src/cli/proofloop.ts` 的 `proofloopCli()`。
- **active domains 闭集**：`boundary`（operation `close`）与 `integration`（operation `apply`），分别由机械 Git boundary / Integration adapters 提供；此外 `proofloop status [--detail]` / `proofloop status --json [--detail]` 是顶层只读 MES observation entry，不加入业务 domain registry。旧 business-control domain（authority/plan/context/stage/review/project/doctor/gate/recovery/cutover）不得存在。
- `--project-root` 只做 canonical trust-root 一致性断言；不能覆盖 trust root。
- unknown domain/operation、unknown request field、root escape、schema mismatch 必须在
  写入前 fail closed。
- stdout 恰好输出一个 canonical JSON envelope；不得用自然语言前缀替代结构化结果。
- Exit：`0` = completed/accepted/read-ready；`1` = usage/schema/runtime failure；
  `2` = structured blocked/refused/no-write。
- **`proofloop status` 是最小只读 observation seam**：支持默认 sparse projection 与 `--detail`，并支持 `--json` 结构化输出；它只从 root-bound seed/snapshot 读取并 fail closed，不写 MES、不输出 route/next action/reasoning。MES durable mutation 不由 Brain 组装 full snapshot：Brain/Host 仅发起/授权 semantic event，唯一 MES operational transaction layer 负责 current-state read、fact/relation materialization、canonical binding、preserve-by-default、idempotency、complete-state validation 与 atomic persistence；`MesSnapshotStore` 仅为内部 primitive。

### 1.2 Closed domain registry（当前）
### 1.2 Closed domain registry
| Domain | Operations | 责任 | 流程关系 |
|---|---|---|---|
| `boundary` | `close` | 机械 Git boundary adapter（allowed-path staging、dirty gate、commit） | Brain/Host 通过 CLI 执行机械 Git 事务；不承担 Gate/Receipt 业务前置 |
| `integration` | `apply` | dedicated mechanical Integration adapter（candidate ref → Stage HEAD 的受限应用） | Brain/Host 通过 CLI 执行机械 integration transaction；不承担 MES state transition |

### 1.3 Canonical CLI result envelope

```yaml
schema_version: 2
ok: true | false
command:
  domain: <closed-domain> | status
  operation: <closed-operation> | null (status observation)
result: <bounded-projection-or-null>
findings: []
refs:
  - ref: <root-relative-ref>
    digest: <sha256>
runtime:
  version: <semver>
  schema_version: <number>
```

`result`、`findings`、`refs` 的具体字段以对应 Runtime command/Contract 为准；
Subagent type、agent_id、session_id、transcript、transport message id 不得进入该 envelope 的业务 authority。

## 2. MES facts 契约（`.agents/contracts/brain/mes.md`）

### 2.1 MES 事实类别

```text
Project
Stage
Slice
Task
Work（Agent dispatch / work identity）
Result（structured execution record）
Finding（quality / exception）
Plan binding（accepted Plan → Work）
Git candidate / integration ref
Review outcome / Finding relation（envelope schema = `.agents/contracts/brain/stage-review.md`；durable semantics见 `tech-spec/contracts.md#/entities/review-result-contract`）
Exception / recovery
PROJECT_READY
```

<!-- proofloop:entity id="review-result-contract" kind="seam" -->
### 2.1.1 Review / terminal / finding durable relations
`.agents/contracts/brain/stage-review.md` 是 Stage Reviewer envelope 与通用 Return-code 的唯一 schema owner；本 Technical Authority entity 只规定 Review outcome、MES durable relation、finding evidence 与 terminal support semantics。S04 Thin Plan 不得复制任一 envelope schema。
- Review 以 accepted Plan、Technical Authority（tech-spec）与 integrated snapshot 为 basis；Outcome / Composition / Authority 三轴独立，overall verdict 遵守 no-masking：任一 `BLOCKED` → `BLOCKED`，否则任一 `FINDINGS` → `FINDINGS`，仅全 `PASS` → `PASS`。
- 非 `PASS` 的 Stage Reviewer Result 必须按 `stage-review.md` 携带有序、非空、稳定的 `finding_evidence_refs`；Brain 写入 durable Finding 后必须能重读同一 refs；`PASS` 使用空数组。evidence narrative 只作传输说明，不是 durable evidence。
- Brain 将同一 Review finding 映射到一个既有 durable `finding` fact，并由现有 `FINDING_DISPOSITION.finding_ref` 精确引用；映射必须唯一、确定、可重启重建，冲突或缺失支持 fail closed。具体 fact-id/hash 生成算法不属于本 Authority。
- 三轴全 `PASS` 且 integrated snapshot 仍匹配时，Brain 写入现有 accepted `stage` fact 形状（Stage scope、accepted Plan binding、Git basis、`result_ref`、`created_by: brain`）；不得为 Review 另造 `review_result_ref`、Review 专属 replay 字段或第二个 Stage schema。
- 当前 Delivery cycle 的所有计划内 Stage 均有 durable accepted-stage support 时，Brain 产生该 cycle 的 `PROJECT_READY` terminal fact；planned Stage 集合来自 active Project Stage Map，MES 不读取或生成 Map。`PROJECT_READY` 的具体 fact kind / 字段形状由 MES Contract 与 Runtime owner 决定，但必须表达该 terminal 自身 planned 集合与 accepted support 的精确关系。
- **Cycle-terminal relation shape is closed for new writes:** a new NORMAL `project_ready` terminal keeps `delivery_cycle_id` at the envelope top level and carries top-level `supersedes_project_ready_ref`. If no retained cycle-bearing terminal exists, the first new terminal sets this field to `null`; otherwise every new terminal sets it to the exact `fact_id` of the immediately prior validated chain tip (including a retained compatibility anchor). The field is terminal-only; it is not `plan_binding`, `scope`, `result_ref`, or a new fact kind.
- **Compatibility is explicit and read-only:** legacy terminal facts that omit both `delivery_cycle_id` and `supersedes_project_ready_ref` remain history-only. A pre-update retained terminal that has `delivery_cycle_id` but omits `supersedes_project_ready_ref` is a `legacy_cycle_anchor`: its own support closure remains valid, it may serve as the root of a new succession chain, but it is never backfilled, rewritten or newly emitted. All new cycle-bearing terminals must carry both keys; a new half-new shape is invalid rather than guessed.
- **Accepted-stage support binds the current planning generation:** accepted `stage` support 的 accepted Plan binding 必须解析到该 Stage 在当前 cycle 的 current accepted generation；绑定旧 generation 的 support 保留为 immutable history，但不再授权 `STAGE_ACCEPTED`、terminal support closure 或后续 continuation（与 relation-invalid history 的 non-authorizing 侧一致）。
- **Planning generations are append-only and superseding:** 同一 (Stage, delivery cycle) 的 accepted Plan generations 经 `supersedes_plan_acceptance_ref` 形成链，唯一 tip 为 current generation（`tech-spec/architecture.md#/entities/planning-acceptance-succession`）；`resume` 不写新 generation，`replan` 在同一 cycle 追加 generation，`restart` 在同一 generation 下以 fresh Work identity 重建执行事实（Planning tuple 变化时先 `replan`）。历史 generation、support 与 downstream facts 都不被改写。
- 历史 `PROJECT_READY` terminal 按自身 planned Stage set 与 delivery/planning basis 验证；后续 cycle 的 accepted Stage 或 terminal 可以共存但不得使历史 relation 失配，current workflow state 不由历史 terminal 单独推导。
- Review、Finding、accepted Stage 与 `PROJECT_READY` 的 durable support 在 snapshot replacement、重启与 rehydrate 后保持可重建；缺失、冲突、snapshot/binding 不匹配均 no-write。
- 现有 MES Result/Finding 的通用 identity、幂等与冲突规则继续适用；本 entity 不新增 Review-specific `result_id`、`result_payload_digest`、SPN/hash 算法、store options、helper signature 或 graph schema。
- Technical Authority 只锁定可观察行为、invariant 与 relation；具体 adapter、模块、参数和内部 producer/consumer 由 bounded TRACE 后的 execution-owned Plan 决定，不因实现选择缺少 Authority 正文而回写 Authority。
- `delivery_cycle_id` 是 Brain 在每次 NORMAL Propose 完成时生成的 opaque、稳定且同一 snapshot 内唯一的 cycle identity；candidate/accepted Plan binding、其 downstream Work/Task/Result/Finding/Git/Stage facts 与 `PROJECT_READY` 必须携带或继承同一 ID。ID 不由 session、`actionToken`、时间戳、Git HEAD 或 fact insertion order 派生；相同 `planned_stage_ids` 的不同 ID 仍是不同 terminal。
- NORMAL scope-role 闭合：`task` 必须为 stage+slice+task；accepted Plan 下 stage-only 的 `work` / `result` / `finding` 仅可作为 Review-owned durable output，Execute-owned 事实必须有 `slice_id` 或 `task_id`；candidate/integration/cleanup `git` 必须有 slice scope。旧 retained facts 只按既有 legacy 兼容规则读取，不被新规则重解释。
- accepted `stage.result_ref` 必须 exact-resolve 到同一 `delivery_cycle_id`、同一 accepted Plan、stage-only scope 的 Review-owned `result`；generic `fact_kind: result` 或 opaque `result_ref` 本身不构成 Review role proof。
- New NORMAL `PLANNING_VERIFICATION_RESULT` and `PLAN_ACCEPTANCE` facts must carry a stage-only `scope: { stage_id: <current Stage> }`; a retained legacy planning fact without that scope or a cycle ID is read-only history and cannot be selected as current. The unique in-flight Stage is the only same-cycle stage-scoped planning/downstream candidate without same-cycle accepted-stage support; zero or multiple candidates fail closed as `AUTHORITY_GAP` rather than consulting Map, plan filenames, Git order, insertion order or ref names.
- Field placement is closed: plan-bound NORMAL facts carry `delivery_cycle_id` in `plan_binding`; `project_ready` carries top-level `delivery_cycle_id` and still rejects `scope`, `work_id`, `result_ref` and `plan_binding`. New or changed plan-bound facts must match the unique same-cycle candidate/accepted planning binding; accepted `stage`/Review result and per-cycle `PROJECT_READY` support must match the same ID. The MES write boundary checks submitted ∪ retained facts; legacy retained facts may omit the new fields only for compatibility reads and never authorize new current facts.

<!-- proofloop:entity id="mes-operational-transaction-boundary" kind="seam" -->
### 2.1.2 MES operational transaction boundary
- Brain/Host 是 semantic mutation initiator / authorization owner；它提交一个有界 semantic event 与当前 binding，不提交完整 snapshot、retention list 或由 caller 组装的 `submitted ∪ retained` 状态。Role Agent、Worker、Verifier 不直接调用 durable MES writer。
- MES operational transaction layer 是唯一 normal durable mutator。每次 transaction 必须按以下顺序：读取并锁定当前 root-bound snapshot → 按 fact kind 校验 semantic preconditions 与权限 → 从 current accepted Plan/cycle/relation 唯一解析 binding-critical identity → 将 semantic event 物化为新 facts/relations → 默认保留所有 unrelated durable fact IDs → 校验完整 resulting fact set、relation closure、idempotency 与冲突 → 通过内部 `MesSnapshotStore` 一次性 atomic persist。
- transaction 的成功结果只报告本次 materialized fact/relation refs 与 Git/basis facts；它不输出 next action，不承担 route、dispatch、reasoning，不复制 Authority/Skill。
- normal transaction 只允许 append/update 当前语义定义的 projection；不得把 caller 未提交的旧 facts 当作删除指令。异常、validation、binding、权限或持久化失败均 no-write；不得自动 retry。

<!-- proofloop:entity id="mes-binding-critical-identity" kind="oracle" -->
### 2.1.3 Binding-critical identity ownership
- `verification_result_ref`、`delivery_cycle_id`、accepted Plan identity、canonical Work/Task/Result relation 与 terminal predecessor/currentness 等 binding-critical identity，若能从 current durable relation 唯一解析，必须由 MES transaction layer 解析并 materialize；caller 不负责复制或拼接 canonical identity。
- current accepted Plan generation（同一 stage + cycle 的 generation chain 唯一 tip）、其 fresh `PLAN_READY` PVR 与下游 `verification_result_ref` 的对应关系同属 binding-critical identity：必须由 MES transaction layer 从 current durable relation 唯一解析并 exact-compare；零/多 tip、链损坏、stale predecessor 或绑定旧 generation 的 downstream fact 均 atomic fail-closed，且不得授权当前执行。
- 若 semantic operation 携带 binding，transaction layer 必须将 submitted binding 与 current canonical relation exact-compare；typo、旧 ref、近似 ref、跨 cycle、缺失或歧义 relation 均 atomic fail-closed，snapshot bytes 与 fact identities 不变。
- relation resolution 不使用 insertion order、fact filename、ref spelling、timestamp、Git recency、status projection、newest-wins 或第二 pointer/store。

<!-- proofloop:entity id="mes-invalid-history-oracle" kind="oracle" -->
### 2.1.4 Invalid immutable history
- schema-readable、durable、immutable、readable、auditable 但 relation-invalid 的 facts 保留为历史；它们不能支持 current Work/Task/Slice completion、Integration/CLEANED、`STAGE_ACCEPTED`、`PROJECT_READY` 或 continuation。
- restart/rehydrate 必须对同一 facts 给出相同的 non-authorizing classification；不得 delete、rewrite、silent-correct、backfill，或追加 correction fact 后按时间/插入顺序选择“最新有效”。

<!-- proofloop:entity id="mes-maintenance-recovery-boundary" kind="seam" -->
### 2.1.5 Maintenance/recovery implementation boundary
- 当 NORMAL MES 被 integrity incident hard-freeze 时，Runtime remediation 只能经独立、bounded、可审计的 maintenance/recovery seam 实施；该 seam 不依赖 NORMAL operational writer，不写 NORMAL PVR/PA，不 revival `PRE_MES_BOOTSTRAP`，不制造 fake Work/Task/Result/Git facts，不建立第二 MES、shadow store 或 controller。
- seam 的 entry basis：current canonical Technical Authority、exact Git branch/HEAD/worktree、root-bound forensic/audit refs、frozen snapshot SHA-256/fact count，以及 Brain 的 bounded recovery authorization。`MES_MAINTENANCE` 的 mode/packet/API/result/ACK/CV/Review/Git lifecycle 由本 Contract §4.2–§5.3、`.agents/contracts/brain/integration.md` 与对应 Role Contracts 闭合，不由 status 或 stale recovery candidate 推导。
- implementation/CV/Review、exact incident regressions、fresh exact-bound recovery candidate 与独立 SPV 完成后，才允许一次 controlled recovery transaction；成功后立即恢复 quarantine，fresh rehydrate/relational audit/restart reconstruction 通过后由 Brain 决定 affected Stage/cycle `resume` / `replan` / `restart`。
- 任一 digest、binding、scope、verification、transaction 或 audit failure 都保持 quarantine、no-write、no retry；maintenance evidence 不是新的 operational state source。
- `MES_MAINTENANCE` 是本 seam 的 branch-specific execution mode，不是第五阶段、MES phase、status、Gate 或第二状态机。仅当 `MES_RECOVERY_REQUIRED` / MES integrity hard-freeze（S06 为已合法闭合的实例）已成立、`.proofloop/mes` physical quarantine、exact frozen snapshot SHA-256/fact count、root-bound forensic/audit refs、current Technical Authority/Git basis、recovery candidate 与 fresh SPV `PLAN_READY` 均可重读，且 Brain 已给出本次 bounded authorization 时可进入；controlled recovery transaction 成功并完成 rehydrate/audit/restart 后该 mode 失效。
- `MES_MAINTENANCE` 的 Work Packet、Task Result/`TASK_RESULT_ACK`、CV 与 maintenance Review 都是 Git + canonical Authority/Plan + immutable forensic/audit/frozen-source 的结构化 Subagent transport evidence；不要求或产生 MES `work_id`、`result_ref`、PVR、PA、Task/Work/Finding/Git operational fact、`STAGE_ACCEPTED` 或 `PROJECT_READY`。Brain 只校验 binding 与 evidence，不为本 lane 组装 snapshot。
- `MES_MAINTENANCE` 复用现有 Worker、Slice-level CV、`slice-output`、Integration 与 Stage Reviewer 的机械能力，但每个 owner 必须走本 mode 的 evidence-only 分支；Git commit/ref 是 Git 事实，不回写 MES。Agent/Brain loss 只能从 current Authority、recovery Plan/Map、Git refs/commits、frozen digest/count、forensic/audit 重建，不能恢复 hidden session 或 Subagent transcript/transport narrative。
### 2.2 写入原则

任何 MES durable fact 至少能回答：

```text
what happened?
to which scope?
under which fact-kind-appropriate candidate/accepted Plan / work identity?
against which Git basis when relevant?
what durable Result/Finding ref supports it?
```

写入只接受：Brain 授权的 semantic event、结构化 Result/Finding、Review verdict、Git 事实（HEAD/branch/worktree/diff）；这些输入经唯一 MES operational transaction layer materialize。
Agent narrative、transport `sent`/`idle`/`done`、
session/transcript 状态、checkbox 或 progress 文本不写入 MES。

Plan binding 经 accepted / candidate Plan 的 `project_stage_map_ref` + `git_basis.head` 间接闭合
current Stage Map entry（§4.1）；Map basis 可从 ref + candidate Git basis 重建，默认不新增独立
Map digest 或 MES fact kind。

**Fact-kind binding rule（按事实类别绑定）：** “under which Plan” 由 fact kind 决定，不把 accepted Plan 作为所有事实的无条件前置：
- Execute / Review 的 Work、Task Result、Finding 与 accepted Stage supporting facts 必须按各自 fact kind 绑定当前 `accepted_plan_ref`、MES `work_id`（如适用）、Technical Authority refs（`tech-spec/architecture.md` / `tech-spec/contracts.md` / `tech-spec/acceptance.md`）与 Git basis；`PROJECT_READY` 按其 terminal relation 的 kind-specific binding 处理，不是独立 Review fact。
- **Transaction ownership rule:** Brain/Host 不提交完整 resulting snapshot，也不负责 retention assembly；MES transaction layer 按 fact kind materialize the semantic event，并在同一 atomic boundary 计算 `submitted ∪ retained`、保留 unrelated facts、解析/校验 canonical relations 和 currentness。正常调用方不得直接调用 raw `MesSnapshotStore` write primitive。
- pre-accept Planning 的 SPV reply 由 Brain 接纳为 `PLANNING_VERIFICATION_RESULT`，绑定 `candidate_plan_ref`，其 `accepted_plan_ref` key 必须存在且为 `null`；它不是 Plan acceptance。
- NORMAL candidate/accepted Plan binding 增加 `delivery_cycle_id`：同一 cycle 的 candidate、accepted、Execute/Review facts 必须保持精确相等；历史 retained facts 可在兼容读取中缺省，但新 NORMAL submission 缺失或变更即 fail closed。`PROJECT_READY` 以自身 `delivery_cycle_id` 绑定 terminal relation，不使用 planned set inclusion、Git HEAD 新旧或 insertion order 选择 current terminal。
- `status` first resolves the unique current cycle from durable facts: a unique open cycle is a cycle-bearing PVR/PA cohort with no legal matching `PROJECT_READY` terminal and takes precedence while work is active; when no open cycle exists, currentness is the unique tip of the validated cycle-bearing terminal succession chain. Same `planned_stage_ids` with different cycle IDs remain separate; legacy terminal facts never become current by inference. Missing, duplicate, cross-cycle, branched, cyclic or otherwise unprovable relations fail closed.
- 只有 `verdict: PLAN_READY` 的 `PLANNING_VERIFICATION_RESULT` 才能产生后续 `PLAN_ACCEPTANCE` fact，将同一 candidate promoted 为 `accepted_plan_ref`；Plan acceptance 之前不得把 candidate 当 accepted。
### 2.2.1 Pre-MES bootstrap binding（一次性）

`PRE_MES_BOOTSTRAP` 是 bounded input/persistence mode，不是 MES phase、status、Gate、Receipt 或第二状态机。它只在 MES persistence 集成并 seed accepted Plan/bootstrap facts 前有效。

- `NORMAL` 的 Execute/Worker/CV Work/Result 仍要求当前 MES work identity、accepted Plan、Technical Authority refs 与 Git basis；Stage Reviewer envelope 按 `.agents/contracts/brain/stage-review.md` 使用 integrated snapshot + accepted Plan/Authority binding，由 Brain 接纳后向 MES operational transaction layer 发起 semantic event；formal Execute/CV/Review Result 由 transaction layer materialize。Planner/SPV pre-accept Planning 使用 candidate Plan binding，按 §2.2.2 先形成 planning verification fact，不把 candidate 当 accepted。
- 初始 Planner bootstrap packet 只要求 canonical Authority refs、baseline/current Git basis 与 `actionToken`；candidate Plan ref 可缺省/nullable，因为 Planner 负责创建 candidate。SPV finding 修复继续绑定 candidate Plan，不得提前称为 accepted Plan。
- `PLAN_READY` 后，Brain 接受 Git-tracked Thin Plan（Git Plan ref + baseline/current HEAD），但在 seed 前不写 MES；仅首个 MES-persistence Stage 可用 bootstrap Worker packet。
- Bootstrap Worker/Planner Result 是结构化 Subagent transport evidence，不是 MES Result，不携带或指向 pre-seed MES `resultRef`；binding = `execution_mode` + Stage/Slice/Task（如适用）+ candidate/accepted Git Plan ref + Technical Authority refs + baseline/current Git basis + `actionToken`。
- Bootstrap 的 durable recovery truth 仍是 Git + Git-tracked Plan facts（candidate/accepted 可用时；`PLAN_READY` 后为 Git-tracked accepted Thin Plan）；结构化 Subagent transport evidence 只作经校验的输入，不创建独立 result store、Receipt、Manifest 或 Gate。MES persistence 集成后 Brain seed accepted Plan/bootstrap facts，随后 `PRE_MES_BOOTSTRAP` 永久禁止，所有 NORMAL Result/Finding/Review/Git operational events 必须经 MES operational transaction layer materialize；MES integrity hard-freeze 期间只允许 Authority-defined maintenance/recovery evidence，不允许 NORMAL operational write。
- Empty project-local MES initialization remains only the one-time `PRE_MES_BOOTSTRAP` path; NORMAL delivery does not add an init CLI/domain, second store, or second Host write-back adapter. If a NORMAL route lacks an initialized root-bound store/seed, Brain returns typed `RUNTIME_BLOCKER` rather than creating an uncontracted lifecycle entry.
### 2.2.2 NORMAL Planning verification 与 Plan acceptance facts

pre-accept SPV 不要求 candidate 已经 accepted。Brain 接纳 SPV reply 时按以下顺序写入两类 durable MES fact，禁止把 status 或未接纳的 Agent narrative 当作 SPV evidence：

```yaml
fact_kind: PLANNING_VERIFICATION_RESULT
result_ref: <MES-generated durable ref>
planning_work_id: <current MES planning work identity>
verifier_role: stage-plan-verifier
candidate_plan_ref: <required pre-accept candidate Thin Plan ref>
scope:
  stage_id: <current Stage>
delivery_cycle_id: <current delivery-cycle identity>
accepted_plan_ref: null
verdict: PLAN_READY | FINDINGS | BLOCKED
finding_refs: []
authority_refs: []
git_basis:
  head: <candidate verification HEAD/ref>
action_token: <SPV dispatch token>
created_by: brain
```

约束：`candidate_plan_ref` 必填；`accepted_plan_ref` 必须存在且为 `null`，不得省略或提前填入 accepted ref；`result_ref` 由 Brain/MES 在接纳 SPV reply 时生成，不是 SPV launch prerequisite。

候选 Plan 的 `project_stage_map_ref` 与同一 candidate `git_basis.head` 构成被验证 current Stage Map
entry 的重建 basis：SPV / Brain 必须能从 candidate Plan + `project_stage_map_ref` + candidate Git
basis 重建被验证的 Map entry，重建失败按 §7 返回 typed blocker / `PLAN_GAP`，不得以 MES status 或
其他 projection 补全 Map basis（无第二 operational state source）。Plan 或 Map material revision
都要求新 tuple 上 fresh full initial SPV。

只有上一条 `PLANNING_VERIFICATION_RESULT.verdict = PLAN_READY` 时，Brain 才能写入：

```yaml
fact_kind: PLAN_ACCEPTANCE
accepted_plan_ref: <candidate_plan_ref promoted to accepted>
source_candidate_plan_ref: <same candidate ref>
verification_result_ref: <PLAN_READY planning verification result ref>
delivery_cycle_id: <same current delivery-cycle identity>
scope:
  stage_id: <current Stage>
authority_refs: []
git_basis:
  head: <verified candidate basis>
accepted_by: brain
```

`PLAN_ACCEPTANCE` 产生后，accepted Plan binding 才对 Execute / CV / Review 生效；`FINDINGS`、`BLOCKED` 或 candidate revision 均不能提前创建 acceptance。

**Planning acceptance generations（append-only succession；见 `tech-spec/architecture.md#/entities/planning-acceptance-succession`）：**

- `PLANNING_VERIFICATION_RESULT` 是 verification evidence：它记录某个 candidate Plan ref + digest 在某个 Git/Authority basis 上的一次独立验证；它不是 accepted planning identity，不参与 current accepted generation 选择。同一 (stage, cycle, plan ref, digest) 允许存在多份 distinct PVR（例如 basis 变化后的 fresh re-verification）；只要每个 generation 的 `verification_result_ref` 精确解析到其 own `PLAN_READY` PVR 且 promotion equality（ref/digest/cycle）成立即可。
- 每个 cycle-bearing `PLAN_ACCEPTANCE` 是一次 accepted Plan generation，并在 envelope 顶层携带 `supersedes_plan_acceptance_ref`：`null` 当且仅当 submitted ∪ retained facts 中不存在该 (stage, `delivery_cycle_id`) 的其它 cycle-bearing generation；否则精确指向当时该 (stage, cycle) 唯一 chain tip 的 `fact_id`。该字段是 `plan_acceptance`-only 顶层字段（position 规则与 `project_ready` 的 terminal-only 字段一致），其它 fact kind 携带即 fail closed。
- 同一 (stage, cycle) 的所有 cycle-bearing generation 必须形成一条 append-only 无环链且恰有一个 tip = current accepted generation。self-reference、missing / non-`plan_acceptance` / 跨 stage / 跨 cycle target、重复 target（branch）、有向环、stale predecessor（不等于 retained tip）与 multiple tip 全部 no-write；status 侧按 currentness oracle 返回 typed `AUTHORITY_GAP`。
- 新 generation 必须绑定 fresh `PLAN_READY` PVR。允许其 `accepted_plan_ref` 乃至 `plan_digest` 与前一 generation 相同（应由 fresh Authority/Git basis 上的独立验证支持）；generation 身份由链结构决定，不由 (ref, digest)、fingerprint、时间戳、插入顺序、Git recency 或 newest-wins 决定。
- retained pre-update 形态（携带 `delivery_cycle_id` 但不携带 predecessor 字段）是只读兼容 root：其自身 acceptance 保持有效并可作为其 own (stage, cycle) 链的 root，但不被 backfill / 改写 / 重新 emit；新写入的 cycle-bearing generation 必须携带该字段，half-new shape 无效而非猜测。无 cycle 的 legacy PVR/PA 保持 history-only，不进入任何 chain。
- 下游 plan-bound facts 通过 accepted binding 的 `verification_result_ref` 绑定其 own generation，并只授权该 generation；绑定旧 generation 的事实保持 immutable、auditable 且 non-authorizing（不得支持 Task/Slice completion、Integration、`STAGE_ACCEPTED`、terminal support closure 或 continuation）。同一 Stage 追加新 generation 后其早前 generation 的 accepted support 不再授权；已由 legal terminal 关闭的 cycle 不接受新 generation（与既有 closed-cycle planning rule 一致）；其它 Stage 不受影响。

### 2.2.3 Brain-owned finding disposition

Verifier 只提交 verdict、finding evidence 与 claim，不拥有最终 workflow classification：

```yaml
verifier_verdict: PASS | FINDINGS | BLOCKED
claimed_route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP
finding_disposition: ACCEPTED | VERIFIER_OVERREACH
accepted_route_code: <legal route code; null when VERIFIER_OVERREACH>
basis_refs: []
reason: <bounded Brain classification reason>
resume_target: <producer | planner | authority-owner | research | recovery | verifier-lane>
created_by: brain
```

Route ownership: `AUTHORITY_GAP` 是 Planning/SPV 在 Product intent → current Technical Authority → grounded current reality handoff closure 中的合法 claimed route；它覆盖 PRD obligation 缺失/矛盾，以及 Product intent 不变但 bounded code/runtime reality 反证 current Technical Authority 的情况。Execute/CV/Stage Reviewer/General repair 的 normal claimed route 不包含 `AUTHORITY_GAP`；实现选择走 `PLAN_GAP`，技术未知走 `TECHNICAL_UNKNOWN`，Authority 完整的 Runtime 问题走 normal repair/planning。

NORMAL 下 Brain 可将上述 arbitration 作为 `FINDING_DISPOSITION` durable MES fact，并绑定 `finding_ref`、`disposition_ref`、`claimed_route_code` 与判定依据。`ACCEPTED` 时真正驱动路由的只有 `accepted_route_code`；`VERIFIER_OVERREACH` 时 `accepted_route_code` 必须为空，不自动触发 producer repair、Replan 或 `HUMAN_REQUIRED`，而是修正 verifier packet/scope/basis 后回 verifier lane。PRE_MES_BOOTSTRAP 不创建 disposition log 或第二 result store；若分类本身丢失，Brain 只从 Git、Authority、Plan 与当前 Finding 重新分类或重新运行 verifier。

<!-- proofloop:entity id="authority-gap-and-update" kind="seam" -->
### 2.2.3a Authority gap and authority-update acceptance
- Formal `AUTHORITY_GAP` remains a Planning/SPV claim and routes through Brain to the current Propose/Technical Authority owner. It is not a generic uncertainty code and does not authorize Execute/CV/Review/General to edit Authority.
- The Authority owner works under the current Propose binding and bounded product-intent scope. Brain must fresh-read the owner output and the canonical four-file package, confirm the package is current/consistent and the exact path set matches Git reality, then accept the update before invoking `authority-update`. The boundary is mechanical Git transaction only; it does not create a new phase, fact kind, Gate, or approval receipt.
- Ordinary Technical Authority repair does not require another user checkpoint. A missing product, permission, or acceptance decision remains `USER_DECISION_REQUIRED`; only Brain confirmation of that gap creates local `HUMAN_REQUIRED`. User presence or lack of a new message is never a continuation prerequisite.


### 2.2.4 HUMAN_REQUIRED 的局部暂停

`HUMAN_REQUIRED` 是 Brain 接纳真实用户决策缺口后形成的 operational pause，不是 verifier 自行 route，也不是全局项目阻塞：
- affected work 进入 paused 状态，`human_required` counter 增加；只有真实 dependency descendants 记录 `blocked_by`，无关 Slice/Task 保持 runnable。
- counter 只进入 status 的 sparse projection；只有当前 runnable frontier 确实依赖该决定，或需要明确 Product/Authority 输入时，Brain 才形成具体 PM decision request。
- 人类输入返回后，先由 canonical owner 吸收，再判断 Authority、accepted Plan、goal/acceptance、dependency graph 或 proof boundary 是否改变；改变时先走 impact-based Replan 和 fresh SPV（如 Plan 改变），仅解除 operational blocker 时才直接 resolve pause、重算依赖并 resume。
- 等待 Replan 的工作不得通过直接清零 `human_required` 伪装成 runnable；应保留明确的 replan/blocked operational fact。
### 2.2.4a MES disaster re-baseline（NORMAL recovery）
`MES_RECOVERY_REQUIRED` is the typed Brain recovery blocker/subtype used when the exact pre-accident MES snapshot cannot be recovered. It is not `PRE_MES_BOOTSTRAP`, not a product decision, and not a new workflow phase. The route remains paused until the recovery baseline is legally established.
- Existing `RECOVERY_REBASELINE` is not sufficient authorization to repair the Runtime writer: its candidate Plan/SPV are recovery evidence only and must not cause NORMAL `PLANNING_VERIFICATION_RESULT`, `PLAN_ACCEPTANCE`, or `recovery_baseline` writes while MES is frozen. Runtime remediation must first use the independent `mes-maintenance-recovery-boundary`; only its closed result may enable the eventual controlled recovery transaction.

The only durable machine shape for this branch is the closed `recovery_baseline` fact:
```yaml
fact_kind: recovery_baseline
recovery_id: <opaque recovery epoch; fact_id is unique for this incident>
preimage_status: UNRECOVERABLE
source_snapshot_sha256: <exact observed pre-write snapshot SHA-256>
source_fact_count: <exact observed pre-write fact count>
forensic_ref: <root-relative immutable forensic incident ref>
audit_ref: <root-relative read-only relational audit ref>
audit_sha256: <SHA-256 of the audit artifact>
authority_refs: [<tech-spec-only recovery refs>]
git_basis:
  head: <current recovery code/authority basis>
  branch: <branch>
  worktree: .
created_by: brain
```
The recovery baseline fact must not carry `scope`, `work_id`, `result_ref`, `plan_binding`, `verifier_role` or `action_token`; it records an incident/baseline epoch, not a Stage or delivery cycle. A NORMAL delivery cycle ID is generated only by the next Propose.

The eventual controlled recovery transaction is atomic and fail-closed: the submitted source digest/count must match the exact currently observed snapshot, forensic and audit refs must be root-bound and re-readable with matching digests, and the recovery epoch must be idempotent. It is executed only after Authority-defined maintenance/recovery implementation, isolated regressions, independent verification/review and fresh exact-bound SPV; it is never a raw full-snapshot write. Invalid refs, stale source, conflicting duplicate, ambiguous retained relations or unknown fields produce no-write. Existing retained facts are not reconstructed or upgraded; they remain history-only until fresh rehydrate + relational audit proves current use. The baseline fact itself is retained across later snapshot replacement/restart.

After a legal baseline write, Brain must immediately re-quarantine the MES directory, fresh rehydrate and re-audit before selecting the affected Stage/cycle `resume`, `replan` or `restart`; any changed Authority/Plan/Map/Git tuple requires a fresh candidate boundary and full SPV.

**Affected Stage/cycle continuation 必须机械可区分且可写：**

- `resume`：current accepted generation 仍 current 且其 binding 未被新 tuple 取代时，不写新的 planning fact；执行继续使用该 generation。若执行事实（Work/Task/Result/Git）不可恢复，则按 `restart` 语义重建执行绑定，不得 backfill 历史事实。
- `replan`：Authority/Plan/Map/Git tuple 变化时，先 fresh Planner → candidate boundary → fresh full initial SPV，然后在同一 delivery cycle 内追加新的 accepted generation（predecessor = 当时 chain tip）；受影响 Slice 的执行事实按新 generation 重建。
- `restart`：Planning tuple 未变时在同一 generation 下重建执行：以 fresh Work identity 重开受影响 Slice 的 lane，prior attempt 的 Work/Task/Result/Git facts 保留为 immutable history 且不构成新 attempt 的 completion / Integration / Review support；Planning tuple 同时变化时先 `replan`。
- 三者都不生成新 `delivery_cycle_id`（新 cycle 只由新的 NORMAL Propose 生成）；都不改写、删除或 backfill 历史 facts；任何 generation/currentness 歧义 fail closed。
- 现有 current code reality 已满足的 obligation 按 §4.1 的 `EXISTING_SEAM` 表达，不通过伪造 Work/Task/Result/Git facts 重建历史。
### 2.3 status 一级视图

Brain / Agent 默认只看到：

```text
scope
phase
required_skill
non-zero anomaly counters
```

正常示例：

```text
S03 / EXECUTE
skill=proofloop-execute
```

存在偏离时才追加非零计数：

```text
S03 / EXECUTE
skill=proofloop-execute
replan=1
blocked=1
```

Sparse anomaly counters（`0` 不显示，`>0` 才显示）：`replan / blocked / repair /
recovery / human_required / finding / cleanup`。一级只显示数量。

### 2.4 status 二级视图

按需下钻 Stage / Slice / Task / Work 明细，允许包含：current work、owner、waiting
verifier、blocked_by、replan/repair/recovery、latest Result/Finding ref、
candidate/integration Git ref、cleanup pending。
Stage detail（如有）只来自 durable Stage facts；status 不读取 Map、生成 Stage graph 或输出 next action / route。

示例：

```text
S03-A  INTEGRATED
S03-B  REPLAN
S03-C  WORKER_DONE / WAITING_CV
S03-D  BLOCKED_BY S03-C
```

MES 不输出"建议下一步"。Verifier 不需要默认读取全量 MES；其 target、Authority/Plan/Git
basis 由 dispatch packet 提供；MES 状态本身不能成为 PASS/FINDING 证据。
- status 的 phase/scope/required_skill 只属于 current operational cycle；没有开始新 cycle 时可以附带历史 `PROJECT_READY` detail。历史 terminal 不单独产生 route/next action，进入新 cycle 只能由新用户工作或实质变更 Routing Boundary 触发。
status 的 current-cycle predicate 先校验 terminal relation，再计算 cycle-bearing PVR/PA 中无合法 matching `PROJECT_READY` 的唯一 `open_cycle_ids`；恰有一个 open cycle 时以其 `delivery_cycle_id` 与 stage-only `scope.stage_id` 取得 current Stage，并按既有 scope 形状过滤 facts（stage-only Review `work`/`result`/`finding` → `REVIEW`；task 或 slice/task-scoped execution fact → `EXECUTE`；否则 `PLANNING`，所有 accepted-stage supports 则为可区分的 pre-terminal `STAGE_ACCEPTED`）。无 open cycle 时以 validated terminal succession chain 的唯一 tip 作为 current legal `PROJECT_READY`；无 chain 时 legacy terminal 仅为 history。缺失/重复/跨 cycle/无 stage provenance/多 open cycle/多 tip/链损坏均 fail closed typed `AUTHORITY_GAP`；`task` fact 不能从 current scope 候选中遗漏；status 不输出 route/next action/Stage graph。

<!-- proofloop:entity id="current-terminal-public-status" kind="seam" -->
### 2.3.1 Current terminal public status
- `PROJECT_READY` remains a delivery/project-level terminal and is not added to the per-Stage phase enum by default.
- When a current cycle or terminal observation is proven, the read-only public status surface must expose a `project_terminal` observation adjunct in both JSON result forms and in the human formatter; `--detail` carries the same adjunct plus the existing bounded Git/Plan detail. The adjunct is projection-only (not a MES fact, phase, route, cache or second store) and has this closed shape:
- Historical-only terminal, current terminal, pre-terminal `STAGE_ACCEPTED`, and duplicate/conflicting/cross-cycle terminal cases remain distinguishable. `CURRENT_PROJECT_READY` carries the exact terminal fact identity and cycle identity; `HISTORICAL_PROJECT_READY` never claims currentness; `PRE_TERMINAL` has no terminal fact and retains the current cycle identity. `PROJECT_READY` is never added to the per-Stage phase enum.

```yaml
project_terminal:
  state: CURRENT_PROJECT_READY | HISTORICAL_PROJECT_READY | PRE_TERMINAL
  project_ready: true | false
  project_ready_ref: <exact project_ready.fact_id; omitted for PRE_TERMINAL>
  delivery_cycle_id: <cycle id; omitted only for legacy HISTORICAL_PROJECT_READY>
  planned_stage_ids: [<ascending canonical Stage IDs>]
  accepted_stage_support_ids: [<ascending canonical Stage IDs>]
  exact_closure: true | false
```
`CURRENT_PROJECT_READY` requires one legal chain-tip terminal, its non-empty cycle ID, exact `project_ready_ref`, exact planned/support closure, and `exact_closure: true`. `PRE_TERMINAL` requires one unique open cycle, omits `project_ready_ref`, uses that cycle ID, has `project_ready: false`, `planned_stage_ids: []`, `accepted_stage_support_ids` from that current cycle, and `exact_closure: false`; if all accepted-stage supports exist before the terminal write, the per-Stage phase remains the distinguishable pre-terminal `STAGE_ACCEPTED`. `HISTORICAL_PROJECT_READY` is used only for a valid terminal that is not current (including legacy/no-cycle history), and does not authorize routing.
Human output renders `project_terminal=<state>`; JSON exposes the object above. `project_ready_ref` is a projection of the durable fact's `fact_id`, not a new pointer.

<!-- proofloop:entity id="current-terminal-currentness-oracle" kind="oracle" -->
#### Current terminal currentness oracle
- **Terminal validation precedes selection:** validate every `project_ready` relation against its own cycle-scoped accepted-stage supports. New cycle-bearing terminals must contain both top-level `delivery_cycle_id` and `supersedes_project_ready_ref` (the latter is `null` or an exact ref); a retained pre-update `legacy_cycle_anchor` may omit only the predecessor field, while a no-cycle legacy terminal omits both. A malformed or half-new submitted terminal is not treated as history.
- **Succession relation:** each non-null `supersedes_project_ready_ref` resolves by exact `fact_id` to one legal cycle-bearing `project_ready` terminal (including a retained `legacy_cycle_anchor`) with a different `delivery_cycle_id`; self-reference, missing/non-terminal target, duplicate target (branch), repeated cycle ID, and directed cycle fail closed. All cycle-bearing terminals in the resulting durable set must form one acyclic chain. The unique current terminal is the sole chain tip (the terminal not referenced by any successor); zero or multiple tips are `AUTHORITY_GAP`. A retained anchor is a compatibility root; a newly written chain root has `supersedes_project_ready_ref: null`.
- **Active-cycle precedence:** `open_cycle_ids` is the distinct set of cycle IDs carried by stage-scoped PVR/PA facts for which no legal matching terminal exists. A cycle-bearing planning cohort with no terminal is open even when all its accepted-stage supports exist; that case projects `PRE_TERMINAL` / `STAGE_ACCEPTED`. More than one open cycle is ambiguous and fails closed. Exactly one open cycle is current and suppresses the older chain-tip terminal from current status.
- **Planning generation currentness:** 对 current cycle 内每个 stage-scoped planning cohort，(stage, cycle) 的 cycle-bearing `plan_acceptance` chain 必须恰有一个 tip = current accepted generation；多 tip、branch、有向环、stale predecessor 或无法从 durable facts 唯一解析 → typed `AUTHORITY_GAP`。candidate `planning_verification_result` 只是 pre-accept evidence，不参与 currentness 选择，因此同一 (stage, cycle) 的多份 candidate revision 不再构成 ambiguity；无 cycle-bearing generation 时该 Stage 处于 pre-accept PLANNING，candidate-only facts 不得被当作 accepted。
- **Completed-cycle selection:** when `open_cycle_ids` is empty, the unique validated chain tip supplies current `PROJECT_READY`. If no cycle-bearing terminal exists, a valid legacy terminal is history-only; status must not fabricate a current cycle. Current selection never consults terminal insertion order, fact ID ordering, Git recency, filenames, Map lookup, timestamp, `actionToken`, transport metadata or a second pointer/state source.
- **Write/recovery closure:** Brain appends a new terminal without mutating an old fact: the first new terminal uses `null` only when no retained cycle-bearing terminal exists; otherwise it references the current chain tip. The MES write boundary validates the complete submitted ∪ retained terminal graph, including compatibility anchors, terminal/support cycle equality, and exact closure atomically; any missing target, duplicate/conflict, cross-cycle edge, branch, cycle, stale tip or unreadable relation is no-write. Snapshot replacement, restart and rehydrate retain the same edge values (including an anchor's omitted predecessor) and therefore reconstruct the same tip.


### 2.5 写入边界

- Brain/Host 是唯一 semantic event initiator / authorization owner；MES operational transaction layer 是唯一 normal durable write owner；Agent 只能通过 structured Result/Finding 返回输入，不能直接写 MES。
- MES 记录 operational 事实，不决定业务动作；route、dispatch、recovery 由 Brain 决定。
- MES 不复制 Authority 正文或 Skill 步骤；这些仍从 canonical path 读取。
- Brain 发起新的 `PROJECT_READY` semantic event 时必须提供该 current cycle 的 top-level `delivery_cycle_id`、planned set、delivery/planning basis 与 `supersedes_project_ready_ref` 候选；MES transaction layer 从 current durable relation 校验 canonical identity，并在 transaction 内完成 predecessor、terminal graph、support closure 与 cycle equality 的 exact validation。若 resulting set 没有 retained cycle-bearing terminal 则 predecessor 为 `null`，否则精确引用当时唯一 chain tip（可为 retained `legacy_cycle_anchor`）。新或变更的 plan-bound NORMAL facts 的 `plan_binding.delivery_cycle_id` 必须与同一 current/open cycle 精确相等；旧 terminal（含 compatibility anchor）不改写、不回算；status 只按 open-cycle 规则或无 open cycle 时的 chain tip 选择。
- 新或变更的 cycle-bearing `PLAN_ACCEPTANCE` 必须携带顶层 `supersedes_plan_acceptance_ref`，其 predecessor 必须是 retained facts 中该 (stage, `delivery_cycle_id`) 的 chain tip（无其它 cycle-bearing generation 时为 `null`）；MES transaction layer 在 submitted ∪ retained 上原子校验 generation chain（target 解析、跨 stage/cycle、branch、环、stale predecessor、multiple tip）与 fresh `PLAN_READY` PVR closure，任一失败 no-write 且保留最后有效 snapshot byte-identical。绑定旧 generation 的下游 facts 不被改写，但按 non-authorizing history 处理；已被 legal terminal 关闭的 cycle 不接受新 generation。
- Recovery/maintenance 输入 = current MES read-only state + exact frozen digest/count + immutable forensic/audit refs + current Technical Authority + exact Git/worktree reality；implementation 不得把 stale `recovery-plan-r2`、current `status` route 或旧 session 当授权。Eventual controlled recovery additionally requires a fresh exact-bound candidate/SPV; never recover hidden conversation/Primary Next Action/credential chain.

## 3. 四阶段流程契约

| Phase | 入口 | 完成信号 | 输出 | 关键 Skill / 角色 |
|---|---|---|---|---|
| Propose | PM + Agent | `PROPOSE_READY`（唯一完成点） | `PRD.md` Product Authority + `tech-spec/` Technical Authority Pack | `ai-structured-prd`、按需 `prd-to-tech-design-prep`、`prd-to-ai-architecture` |
| Planning | `PROPOSE_READY`；`PRE_MES_BOOTSTRAP` 初始可由 stable Git baseline + Authority 进入 | `PLAN_READY`（SPV falsify 后 durable） | Planner/SPV 读取 PRD + tech-spec 完成 handoff；Project Stage Map + current Stage Thin Plan 的 downstream `authority_refs` 只指向 tech-spec Pack；bootstrap 先存 Git-tracked Plan、不写 MES | `proofloop-plan`（Planner runtime role，Planning 方法唯一来源）；按需 `codebase-design`；`stage-plan-verifier`（独立 review-loop Role） |
| Execute | NORMAL：Brain 已完成 `PLAN_ACCEPTANCE`、accepted Plan binding current 且存在 dependency-ready Slice；`PRE_MES_BOOTSTRAP`：仅首个 MES-persistence Stage、以 Brain-accepted Git-tracked Thin Plan 为入口 | `EXECUTION_READY_FOR_REVIEW`（all planned Slices INTEGRATED） | accepted Plan + Technical Authority Pack + current reality；bootstrap Result 为 Git-bound Subagent transport evidence，seed 后恢复 MES | `proofloop-execute`、`worker`、`code-verifier` |
| Review | `EXECUTION_READY_FOR_REVIEW` | `STAGE_ACCEPTED`（三轴 PASS + snapshot binding） | accepted Plan + Technical Authority Pack + integrated current reality；Reviewer 不以 PRD 作为 normal basis | `stage-reviewer` |
| 终态 | current Delivery cycle 的 all Stages accepted | 该 cycle 的 `PROJECT_READY` | PM 提醒；历史 terminal 保留自身 basis | MES / status |


<!-- proofloop:entity id="mes-integrity-recovery-branch" kind="seam" -->
### 3.1 MES integrity recovery branch（非 phase）
- A MES integrity hard-freeze is a higher-priority Brain recovery/integrity blocker over the public `EXECUTE` projection. While active, `status.required_skill` is observation only; no NORMAL Worker/CV/Integration/Review dispatch or NORMAL MES write is legal. Only `MES_MAINTENANCE` evidence-only dispatch is legal after its exact entry tuple and bounded authorization are fresh-verified.
- The branch proceeds Propose/Technical Authority correction → fresh candidate remediation Plan → candidate Git boundary → independent SPV → bounded isolated implementation/CV/Review. It does not modify the frozen S06 accepted Plan/Map or reuse the stale `recovery-plan-r2`.
- Only after all implementation/recovery evidence closes may Brain authorize one controlled recovery transaction through the MES transaction layer, immediately restore quarantine, rehydrate/audit/restart, and make the affected Stage/cycle impact decision. This branch is not `PRE_MES_BOOTSTRAP`, not a new delivery phase, and not a second state machine.
明确不新增：`proofloop-propose`、`planner` Skill、`proofloop-review`。

## 4. Planning artifact 契约（Project Stage Map / Thin Plan / JIT Work Packet schema）

### 4.0 Project Stage Map contract

Project Stage Map 是 project-level Rolling-Wave Planning 的唯一 active map：

```text
canonical path: delivery/project-stage-map.md
writer: Planner only（`proofloop-plan` MAP CHECK）
readers: Brain / Planner / SPV；Execute 仅在需要 project-level ref 时只读
content: Stage id / depends_on / goal / entry criteria / Technical Authority refs（tech-spec-only）
persistence: Git-tracked execution-owned planning artifact
operational state: MES owns it（Map 不缓存 operational readiness，不承担
                    Stage composition / next-stage decision）
```

- Map-absent branch：active Map 不存在时，Planner 在本次 Planning action 内创建首份
  Map 并选定 current dependency-ready Stage（MAP CHECK）；整改 General / Brain / MES
  不代写 Map。Map 存在时，Planner 对 current / future Stage 做 rolling-wave
  review / revise；past `STAGE_ACCEPTED` Stage 的历史 identity / goal / dependency 冻结，
  真实 proof-boundary 失效走现有 impact / Replan / Authority 路径。
- entry criteria 谓词定义契约：entry criteria 是 stable / replayable 的 predicate definition（准入谓词定义）；Project Stage Map 只持久化该谓词定义，不持久化对谓词的当前评估结果（evaluation result）。entry predicate 依据当前 execution_mode 与角色边界允许的当前事实进行求值评估（evaluated using the current facts permitted by the active execution_mode and role boundary；具体事实集合由所选 Host Role Agent 的 execution-mode 规则持有，不扩大 Brain 路由职责，亦不违反 PRE_MES_BOOTSTRAP 不读取/不依赖 MES 的边界），该 evaluation result 仅用于运行时判断 dependency-readiness 与进行 Stage selection，不持久化进 Map。只有对 predicate definition 本身发生实质修改（material change to predicate definition）时才修订 Map；外部当前事实演变导致求值结果在 true/false 间翻转时（current-fact changes that flip true/false），Map 保持不变、不触发 Map revision。
- Map 不是 MES fact/status：planned-Stage 集合（计划事实）在 Map，operational
  readiness / 完成状态在 MES / Git facts（§5.1）；两处不双写。
- 该 branch 同样适用于 `PRE_MES_BOOTSTRAP` 初始 Planning（Git baseline + Authority 驱动，
  不读取 MES）。

### 4.1 Thin Plan

Thin Plan 只保存 current Stage 的 planning/execution facts，并引用 Project Stage Map current entry（不复制 Map 正文）：
`PRE_MES_BOOTSTRAP` 初始/修订时，Thin Plan 是 candidate（创建前可 nullable）；Brain 仅在 SPV 返回 `PLAN_READY` 后采纳为 Git-tracked accepted Thin Plan，seed 前不写 MES。

```yaml
stage: <stage-id>
project_stage_map_ref: <delivery/project-stage-map.md#<stage-entry>>
slices:
  - slice: <slice-id>
    goal: <slice-goal>
    depends_on: [<slice-id>, ...]
    tasks:
      - task: <task-id>
        goal: <task-goal>
        semantic_scope: <bounded description>
        code_anchors: [<root-relative-ref>, ...]
        verification_refs: [<root-relative-ref>, ...]
        done: <done condition>
        stop: <stop condition>
        obligation_state: IMPLEMENTATION_MISSING | EXISTING_SEAM   # closed; default IMPLEMENTATION_MISSING
    authority_refs: [<tech-spec-file>#<section/entity>, ...]
```

- 不复制 canonical Authority 正文；不承载 Receipt/Gate 或 mutable execution state。
- 小粒度 downstream `authority_refs` 使用 stable ref 规则（`tech-spec/architecture.md` / `tech-spec/contracts.md` / `tech-spec/acceptance.md` + section/entity）。
- `project_stage_map_ref` 是 current Stage 对 `delivery/project-stage-map.md` 对应 entry 的稳定 ref
  （canonical file + stage entry）。Map 内容版本由同一 candidate `git_basis.head` 绑定，Thin Plan
  不复制 Map 正文，默认不新增独立 Map digest / MES fact。SPV / Brain 以 ref + candidate Git basis
  重建被验证的 Map entry（重建失败见 §7）。
- `obligation_state` 是 Task 级闭集：`IMPLEMENTATION_MISSING`（默认；需要新的实现/验证工作）或 `EXISTING_SEAM`（该 obligation 由 current snapshot 的既有实现满足）。`EXISTING_SEAM` 必须同时给出可机器复核的 seam（`verification_refs` 的 test/spec/contract ref 与独立 expected result），并在 candidate Git basis 上由 fresh SPV 复核、在 final Stage Review 的 Outcome 轴对 integrated snapshot 重新证明。把需要新实现的工作标为 `EXISTING_SEAM`、或缺少可复核 seam，属伪造 → `PLAN_GAP`（不是 `AUTHORITY_GAP`）。
- Task 级 closure 是 Planning 的语义义务（不新增 Plan schema 字段）：每个 Task 必须自足 —— local closure（goal / semantic scope / code anchors / done & stop）、verification closure（可独立复核的 verification refs 与 oracle）与 future-HOW independence（只凭 Slice goal + 共享 context + 当前 Task + 已接纳 predecessor outputs + bound Authority + code reality 即可正确实现并验证）；SPV 必须显式反证 future-HOW independence，不成立即 `PLAN_GAP`。Task 边界不得机械切碎自然 TDD（RED → implementation → GREEN 属同一个 Task 的 HOW），也不得把需要 future Task body 才能正确实现的 obligation 留在当前 Task。

### 4.2 JIT Work Packet

Task 开始时生成/投影；是 derived execution input，不是 Authority。`NORMAL` 使用 accepted Plan + Technical Authority refs + MES binding；`PRE_MES_BOOTSTRAP`（仅首个 MES-persistence Stage）使用 candidate/accepted Git Plan + Technical Authority/Git binding；`MES_MAINTENANCE` 使用 recovery candidate Plan + current Technical Authority/Git + frozen MES/forensic/audit binding，三者均不由 Worker 自行扩展。每个 current Task 的投影由 Brain running `proofloop-execute` 在 execution boundary 执行：读取完整 accepted Plan、选择当前 dependency-ready Task、只投影该 Task 的 JIT input（Worker 只接收当前 Task，future Task body 不提前披露）。

Packet schema 由本 Authority（Contracts）定义；projection method owner 是 `proofloop-execute`（从
accepted Thin Plan + Technical Authority refs + MES / Git / current dependency outputs 投影；bootstrap 从 Git / Technical Authority binding 投影；maintenance 从 recovery candidate + current Technical Authority/Git + frozen/forensic/audit binding 投影。projection 由 Brain running `proofloop-execute` 逐 Step 执行；Worker 不自行选择 successor，也不重组 future Task。Planner 只提供投影所需 planning facts（`project_stage_map_ref`、Stage / Slice / Task goal、dependency / boundary、verification oracle），不拥有 packet schema 或 projection。

```yaml
execution_mode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
stage: <stage-id>
slice: <slice-id>
task: <task-id>
plan_ref: <NORMAL=accepted plan; PRE_MES_BOOTSTRAP=candidate/accepted Git Plan ref; MES_MAINTENANCE=recovery candidate Thin Plan ref（不等同 S06 accepted Plan）>
authority_refs: [<tech-spec-file>#<section/entity>, ...]
maintenance_binding:  # MES_MAINTENANCE only; omitted for NORMAL/PRE_MES_BOOTSTRAP
  frozen_snapshot_ref: <root-relative-frozen-MES-snapshot>
  frozen_snapshot_sha256: <exact-source-sha256>
  frozen_fact_count: <exact-source-fact-count>
  forensic_ref: <root-relative-immutable-incident-ref>
  forensic_sha256: <exact-incident-sha256>
  audit_ref: <root-relative-read-only-audit-ref>
  audit_sha256: <exact-audit-sha256>
code_anchors: [<root-relative-ref>, ...]
allowed_scope: [<root-relative-path>, ...]
dependency_outputs: [<ref>, ...]
done_criteria: <condition>
stop_conditions: <condition>
required_skills: [<role/capability-skill>, ...]
git_worktree_basis: <ref>
actionToken: <current-dispatch-token>
```
- `MES_MAINTENANCE` packet 的 `maintenance_binding` 字段为必填且只允许本 mode；其 frozen snapshot/forensic/audit refs 必须 root-bound、可重读并与 exact digests/count 匹配。`plan_ref` 在本 mode 中指 recovery candidate Thin Plan，不得指向被冻结的 S06 accepted Plan。
- `MES_MAINTENANCE` 的 Brain authorization 由本次 bounded dispatch 形成，不是 durable MES credential；Worker Result、ACK、CV、slice-output、Integration 与 maintenance Review 均必须把 Git/Subagent transport evidence 交回 Brain，禁止调用 normal MES writer。

- bounded Repair Work Packet 只包含 Brain 给出的 bounded repair scope。

### 4.3 Worker Task Result acceptance barrier

Worker 在一个 Slice lane 内逐 current Task 实现，但 successor 只能消费 Brain 已校验并 durable 接纳的 predecessor Result。每次 Task Result 传输后，Brain 返回一个非 durable、closed 的 ACK：

```yaml
kind: TASK_RESULT_ACK
executionMode: NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE
stageId: <stage-id>
sliceId: <slice-id>
taskId: <task-id>
actionToken: <current Slice-lane dispatch token>
resultId: <opaque id from submitted Task Result>
resultDisposition: ACCEPTED | REJECTED
continuationDisposition: CONTINUE | PAUSE
acceptedResultRef: <NORMAL: MES result ref when ACCEPTED; otherwise omitted>
validatedGitBasis: <same Git/worktree basis validated from Result/evidence>
reasonCode: <required when REJECTED or PAUSE; otherwise omitted>
```

合法组合只有：`ACCEPTED + CONTINUE`、`ACCEPTED + PAUSE` 与 `REJECTED + PAUSE`；`REJECTED + CONTINUE` 无效。对 `NORMAL`，ACCEPTED Result 才成为 MES 事实；对 `PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE`，ACCEPTED 只表示 Brain 接纳 Git/Subagent transport evidence，不成为 MES 事实。ACK 不得包含 `next_task_id`、`next_action`、`recommended_action`、producer instruction、Receipt、Gate 或 admission credential。

闭集约束：`NORMAL + ACCEPTED` 必须有 `acceptedResultRef`；`PRE_MES_BOOTSTRAP` 与 `MES_MAINTENANCE` 的 evidence-only `ACCEPTED` 以及所有 `REJECTED` 禁止该字段；`validatedGitBasis` 必填且必须等于已校验的 submitted Result/evidence basis；`REJECTED` 或 `PAUSE` 必须有 `reasonCode`；`ACCEPTED + CONTINUE` 不得有 `reasonCode`；unknown key 直接 invalid/no-write。

`actionToken` 是 Brain 为 Slice lane 分配的 opaque token：同一合法 lane 的多个 Task Result 复用它；每个 Slice-lane binding 的 `NEW`/`FRESH`/`RECOVERY-new-lane`（含 rebind 建立新 lane）都要求该 lane 的 actionToken 唯一，不得复用其他 lane 的 token；fresh/recovery/rebind 建立新 lane 后旧 token stale。Worker 为每次新 Result attempt 创建 `resultId`；同一 payload 重放复用原 `resultId`，被拒后的修正 attempt 才创建新 id。相同 `resultId` 与相同 binding/payload 重放必须幂等返回原 disposition，不重复写 `TASK_COMPLETE`；相同 id 不同 payload 返回 `RESULT_INVALID`；stale token 返回 `RESULT_BINDING_MISMATCH`。
`actionToken` 的具体来源是 Brain/Host 在 NEW/FRESH/RECOVERY-new-lane（含 rebind 建立新 lane）dispatch/lane binding 时新生成的 opaque token，并写入当前 dispatch packet；同一合法 lane 的多个 Task Result 复用同一 token，旧 lane token 在建立新 lane 后 stale，已 durable accepted 的 MES facts 不因轮换失效。Agent 不生成、不裁剪、不从 transport message id、Subagent type、agent_id、session_id、transcript 或 transport id 派生/替代 token；`subagent/1` outer envelope 保持 opaque，仅作 transport。不新增本地 token generator、durable token store、第二状态机或业务状态。
Host/Brain 无法证明当前新 lane token 对该 lane binding 唯一时 fail closed：返回现有 typed `RUNTIME_BLOCKER` 或 `RESULT_BINDING_MISMATCH`，不接纳 Result、不写入事实；不得发明与既有错误码体系冲突的新业务状态。

Brain 只确认 Result 是否接纳以及 lane 是否继续；ACK 本身不携带 next-task directive。每次 `ACCEPTED + CONTINUE` 后，由 Brain running `proofloop-execute` 从当前 mode 绑定的 recovery/accepted Plan 的稳定 task order 中选择第一个同时满足 incomplete、所有 dependencies 具有已接纳 predecessor evidence、scope/binding current 的 Task，并把该 Task 的 JIT input 投影给同一 Worker；Worker 只执行该 current Task，不自行选择 successor。`NORMAL` 的 predecessor 需 durable MES output，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 的 predecessor 可由 Git + Git-tracked Plan/evidence 重建。任何 predecessor 未被当前 mode 接纳时，successor 不得启动。ACK 丢失或 Brain 重启时，NORMAL 从 MES 重建；PRE_MES_BOOTSTRAP 从 Git/Plan/evidence 重建；MES_MAINTENANCE 从 recovery Plan、Git refs/commits、frozen digest/count 与 forensic/audit 重建，不创建 ack-log、maintenance result store 或第二 result store。
`EXISTING_SEAM` obligation 是 satisfied predecessor：其 evidence 是 current snapshot 中可重读的 machine-verifiable seam（pre-accept SPV 复核、Stage Review 对 integrated snapshot 重新证明），因此该 Task、以及仅由该类 Task 组成的 Slice，不要求 Work/Task/Result/Git completion facts，也不阻塞 `EXECUTION_READY_FOR_REVIEW`；其 seam 若无法证明 obligation，按 §7 返回 `PLAN_GAP` / `RESULT_INVALID`（不得静默通过），且不得作为跳过真实实现工作的依据。
## 5. 状态模型

### 5.1 MES 阶段状态（per Stage）

```text
PROPOSE → PLANNING → EXECUTE → REVIEW → STAGE_ACCEPTED
```

`all planned Stages` 的计划集合来自 active Project Stage Map（§4.0，writer=Planner）；
每个 Stage 的 operational state（上表状态机）来自 MES。Map 不缓存 operational
readiness，MES 不生成 Stage graph / next-stage decision（PRD FR-003 / FR-004）。

- `NORMAL` Stage 状态由 MES transaction layer materialize 的事实记录；`PRE_MES_BOOTSTRAP` 不创建 Stage MES 状态，bootstrap 进度由 Git + Git-tracked Plan/evidence 核对；`MES_MAINTENANCE` 同样不创建或推进任何 MES Stage 状态。`STAGE_ACCEPTED` 仍须三轴 Review PASS + snapshot binding 后由 Brain 发起 semantic event、由 transaction layer materialize 现有 accepted `stage` fact，并使用既有 `result_ref`、Plan binding 与 Git basis 支持；不新增 Review 专属 Stage 字段。
- Slice 状态：`EXECUTING → SLICE_CANDIDATE_READY → CV_PASSED / READY_TO_INTEGRATE →
  INTEGRATED → CLEANUP_PENDING → CLEANED`；CV PASS ≠ INTEGRATED；
  cleanup failure 不回退 `INTEGRATED`。
- `NORMAL` Task 状态：`PLANNED → IN_PROGRESS → TASK_RESULT_SUBMITTED → TASK_COMPLETE`；只有 Result 经 Brain 校验/授权、MES transaction layer materialize 并返回 `TASK_RESULT_ACK.resultDisposition: ACCEPTED` 后才是 `TASK_COMPLETE`。`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` Task progression 仅由 Git + Git-tracked Plan/evidence 核对，不写 MES；任一 successor 必须等待当前 mode 已接纳的 predecessor output，successor 由 Brain running `proofloop-execute` 按 Thin Plan 稳定顺序选择并投影给同一 Worker；replan 分类 Task-local / Slice-wide 决定哪些 Task 成果保持有效。
- 全部 planned Slices `INTEGRATED` → `EXECUTION_READY_FOR_REVIEW`。
- all planned Stages（计划集合来自 active Project Stage Map，§4.0）均有 durable `STAGE_ACCEPTED` stage fact 时，Brain 发起 `PROJECT_READY` semantic event，由 MES transaction layer materialize terminal fact；具体 kind/字段由 MES Contract 与 Runtime owner 决定，MES 不生成 Stage graph。
- New NORMAL `PROJECT_READY` terminal must carry top-level `delivery_cycle_id` and `supersedes_project_ready_ref`（无 retained cycle-bearing terminal 时为 `null`，否则指向唯一前序 chain tip），并以自身 cycle-scoped accepted-stage support 精确闭合；legacy/no-cycle terminal 与 retained `legacy_cycle_anchor` 不回写。
- Planning continuation（同 cycle）：`resume` 不写新 generation；`replan` 在同一 cycle 追加 accepted generation（fresh Planner/SPV + 顶层 `supersedes_plan_acceptance_ref`）；`restart` 在同一 generation 下以 fresh Work identity 重建执行事实，prior attempt 事实保持 non-authorizing history。`EXISTING_SEAM` obligation 不产生 Work/Task/Result/Git facts，其证据是 current snapshot seam，并由 Stage Review 在 integrated snapshot 上重新证明。


### 5.1.1 Pre-MES bootstrap control branch

`PRE_MES_BOOTSTRAP` 不新增 MES 阶段状态；它是 seed 前的 bounded execution mode。初始 Planning 由 Git baseline + canonical Authority + candidate Plan（可 nullable）驱动，Map-absent 时由 Planner 创建首份公共 Map（§4.0）；`PLAN_READY` 由 Brain 采纳为 Git-tracked Thin Plan，不写 MES。仅首个 MES-persistence Stage 可用 bootstrap Worker packet/Subagent transport evidence；其余 Stage 不得进入该分支。

MES persistence 集成并 seed accepted Plan/bootstrap facts 后，Brain 永久关闭 `PRE_MES_BOOTSTRAP`，再按 `PROPOSE → PLANNING → EXECUTE → REVIEW → STAGE_ACCEPTED` 的正常 MES 状态模型推进；bootstrap evidence 不形成 MES Result 或状态迁移。
### 5.1.2 MES maintenance implementation branch
`MES_MAINTENANCE` 是 MES integrity hard-freeze 成立时的 branch-specific execution mode，不新增 MES Stage/Slice/Task 状态。它按 recovery candidate Plan + current Technical Authority/Git + frozen/forensic/audit binding 启动 Worker，经过 evidence-only Task ACK、Slice CV、`slice-output`、机械 Integration 与 maintenance Review；所有产出是 Git/结构化 Subagent transport evidence，不形成 MES Work/Task/Result/Finding/Git facts，且不能产生 `INTEGRATED`、`CLEANED`、`STAGE_ACCEPTED` 或 `PROJECT_READY`。全部 maintenance evidence 关闭后，Brain 才可进入单次 controlled recovery transaction。
### 5.2 Agent lifecycle state machine

| Mode | States | Valid transitions | Invalid transition behavior |
|---|---|---|---|
| one-shot | `NEW → DISPATCHED → RESULT_RECEIVED → CLOSED` | General/Researcher bounded request | 缺 Result、Subagent transport failure 或绑定错误 → typed blocker/no-write |
| continuation | `NEW → DISPATCHED → TASK_RESULT_SUBMITTED → TASK_COMPLETE → CONTINUABLE → DISPATCHED ... → CLOSED` | Worker/Prototype；NORMAL Worker 只有在 Brain ACK `ACCEPTED` 后继续（successor current Task 由 Brain/Execute 选择并投影），MES_MAINTENANCE Worker 在 Brain evidence ACK `ACCEPTED` 后继续，binding 和 identity 未变 | binding/identity/snapshot/recovery tuple 变化或 predecessor output 未被当前 mode 接纳 → 不续接，进入 recovery/fresh |
| review-loop | `NEW → INITIAL_REVIEW → FINDING → CLAIM_CLARIFICATION? → DISPOSITION → REPAIR/RECHECK → PASS/READY/ACCEPTED` | CV/SPV/Stage Reviewer；初审先于 clarification；Brain owns disposition；MES_MAINTENANCE Review 的 PASS 是 evidence-only，不转为 Stage acceptance | Reviewer 改 artifact、target/basis 变化、clean-room 或 session trust 丢失 → reset fresh review |
| recovery | `LOSS_DETECTED → REHYDRATE → RECOVER/REUSE/FRESH → RESULT_REVALIDATE` | 仅依据 durable Git/Plan/Authority/forensic/audit facts；MES_MAINTENANCE 不依赖 hidden session | facts 不足或不一致 → typed blocker，不恢复 hidden reasoning |

Reviewer invariants：initial review 在 finding/claim clarification 前独立完成；Reviewer 全程 read-only；claim clarification 只澄清 problem claim、evidence 与 normative basis，不讨论 implementation HOW；Brain 负责 semantic disposition authorization；formal NORMAL Result 由 MES transaction layer materialize；`MES_MAINTENANCE` Result 仅为 evidence，不进入 MES；同一 Reviewer 只有在 review target/basis、binding 和 identity 仍 current 时才可 bounded recheck。

### 5.3 Git worktree lifecycle（per Slice）
```text
create isolated worktree
→ Worker implementation
→ live CV basis（Slice worktree branch/ref + current HEAD + current diff；非 durable candidate ref）
→ CV（initial；FINDINGS 则在同一 live CV basis bounded repair/recheck）
→ CV PASS
→ Brain freeze producer writes + fresh-read live CV basis
→ slice-output（post-CV-PASS，一次性建立 candidate commit）
→ durable canonical candidate ref（proofloop-<stage>-<slice>）
→ READY_TO_INTEGRATE → close live Worker/CV lifecycle
→ Brain/Host integration
→ INTEGRATED
→ CLEANUP_PENDING → CLEANED
```

```text
MES_MAINTENANCE（仅 MES integrity hard-freeze 成立期间；以下全部为 Git/Subagent transport evidence，不推进 MES 状态）
→ create isolated maintenance worktree
→ Worker evidence-only Task loop / ACK
→ live CV basis → CV initial/recheck
→ Brain freeze producer writes + fresh-read
→ slice-output（Git candidate ref）
→ mechanical Integration（Git commit/ref only）
→ cleanup evidence → maintenance Review（evidence-only）
→ Brain fresh-read all evidence → controlled recovery transaction
```

- CV PASS 不等于 INTEGRATED；Integration 由 Brain/Host 管理。
- `live CV basis` 由 Slice worktree branch/ref、当前 HEAD 与当前 diff 组成；它不等同于 durable canonical candidate ref。
- canonical `proofloop-<stage>-<slice>` candidate ref 只由最终 CV PASS 后的 `slice-output` 建立；ref 已存在且指向其他 commit 时必须 fail closed，不得覆盖、删除重建或通过 `direct-fix` 搬运。
- `Brain freeze producer writes` 是进入 `slice-output` 前的操作前置，不新增生命周期状态；Worker/CV 仅在 candidate ref durable 且达到 `READY_TO_INTEGRATE` 后关闭。
- Git 写操作只经机械 `boundary close`、`integration apply` CLI 或等价机械事务；Brain/Agent 不直接
  `git add`/`git commit`。
- 机械安全（dirty gate、allowed-path staging、protected `.git`/internal path、
  pre/post 一致性检查）保留；Gate/Review/Receipt/Manifest 不构成 business precondition。

### 5.4 Subagent dispatch identity

```text
ROLE_SELECTED → SUBAGENT_TYPE_BOUND → SESSION_CREATED → AGENT_ACTIVE → RESULT_RETRIEVED → CLOSED
```

- Brain/Host establishes `subagent_type := role_skill`; selected Host dispatch receives `name`, actual `session` ID and `subagent_type`, then reads its native config: Pi `.pi/agents/*.md + .pi/subagents.json` or OpenCode `.opencode/agents/*.md`.
- Host dispatch config 是 versioned Host adapter config：Pi `.pi/agents/*.md + .pi/subagents.json`，OpenCode `.opencode/agents/*.md`；这些文件 Git tracked、not ignored，正常修改产生 Git diff，但不是 MES / Plan / SPV / CV / Review currentness 输入。干净 checkout 必须包含所选 Host 的版本化配置；Host 配置缺失或非法时按既有 typed 语义阻断。
- 缺失或非法所选 Host config 仍 fail closed 为既有 typed `RUNTIME_BLOCKER`；不新增默认值猜测、fallback、retry、quota detection、自动 model routing、Profile/Pool/alias/mapping layer 或第二业务 workflow/Result/Authority source。
- Pi `.pi/agents/*.md + .pi/subagents.json` 的 JSON/entry/variant/runtime schema 与 OpenCode `.opencode/agents/*.md` 的 frontmatter/permission/entry/variant/runtime schema 均由各自 Subagent host adapter 拥有；ProofLoop 不定义或复制 Profile/Pool/round-robin parser。
- 每次 `new`、`recovery` 或 `fresh` dispatch 都重新建立 identity binding 并由 Subagent host adapter fresh-read 当前配置；运行中的 Agent 不热切换 runtime/model。
- Pi `Agent`/`resume`/`get_subagent_result` 或 OpenCode child dispatch/session/result retrieval 失败返回 `RUNTIME_BLOCKER` 或既有 Subagent transport typed blocker；不 fallback、retry 或换 role。

## 6. 文件与制品契约


### 6.0 Authority / progress separation（governance）

Canonical Authority 定义 intended behavior、constraints、contracts 与 acceptance semantics。

```text
Canonical Authority defines intended behavior, constraints, contracts
and acceptance semantics.

Canonical Authority MUST NOT track mutable implementation progress
or delivery completion.

Operational delivery state belongs to MES/Git facts.
Human-readable progress may be projected into progress.md or
CONTEXT.md, but those files are not downstream Authority.
```

- Architecture / Acceptance 只引用本规则（`tech-spec/contracts.md` §6.0），不复制长正文。
- Stage 完成只写 MES，并可刷新 `progress.md`；不得因 Stage 进度变化触发 Authority synchronization。
- Project Stage Map 是 execution-owned planning artifact（§6 表格行）：planned-Stage 集合（计划事实）
  在 Map，operational readiness / 完成状态在 MES / Git facts，两者不双写（PRD FR-003）。
| Path | Producer | Consumer | Format | Required fields/content | Lifecycle | Validation |
|---|---|---|---|---|---|---|
| `PRD.md` | Propose（`ai-structured-prd`） | Planning / SPV 只读；Execute / CV / Review 不作为 normal Authority 输入 | Markdown | Product Authority：目标、场景、FR、Scope、Decision ledger | 随产品决策更新 | 单一 canonical owner；`PLAN_READY` 前由 Planning/SPV 完成 handoff |
| `tech-spec/architecture.md` | Propose（`prd-to-ai-architecture`） | Planning / Execute / Review 只读 | Markdown | Architecture Authority：四阶段、MES/status、host-local Brain control plane、Hard Parts / Forbidden Shortcuts、ADR | 随架构决策更新 | 同上 |
| `tech-spec/contracts.md` | Propose | 执行与验证 | Markdown | Contracts Authority：MES facts、status、Thin Plan / Work Packet schema、错误契约，以及 Review / Finding / terminal durable relation semantics；Review envelope schema 不在本文件定义 | 随契约变更更新 | 同上 |
| `tech-spec/acceptance.md` | Propose | CV / SPV / Stage Reviewer | Markdown | Acceptance Authority：traceability、E2E、静态检查 | 随验收定义更新 | 同上 |
| `delivery/project-stage-map.md` | Planner（`proofloop-plan` MAP CHECK，唯一 writer） | Brain / Planner / SPV；Execute 仅在需要 project-level ref 时只读 | Markdown | Git-tracked execution-owned planning artifact：Stage id / depends_on / goal / entry criteria / Technical Authority refs（tech-spec-only） | 随 Stage 规划 / Replan 更新（writer=Planner only） | 非 Authority、非 MES fact/status；不缓存 operational readiness；Map-absent 时由首次 Planning 创建，整改 General / Brain / MES 不代写 |
| `CONTEXT.md` | Brain / Working Memory | 人工参考；Worker / capability Skill（读取非规范术语、命名与共享词汇） | Markdown | 当前执行上下文；不是 Authority。供 Worker/capability 读取非规范 terminology/naming/shared vocabulary，保持术语与接口表达一致 | 不进入 downstream Authority | 禁止被当 Authority；不得进入 authority_refs、scope authorization、currentness binding 或 acceptance basis，也不能覆盖 Plan/bound normative refs/code reality |
| `.agents/contracts/brain/mes.md` | Brain semantic initiation/authorization、MES transaction layer durable materialization、binding/relation validation、status 一级/二级、异常计数、`PRE_MES_BOOTSTRAP` 与 recovery seam 语义 | Brain/Host、Host Role documents、Runtime transaction owner | Markdown | MES 不做 reasoning；Agent 不直接写；`MesSnapshotStore` 只为内部 persistence；bootstrap 不声称 MES facts；status 不输出 next action |
| Host Agent role documents | 项目维护者 | 对应 Host 的 Subagent Role | Markdown/frontmatter | goal、entry、procedure、mode/branch、mutation boundary、forbidden actions、capability skills、completion、result discipline 与 native config | Pi/OpenCode 各自版本化；同一 Host role 只保留一份 | Role procedure 不再放在共享 Skill；不得含第二业务 authority |
| `.pi/agents/*.md + .pi/subagents.json` | Pi Subagent host adapter | Pi Subagent host dispatch | Markdown/JSON | versioned role settings and host settings keyed by `subagent_type`; 不是 MES/Plan/Result authority，也不是 currentness 输入 | 每次 Pi dispatch 读取；运行中不热切换；由 Git 跟踪，业务 boundary 不应把 Host 配置变更混入 | ProofLoop 只验证 `role_skill == subagent_type`，不复制 Pi host schema；缺失/非法 → 既有 typed `RUNTIME_BLOCKER`（no fallback/retry/second business source） |
| `.opencode/agents/*.md` | OpenCode Subagent host adapter | OpenCode native `task` child dispatch | Markdown/frontmatter | versioned role wrapper、`permission` map、model/variant keyed by basename `subagent_type`; 不是 MES/Plan/Result authority，也不是 currentness 输入 | 每次 OpenCode dispatch 读取；运行中不热切换；由 Git 跟踪，业务 boundary 不应把 Host 配置变更混入 | ProofLoop 只验证 `role_skill == subagent_type`，不复制 OpenCode host schema；缺失/非法 → 既有 typed `RUNTIME_BLOCKER`（no fallback/retry/second business source） |
| `.agents/contracts/brain/agent-lifecycle.md` | Brain architecture | Brain/Host、Host Role documents | Markdown Contract | branch-scoped one-shot、continuation、review-loop、`execution_mode`、Result validation、recall、session loss、recovery | 与生命周期变更同步 | 每个事务只验证自己的 currentness basis |
| Host Brain documents | Brain architecture | Pi/OpenCode Brain | Markdown | `.opencode/agents/brain.md` 与 `.pi/brain-workflow.md` 各自包含完整 route/dispatch/recovery workflow；不再有独立 workflow Contract | 与两侧流程语义同步 | Host 文档不创建第二 controller 或 Runtime schema |
| `.pi/extensions/proofloop-mode.ts` | Pi Brain host | Pi Brain host | TypeScript | 只负责 `/brain` / `/standard` mode persistence、session restore 和加载 `.pi/brain-workflow.md`；不创建第二 route/controller | 版本化；Pi host entry | 不定义 role procedure、不写 Runtime schema |
| `.opencode/agents/brain.md` | OpenCode Brain | OpenCode primary Brain | Markdown/frontmatter | 完整 Brain route、dispatch、recovery、native permission 和 OpenCode `task` transport | 版本化；唯一 OpenCode primary | 不写 MES/Plan/Result schema，不创建第二 controller |
| `.proofloop/runtime.lock` | Runtime bootstrap | Runtime/CLI | JSON | Runtime/schema/capability lock 字段 | 版本不兼容 fail closed | Kernel `validateRuntimeLock` |
| MES durable facts | Runtime MES transaction layer + Brain semantic authorization | Brain/Host、status、recovery audit | Root-bound JSON snapshot + seed record；normal semantic events materialized through one atomic transaction；recovery baseline only through authorized controlled recovery window | Project/Stage/Slice/Task/Work/Result/Finding/Plan binding/Git refs/Review/PROJECT_READY；invalid immutable history remains readable/non-authorizing | durable；restart 可恢复 | strict schema/binding/relation validation；preserve unrelated facts；no raw full-snapshot normal writer；Agent 不直接写 MES |
| Git worktree/index | Boundary / Integration CLI | Runtime/Brain | Git facts | expected HEAD/branch、scope、changed files | Boundary/Integration transaction | 只能经机械 `boundary close`、`integration apply` 或等价机械事务写入 |

旧 `.proofloop/manifests/**`、`.proofloop/context/**`、`.proofloop/receipts/**`
credential 语义已整体退役，不作为新流程 correctness authority；
普通测试结果 / Reviewer evidence / RED-GREEN Evidence 等证据数据不受影响。

## 7. 错误契约

| Error source | Typed outcome | User-visible behavior | No-write / recovery rule |
|---|---|---|---|
| Dispatch identity / Subagent dispatch invalid | `RUNTIME_BLOCKER` | 指出 `role_skill` / `subagent_type` / session / Subagent host adapter subagent-dispatch 原因 | 不启动 Agent；不写 MES；修正 config/transport 后重新 dispatch |
| Subagent host start/session 能力不可用 | `RUNTIME_BLOCKER` | 保留 Host/Subagent host 原因 | 不写 MES authority；按 recovery 处理 |
| Pi `Agent` / OpenCode child dispatch / continuation / native result retrieval 失败 | `RUNTIME_BLOCKER`（detail: Subagent transport operation） | 原始失败可诊断 | 不 fallback、不 retry、不换 transport；重新读取 durable facts 后选择 recovery/fresh |
| Result 缺失/截断/重复 | `RESULT_INVALID` | 阻断当前 action | 不写入 MES；重读 durable facts |
| Result binding 不符 | `RESULT_BINDING_MISMATCH` | 指出 Stage/Slice/Task/Plan/digest mismatch | no-write；重新生成 Work Packet/dispatch |
| `MES_MAINTENANCE` packet 缺 frozen/forensic/audit digest、recovery candidate、current Authority/Git basis，或 quarantine/Brain bounded authorization 不可证明 | `RESULT_BINDING_MISMATCH` / `RUNTIME_BLOCKER` | 阻断 maintenance Worker/CV/Review dispatch | no-write；不得降级 NORMAL、复活 `PRE_MES_BOOTSTRAP` 或使用 public status route |
| `MES_MAINTENANCE` Result/ACK/CV/Review 携带 MES `work_id`/`resultRef` 或试图 materialize normal operational state | `RESULT_INVALID` | 阻断当前 lane | 保留 Git/Subagent transport evidence；不写 MES、不产生 Task/Work/Finding/Stage/terminal fact |
| controlled recovery / rehydrate/audit/restart 完成后仍请求 `MES_MAINTENANCE` | `LIFECYCLE_CONTINUATION_BLOCKED` | maintenance lane 失效 | 重新按 NORMAL lifecycle 判断，不使用旧 maintenance token/session |
| NORMAL pre-accept SPV 缺少 candidate 或提前要求 accepted Plan | `RESULT_BINDING_MISMATCH` / `PLAN_GAP` | candidate 与 Git basis 不闭合 | no-write；重新建立 candidate verification |
| SPV / Brain 无法从 candidate Plan + `project_stage_map_ref` + candidate Git basis 重建被验证的 current Stage Map entry | `PLAN_GAP` | 指出缺失 / 不一致的 Map entry 或 Git basis | no-write；Planner 修正 ref 或提供同 basis Map entry 后重建 verification |
| `TASK_RESULT_ACK` 字段/组合非法、unknown key 或 predecessor 未接纳 | `RESULT_INVALID` / `RESULT_BINDING_MISMATCH` | 当前 Slice lane 暂停 | 不写 `TASK_COMPLETE`；按 resultId/actionToken 恢复 |
| verifier finding 的 route claim 未被 Authority/Plan/scope 支持 | `VERIFIER_OVERREACH`（Brain disposition） | 保留原 Finding，修正 verifier lane | 不自动 repair/Replan/HUMAN_REQUIRED；重新验证 packet/basis |
| Brain 接纳真实用户决策缺口 | `HUMAN_REQUIRED`（operational pause） | 仅影响 work 与真实 dependency descendants | 无关 Slice/Task 继续；resolution 后按 impact 选择 Replan 或 operational resume |
| continuation 条件不满足 | `LIFECYCLE_CONTINUATION_BLOCKED` | 不错误续接 | 进入 recover/fresh，而不是新造旧事实 |
| review trust/target 失效 | `REVIEW_RESET_REQUIRED` | 当前 cycle 失效 | fresh Reviewer 独立初审 |
| SPV/CV/Stage Review finding | structured Finding → Brain | finding 是 evidence | Brain 分类后 route（repair / Replan / Propose / Research/Prototype） |
| Plan seam 不明确 | `PLAN_GAP` /（仅 Planning/SPV handoff closure或 grounded Technical Authority invalidation 时）`AUTHORITY_GAP` | 返回 Brain | downstream 不直接 claim `AUTHORITY_GAP` 或问 PM；Planning/SPV 重读 PRD、tech-spec 与 bounded current reality，Brain 路由 Propose owner |
| Review relation / axis binding 非法 | `RESULT_INVALID` / `RESULT_BINDING_MISMATCH` | 指出 axis no-masking、snapshot 或 accepted Plan mismatch | no-write；不得以 narrative、Plan 或 status 补全；重读当前 Contract 与 binding |
| `STAGE_ACCEPTED` / `PROJECT_READY` 缺 durable 支撑或 snapshot replacement 丢 support fact | `RESULT_INVALID` | terminal relation/retention 不闭合 | no-write；保留既有 support facts，restart 后重新校验 |
| MES 写入非法输入 | reject（no-write） | 指出非法来源 | Agent narrative / Subagent transport status / session 状态不入 MES |
| 旧 `subagent`/relay 被调用 | `HOST.PATH_RETIRED` | 指明旧路径已退役 | 不执行 fallback；静态检查记录残留 |
| `PROJECT_READY` planned Stage set 缺失、重复、未排序或与该 terminal 自身 durable accepted support 不等 | `RESULT_INVALID` / `RESULT_BINDING_MISMATCH` | 当前 terminal 的 planned set 与 accepted-stage support 不闭合 | no-write；MES 不读取 Map，不丢失历史 terminal 支持事实；后续 cycle 不改写旧 terminal |
| `PROJECT_READY` terminal succession/currentness 缺失、重复、冲突、分支、循环、悬空 target 或无法从 durable facts 证明唯一 tip | status：`AUTHORITY_GAP`；MES write：`RESULT_INVALID` / `RESULT_BINDING_MISMATCH` | current terminal identity / chain closure 不可证明 | status 不返回 stale terminal；write no-write，保留最后有效 snapshot；不得使用 insertion/Git/filename/Map guess |
| `PLAN_ACCEPTANCE` generation succession 缺失、重复、分支、循环、悬空/stale predecessor、跨 stage/cycle target 或无法证明唯一 tip | status：`AUTHORITY_GAP`；MES write：`RESULT_INVALID` / `RESULT_BINDING_MISMATCH` | current accepted generation 不可证明 | status 不返回任一 generation 为 current；write no-write，保留最后有效 snapshot；不得用 (ref, digest)、fingerprint、插入顺序或 newest-wins 猜测 |
| 下游 plan-bound fact 绑定非 current generation，或在已由 legal terminal 关闭的 cycle 追加新 generation | `RESULT_INVALID` / `RESULT_BINDING_MISMATCH` | 该事实不授权 current generation；closed cycle 不重开 | no-write / non-authorizing history；不改写旧 generation 或旧 support |
| Thin Plan 的 `obligation_state: EXISTING_SEAM` 缺少可复核 seam，或 seam 无法证明该 obligation | `PLAN_GAP`（pre-accept SPV）或 `RESULT_INVALID`（Review） | 该 obligation 未被证明 | no-write；不得以历史 Work/Task/Result/Git 事实或 narrative 替代 seam |
| Review→finding 稳定映射缺失或同一 key 内容冲突 | `RESULT_INVALID` | derived `finding_ref` 与 durable finding 不唯一/不一致 | no-write；不写 disposition 或替代 finding |

Implementation closed codes 必须在对应 launch/lifecycle Contract 和 task acceptance
matrix 中固定；在固定前不得让调用方依赖自然语言或 Agent 摘要。

## 8. 验证矩阵

| Contract area | Verification path | Minimum evidence |
|---|---|---|
| Mechanical CLI closed set | `packages/runtime/src/cli/proofloop.ts` + public built CLI | `boundary close` / `integration apply` closed routes；top-level `status` emits canonical envelope/exit；unknown domain/op no-write |
| `boundary close` | boundary fixtures（temp Git fixture） | allowed-path staging、dirty gate 先于 commit、no-write on scope violation |
| `integration apply` | `packages/runtime/src/cli/proofloop-integration.ts` + temp Git integration fixtures | candidate/base/HEAD/scope/conflict validation；exact changed_files；typed failure/no-write；candidate ref preserved；`diff --check` |
| MES facts / status / transaction | `.agents/contracts/brain/mes.md` + `packages/runtime/src/mes/*` + public status fixtures | root-bound snapshot/seed、strict fact/binding/relation validation、single transaction ownership、preserve-by-default、atomic/no-write、sparse/detail read-only projection、durable Review/Finding/terminal support 与 no-routing fields；isolated incident regressions；real project MES quarantine unchanged |
| Thin Plan / Work Packet | Planning fixtures + isolated maintenance packet fixtures | 不复制 Authority 正文；Thin Plan 持有 `project_stage_map_ref`（不复制 Map 正文）；Work Packet 由 `proofloop-execute` 投影；`MES_MAINTENANCE` packet 必须绑定 recovery candidate 与 frozen/forensic/audit exact tuple，不携带 normal MES identity |
| Project Stage Map | static checks + fresh Planning fixtures | `delivery/project-stage-map.md` writer=Planner、readers=Brain / Planner / SPV（Execute 按需只读）；内容 = Stage id / depends_on / goal / entry criteria / tech-spec Authority refs；Map 不缓存 readiness，status 不把 Map 转成 operational state；Map basis 可由 ref + Git basis 重建 |
| Subagent dispatch identity | Brain/Host + Subagent host adapter subagent-dispatch contract | `role_skill == subagent_type`；host session identity；config/entry/variant validation belongs to Subagent host adapter；normal dispatch 不依赖 peer registry |
| Role procedure discovery | Brain 按所选 Host 启动对应 role instance | Pi 读取 `.pi/agents/<role>.md`，OpenCode 读取 `.opencode/agents/<role>.md`；两侧各自包含完整 role procedure，Contract/template 仍共享 |
| Brain workflow ownership | static architecture checks + Host fixtures | OpenCode `.opencode/agents/brain.md` 与 Pi `.pi/brain-workflow.md` 各自拥有完整流程；不存在独立 workflow pointer 或第三份 controller |
| Subagent host launch / Subagent transport | host fixture | Pi：Agent → Host dispatch → get_subagent_result；OpenCode：native child dispatch → child session/result retrieval；normal dispatch 不依赖 peer registry；失败为 typed blocker |
| One-shot/continuation | task acceptance E2E | correct reuse/close；no wrong continuation |
| Review-loop | task acceptance E2E | independent initial review, read-only reviewer, optional claim clarification, Brain disposition, repair/recheck/reset |
| Review outcome / terminal relations | `tech-spec/contracts.md#/entities/review-result-contract` + `tech-spec/contracts.md#/entities/current-terminal-currentness-oracle` + `stage-review.md` + existing MES Result/Finding/Stage owners | envelope schema only in `stage-review.md`；三轴 no-masking；ordered `finding_evidence_refs` durable；Review→Finding 唯一可重建；accepted Stage / PROJECT_READY support 与 append-only terminal succession chain 可恢复；public `project_terminal` adjunct 在 human/JSON/detail 可观察；无 Review-specific replay/hash、Stage graph、第二 store 或 terminal pointer |
| Slice-level proof binding | FR-013 Case 1-9 fixtures | Task-local/Slice-wide replan 分类正确；无关 Slice 证明保持有效 |
| Durable recovery / maintenance | `mes-maintenance-recovery-boundary` + `mes-invalid-history-oracle` + `MES_MAINTENANCE` packet/Result/CV/Review contracts + task acceptance E2E | immutable forensic/audit closure；exact frozen digest/count；evidence-only Worker/CV/Review/Git lifecycle；isolated remediation regressions；fresh candidate/SPV；single controlled transaction；quarantine restored；rehydrate/relation audit/restart reconstruction；no conversation recovery or normal MES write |
| Planning acceptance succession | `tech-spec/architecture.md#/entities/planning-acceptance-succession` + `tech-spec/contracts.md#/entities/current-terminal-currentness-oracle` + MES transaction/status fixtures | append-only generation chain（唯一 tip）、ref/digest 不变的 fresh re-acceptance、branch / 环 / stale predecessor / 跨 cycle / closed cycle no-write、绑定旧 generation 的 downstream non-authorizing、restart 重建同一 tip |
| Recovery continuation（resume / replan / restart） | post-recovery continuation fixtures + `tech-spec/contracts.md` §2.2.4a | 三者机械可区分且可写，复用同一 `delivery_cycle_id`；不生成新 cycle；不 backfill 历史 facts；`EXISTING_SEAM` obligation 无需伪造 Work/Task/Result/Git facts |
| Legacy removal | static architecture checks | 无 active 旧 business-control 引用（历史段显式标记 legacy） |
