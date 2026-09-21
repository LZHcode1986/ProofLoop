# Brain Stage Review Dispatch Contract

Dispatch a Stage review to Stage Reviewer.

## Use when

A Stage review is dispatched after normal Stage execution is complete (all Slices INTEGRATED) and needs goal-first review against accepted Plan + Technical Authority (tech-spec) + integrated snapshot. A maintenance review is dispatched only after the `MES_MAINTENANCE` evidence-only Slice/Git lifecycle is complete and needs the same three-axis independent challenge against the recovery candidate Plan + current Technical Authority + Git/forensic/audit evidence. Both are Stage-layer independent review; there is no project review mode and this Contract is not reused for Project-level acceptance (see `mes.md` `PROJECT_READY`). PRD is not part of either review basis.

## Review method

`independent-goal-challenge`，按 `review_scope` 做 Stage 三轴（Outcome → Composition → Authority）独立挑战：normal 使用 accepted Plan + Technical Authority（tech-spec）+ integrated snapshot；maintenance 使用 recovery candidate Plan + current Technical Authority（tech-spec）+ maintenance Git/forensic/audit evidence。

Reviewer 全程 read-only（`edit: deny`），不修改 code、Plan、Authority、Evidence 或被审查 artifact，也不自行 route repair/replan。Reviewer 的 suggested solution 仅作参考，不构成 implementation authorization，Reviewer 不拥有 implementation design authority。禁止：一个轴 PASS 掩盖另一个轴 finding；generic quality score averaging；Reviewer 修改代码/Plan/Authority。

## 三轴范围

### Outcome

验证：

- accepted Plan / Acceptance 在 integrated reality 是否成立
- real user-observable outcome
- counterexample / scenario
- 边界与关键错误路径验证

（PRD 不进入三轴 normal basis）

### Composition

验证：

- cross-slice flow
- producer → consumer
- state/data flow
- error / recovery
- cross-slice seams
- Stage-level risk / NFR

### Authority

验证：

- Architecture
- Contracts
- Acceptance
- Stage / cross-slice consequence

## Required fields

Packet 改为 ref-first；`review_scope: stage` 使用 accepted Plan + Technical Authority (tech-spec) + integrated snapshot，`review_scope: maintenance` 使用 `execution_mode: MES_MAINTENANCE`、recovery candidate Plan + current Technical Authority + maintenance Git/forensic/audit binding。两者均不包含 Brain 投影的产品层引用、目标摘要、解读或 Brain acceptance criteria（去 generic canonical Authority、去 raw Stage risk level、去 Brain acceptance criteria）。Reviewer 从 stable refs 独立自读并重建目标与验收标准：
- `review_scope: stage | maintenance`
- `execution_mode: NORMAL | MES_MAINTENANCE`（`stage` 只能 `NORMAL`；`maintenance` 只能 `MES_MAINTENANCE`）

- Stage ID
- mode-specific Plan ref（normal=accepted Plan；maintenance=recovery candidate Plan）
- Stage Map ref / entry ref (when needed)
- Technical Authority refs (Architecture / Contracts / Acceptance)
- Stage branch ref / maintenance evidence root
- tasks.md path / MES fact context / maintenance Git evidence refs
- Integrated snapshot (commit or tree ref / Git basis) / maintenance evidence snapshot (Git candidate refs + frozen/forensic/audit tuple)
- actionToken
- verification_type (initial | recheck)
- Clean-room requirement (yes / no)


### Envelope schema
```yaml
review_result_envelope:
  actionToken: <ephemeral dispatch/lane token; not durable>
  verdict: PASS | FINDINGS | BLOCKED
  outcome_verdict: PASS | FINDINGS | BLOCKED
  composition_verdict: PASS | FINDINGS | BLOCKED
  authority_verdict: PASS | FINDINGS | BLOCKED
  verification_type: initial | recheck
  stage: <canonical Stage ID>
  review_scope: stage | maintenance
  execution_mode: NORMAL | MES_MAINTENANCE
  planRef: <stage=accepted Thin Plan ref; maintenance=recovery candidate Thin Plan ref>
  authorityRefs: [<canonical tech-spec ref>, ...]
  maintenanceBinding:  # maintenance only; omitted for stage
    frozenSnapshotRef: <root-relative-frozen-MES-snapshot>
    frozenSnapshotSha256: <exact-source-sha256>
    frozenFactCount: <exact-source-fact-count>
    forensicRef: <root-relative-immutable-incident-ref>
    forensicSha256: <exact-incident-sha256>
    auditRef: <root-relative-read-only-audit-ref>
    auditSha256: <exact-audit-sha256>
  gitBasis:
    head: <40-hex Git HEAD>
    branch: <stage branch>
    worktree: <root-relative worktree>
  reviewSnapshotRef: <stage=integrated Stage snapshot ref; maintenance=Git candidate/integration evidence snapshot>
  claimed_route_code: <closed Reviewer route; required for FINDINGS/BLOCKED>
  subtype: <required for FINDINGS/BLOCKED>
  finding_id: <id | none>
  finding_evidence_refs: [<ordered durable ref>, ...]  # non-PASS non-empty; PASS []
  affected_stage: <stage ID>
  affected_outcomes: [<item>, ...]
  affected_artifacts: [<root-relative ref>, ...]
  evidence: <narrative description; not durable>
  suggested_solution: <optional reference only>
  reason: <required for BLOCKED>
  suggested_owner: <owner>
  invalidation_scope: [<root-relative ref>, ...]
  resume_target:
    owner: <MES_RESUME_TARGETS value>
    phase: <phase>
    stage: <stage-id | none>
```
此 envelope schema 由本 Contract 唯一拥有；`actionToken` 仅作 transport/lifecycle binding。Reviewer envelope 是 Brain 接纳前的 structured Link input，不要求预先存在的 durable `resultRef`；Brain 发起对应 semantic event 后由 MES transaction layer 从 current relation materialize/校验既有 Finding/Stage 支持事实所需的 `result_ref`。Review 不新增专属 submission identity、payload hash 或第二个 envelope schema。
## Operational verdict

Reviewer 返回结构化 verdict，闭集为 `PASS | FINDINGS | BLOCKED`：

- **PASS**：三轴全部通过且 binding 正确；`review_scope: stage` 由 Brain 发起 `STAGE_ACCEPTED` semantic event，经 MES operational transaction layer materialize `STAGE_ACCEPTED`；`review_scope: maintenance` 仅形成 evidence closure，不写任何 MES Stage/terminal fact；是否关闭 live lifecycle 由 `.agents/contracts/brain/agent-lifecycle.md` 对应 matrix row 的 `close_when` 决定。
- **FINDINGS**：至少一个轴未通过 → Reviewer 提交结构化 `finding_evidence_refs` 与 `claimed_route_code`；`review_scope: stage` 下 Brain 可按现有 semantic Finding/MES disposition 处理；`review_scope: maintenance` 下 Brain 只接纳结构化 evidence、决定 bounded route，不写 MES Finding/Task/Work/Stage/terminal fact。Reviewer 若提供 suggested solution 仅作参考，不构成 implementation authorization。
  - 若缺乏 normative support 或超出审查边界，Brain 裁决为 `VERIFIER_OVERREACH`（`accepted_route_code = null`，无 producer repair，无 current-stage Replan，不触发 `HUMAN_REQUIRED`）；
  - 若 claim 成立，Brain 按对应 mode 决定 bounded repair/Replan/Propose/Research；maintenance 全轴 PASS 仍只形成 evidence closure，不写 `STAGE_ACCEPTED`。
- **BLOCKED**：外部阻塞、前置缺失或环境问题 → no-write；Reviewer 提交 `claimed_route_code`，Brain 重读 durable facts 后按 mode 走 typed recovery；`stage` 可按现有 `FINDING_DISPOSITION`，`maintenance` 只保留结构化 blocker/evidence，不写 MES，保留 `subtype`、`reason`、`invalidation_scope`、`resume_target`。

`STAGE_ACCEPTED` 是 normal Stage 接受的唯一 operational fact；它由 Brain 发起 semantic event、MES operational transaction layer materialize，不产生 Gate、Receipt、admission 或 finalize 凭证。Maintenance Review 不产生任何 Stage/terminal operational fact。

### Return codes

```yaml
review_scope: stage | maintenance
execution_mode: NORMAL | MES_MAINTENANCE
planRef: <mode-specific Plan ref>
maintenanceBinding: <required for maintenance; exact frozen/forensic/audit tuple>
verdict: PASS | FINDINGS | BLOCKED
claimed_route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | TECHNICAL_UNKNOWN
           | RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP
subtype: <specific subtype>
finding_id: <id | none>
  finding_evidence_refs: [<ordered durable ref>, ...]  # non-PASS non-empty; PASS []
affected_stage: <stage-id>
affected_outcomes: <list>
affected_artifacts: <list>
evidence: <narrative description; not durable>
suggested_solution: <optional reference only; not implementation authorization>
reason: <description>            # required for BLOCKED
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id | none>
```

`finding_evidence_refs` 是 Stage/maintenance Reviewer → Brain 的唯一结构化 evidence handoff：FINDINGS/BLOCKED 必须为有序、非空、稳定且可供 Brain 处理的 refs；normal Stage 下 Brain 可写入 durable Finding facts，maintenance 下 refs 只作为 evidence，不写 MES Finding。PASS 必须为空数组。Reviewer 不持久化 narrative；本 Contract 是 envelope/result 字段唯一 owner，Technical Authority 只规定 durable relation semantics。

## Bounded recheck

允许 same Reviewer recheck 的条件：

- Stage Goal 未变；
- Technical Authority (tech-spec) 未变；
- Plan/Slice partition 未发生 material change；
- repair scope bounded；
- Reviewer lifecycle still trustworthy。

bounded repair 可由 General（默认）或 Worker 承担：Brain 已接纳 problem claim，并按 mode 通过 General Contract 提供 explicit allowed/forbidden scope 与 pointer-first repair packet（不要求 Brain 提供 acceptance criteria），repair owner 自主决定 bounded HOW，Brain 不替 repair owner 构造 technical repair design，Reviewer 也不拥有 repair design authorization。
对 `MES_MAINTENANCE`，General 仅作为本 Review Contract 定义的 post-Review bounded-repair exception：packet 绑定 Reviewer 的 `finding_evidence_refs`、Brain 的 `accepted_route_code` 与完整 maintenance evidence binding，不创建或要求 MES Finding/FINDING_DISPOSITION；它不改变前置 Worker/CV/Integration/Review execution lane。
General 作为 one-shot bounded repair owner 修复 bounded implementation/composition defect 时，经 `direct-fix` Git boundary 建立 Git 事实，不创建 Slice candidate、不产生 `READY_TO_INTEGRATE`、不运行 Slice CV，也不调用 Integration，General 不继承 Worker Slice lifecycle。

一旦 Goal / Technical Authority (tech-spec) / Plan/Slice partition / material scope 发生实质变化，退出 bounded Review repair，继续走既有 Replan / Propose / Research / fresh-review 路由；不新增 Review 专用 phase、state、Gate、Receipt 或 recovery 机制。
即使 repair 产生新 Git snapshot，也不自动要求 fresh Reviewer。

必须 fresh reset（`REVIEW_RESET_REQUIRED`，fresh Reviewer 完整独立初审）：

- Goal change；
- Technical Authority change；
- Replan materially changes Slice/dependency；
- repair scope materially expands；
- Reviewer continuity/trust lost。

Fresh Reviewer 不能以旧 Agent Name、旧 clarification 记录、旧 finding 摘要或旧 verdict 推断新结论。

## Receipt / admission

Stage Reviewer 不写任何 Receipt，也不触发 Gate/admission/finalize 业务。normal `STAGE_ACCEPTED` 只由 Brain 校验结构化 verdict、发起 semantic event，并由 MES transaction layer materialize；maintenance Review 只产生 Git/Link evidence，状态迁移只来自允许的 normal MES 记录与 Git reality。

## Review-loop lifecycle pointer

Stage Review 是泛化 review-loop 的一个实例。发生 initial dispatch、FINDINGS/BLOCKED、repair 后 recheck、target/basis/identity/trust 变化、Agent/Host/Link loss，或准备 recall/close 时，fresh-read `.agents/contracts/brain/agent-lifecycle.md` §§3、6–8。
本 Contract 只拥有 Stage Review 的三轴方法、envelope 与 verdict；lifecycle matrix 是 retain/continuation/close/reset 的唯一 owner。Reviewer 的 raw `PASS` 不是 close；只有 Brain 接纳 `STAGE_ACCEPTED` 且对应 matrix row 的 `close_when` 成立后才可关闭。

## Historical

旧 `review_scope: project` mode、Stage Gate、Review admission Receipt、`review finalize-stage`、`project finalize-review` 与 `PROJECT_ACCEPTANCE` 均为 Historical/legacy，不再构成 active 路由；本 Contract 不引用它们作为业务前置。
