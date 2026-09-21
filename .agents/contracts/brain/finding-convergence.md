# Brain Finding Convergence Contract

## 1. 责任与适用范围

本 Contract 定义 Brain 对 verifier/reviewer Finding 的统一收敛判断：currentness、历史重建、normative-first 仲裁、failure family 归类、synthesis、owner/route 选择、复查入口与停止条件。它不定义 Worker、Planner、CV、SPV 或 Stage Reviewer 的 packet/result schema，也不定义 Runtime action、MES fact kind、业务 route 或新的状态。

Brain 是唯一的 finding arbitration 与 convergence owner。Verifier 只提交 verdict、evidence 和 `claimed_route_code`；repair/replan owner 只执行 Brain 已确认的范围；Brain 不把任一 Agent 的叙事直接当作当前事实。

Brain 对 Finding 进行 normative-first 仲裁：
- Finding 是否有效，必须基于 accepted Plan + Technical Authority（tech-spec）+ current MES/Git/code reality 共同判定；
- Reproducibility alone is not normative support（单纯可复现并不构成规范依据；若实现符合 accepted Plan 与 tech-spec，仅因 verifier 自身预期、未约定的假设或超范围标准而失败，属于缺乏规范依据）；
- Reviewer 提供的 solution narrative / suggested repair idea 不能被当作 `complete_repair_scope` 或 implementation authorization；Brain 接纳的是 problem claim 与 route，不是 HOW。repair owner 自行决定 bounded HOW。

## 2. 触发条件

通过所选 Host Brain 文档的 Finding/Recovery route 在以下分支加载本 Contract：

- 首次 Finding 已跨越同一 work/transaction scope 内的多个 binding-chain 边界；
- 一次 repair/replan 完成后，Verifier 在当前 basis 下再次命中同一 failure family。

首次、局部且由单一 owner 可完成的 Finding 继续走既有 arbitration route。触发 convergence 后，Brain 在 owner dispatch 前完成本 Contract 的 family classification 与 synthesis。

## 3. 输入与 currentness

Brain 先从当前分支可重读事实建立 basis：

- 当前 verifier/reviewer Result/Finding 及其 binding；
- 当前 Stage/Slice/Plan/Authority/Git scope 与相关 durable facts；
- adapter 声明的 authoritative history source；
- adapter 声明的 current verification basis；
- 当前实际 changed-file 集合和必要的代码/测试事实。

`authoritative_history_source` 与 `current_basis_source` 是 adapter 的分析声明，不是新的持久化字段。Contract 定义的 `FINDING_DISPOSITION` 在当前实现可用时可以作为历史/判定事实；不可用时使用已有 Result/Finding、Plan、Authority、Git 和 binding facts 重建。Brain 不使用隐藏会话、progress、checkbox、未接纳叙事或摘要补齐缺失事实。

历史 Finding 可以用于识别共同根因；只有能证明与当前 work/binding basis 关联的事实，才能驱动当前 repair/replan。无法完整重建当前 basis 时，走既有 recovery/fresh 或 typed blocker。

## 4. Failure family 归类

### 4.1 主判据

Failure family 以现有事实形成的图为依据：

1. **共同范围**：Finding 属于同一可证明的 work/transaction scope，例如同一 Stage、Slice、Plan 或其现有 binding；不创建新的 transaction ID。
2. **连通区域**：Finding 影响的 binding edges 位于同一 connected binding-chain region。图中的节点是现有字段、对象、Plan、Result、Git/Authority basis；边是当前 Contract、Plan 或真实代码明确的 producer → validator → persistence → consumer → recovery 传递关系。
3. 两个 Finding 只有在其 edge set 通过共享字段/对象、直接 producer-consumer 依赖或共同 basis 相交或相邻时，才形成 family candidate。同一 Stage、同一文件或相邻轮次本身不足以合并。

同一 work scope 与连通 binding-chain 形成 family candidate 后，Brain 仍须检查是否存在独立根因；证据不足时保持独立分类或返回既有 typed blocker，不凭相似文案强行合并。

### 4.2 辅助证据

以下信息用于确认或拆分 family，不单独决定 family identity：

- 相同字段、对象、digest 或 credential；
- `invalidation_scope` 相交；
- producer/consumer 重叠；
- acceptance/seam 重叠；
- failure signature 相似；
- affected artifact 重叠。

`route_code`、`claimed_route_code`、Finding ID、出现轮次和 Subagent type/session 都不是 family identity。

## 5. 统一收敛流程

```text
Verifier Result/Finding
        ↓
Brain 校验当前 binding 与 verification basis 并进行 normative arbitration
(1. binding/currentness -> 2. accepted Plan + tech-spec support -> 3. optional claim clarification -> 4. code reality -> 5. FINDING_DISPOSITION)
        ↓
读取 adapter 提供的 authoritative history
        ↓
Failure-family classification
        ↓
首次局部单 owner：既有 route
首次跨边界或同族复现：Brain synthesis
        ↓
既有 owner 执行完整 repair/replan scope（repair owner 自主决定 bounded HOW）
        ↓
Adapter 按 basis 决定 verifier re-entry
        ↓
PASS / 独立新 Finding / 同族 Finding / 既有 typed blocker / VERIFIER_OVERREACH
```

同族 Finding 第二次出现时，Brain 不再只转发最新 Finding；必须先形成 synthesis。`synthesis-guided` repair/replan 完成后仍出现同一 family 时，停止自动 owner redispatch，保留 adapter 当前合法的 typed route/blocker，并等待既有 recovery、用户决策或其他明确边界。这里不新增 convergence status，也不依赖通用轮次上限。

## 6. Brain synthesis

以下是 Brain 的派生分析工作表，用于 dispatch 与复查判断；它不是 Subagent transport envelope、MES fact、Plan 字段或新的 durable object：

```yaml
brain_synthesis:
  historical_finding_refs: []
  shared_root_cause: <共同根因>
  prior_repair_miss: <上一轮修复遗漏或误判>
  failure_family:
    work_scope_refs: []
    binding_edges: []
    shared_fields_or_objects: []
  independent_new_findings: []
  authoritative_history_source: <adapter 声明的事实来源>
  current_basis_source: <adapter 声明的当前 basis 来源>
  complete_repair_or_replan_scope:
    code_paths: []
    test_paths: []
    plan_or_authority_refs: []
  owner: <现有 owner>
  route: <现有 route>
  recheck_basis:
    prior_basis: []
    current_basis: []
    status: SAME | CHANGED | UNRECONSTRUCTABLE
    reason: <可复核理由>
  required_recheck_mode: <由 adapter 选择的既有复查模式>
  closure_criteria: []
  stop_conditions: []
```

Brain synthesis 至少必须回答：

- 历史 Finding 是否确实属于同一 family；
- 共同根因和上一轮遗漏是什么；
- 本次完整修复/replan 范围覆盖哪些 producer、validator、persistence、consumer 和 recovery edges；
- 当前 basis 与修复前 basis 是 `SAME`、`CHANGED` 还是 `UNRECONSTRUCTABLE`，为什么；
- 哪个既有 owner 和 route 承担修复（repair owner 自主决定 bounded HOW，Brain 与 Reviewer 均不预设实现设计）；
- 完成后由哪个 adapter、以什么范围和 basis 重新验证；
- 同族失败再次出现时停止在哪里。

`complete_repair_or_replan_scope` 必须落在当前授权 scope 内。超出 scope、Authority 不明确或技术事实不可验证时，Brain 下游不正式分类 `AUTHORITY_GAP`，只走已有 `PLAN_GAP`、`TECHNICAL_UNKNOWN`、`EVIDENCE_GAP`、`RUNTIME_BLOCKER` 或相应 blocker 路由至 Planning（正式 `AUTHORITY_GAP` 仅限 Planning/SPV handoff），不把 scope 缩成局部后继续派发。

## 7. Adapter 复查规则

| Pair | Brain 的 owner/action | basis current 时 | basis changed 或无法重建时 |
|---|---|---|---|
| Worker / CV | 既有 bounded Worker repair | 同一 CV continuation 做 bounded recheck | 按既有 lifecycle reset/recovery，fresh initial CV |
| Planner / SPV | Planner 完整 candidate replan（Stage-level PLAN_GAP 影响 Map 时 owner 仍为 Planner） | Planner semantic Planning basis 仍 current 时（含 Project Stage Map ref / current entry），Planner lifecycle 可 continuation；不复用 SPV verdict | 任一 Plan 或 Map material revision，或 candidate Plan / referenced Map entry / Authority / Git tuple 变化 → fresh full initial SPV；同名 Agent 只复用 transport。相同 candidate blob 的机械 `stage-plan` boundary 不单独使 Planner 失效 |
| Stage Reviewer | 既有 bounded repair/replan route（General 或 Worker 决定 bounded HOW） | 同一 Reviewer 做 bounded recheck | `REVIEW_RESET_REQUIRED` 或既有 recovery 后 fresh Reviewer |

此表只规定 convergence core 选择 adapter 的信息；各 Host Role document、lifecycle Contract 和 packet Template 继续拥有具体步骤、binding 与 schema。

## 8. Route 与停止纪律

- `claimed_route_code` 是 evidence；Brain 依据当前 Authority、Plan、scope、code reality 和 normative support 形成既有 disposition，再使用合法 `accepted_route_code`。Reviewer 的 suggested solution 不构成 implementation authorization；Brain 接纳的是 problem claim 与 route，不是 HOW。
- Brain 下游处理 Finding 时不正式分类 `AUTHORITY_GAP`：遇到 Plan 缺口走 `PLAN_GAP` 路由 `proofloop-plan` 进行 Replan；遇到 tech-spec 自身冲突、技术未决或证据不足，走 `TECHNICAL_UNKNOWN`、`EVIDENCE_GAP` 或 `RUNTIME_BLOCKER` 回退 Planning 重新核对 Authority；正式 `AUTHORITY_GAP` 仍由 Planning/SPV claim，但既包括 Product Authority → Technical Authority handoff failure，也包括 Product intent 不变时 grounded current code/runtime 对 current Technical Authority 的反证；Brain 将其路由到 Propose owner。
- Planner/SPV 发现 candidate Plan 自己引入、而 PRD/tech-spec 未要求的 helper、signature、schema、graph 或 protocol detail 时，按 `PLAN_GAP` 回 Planner 删除/替换/重构该 choice；不得把此类实现选择升级为 `AUTHORITY_GAP`。Technical feasibility 未验证走 `TECHNICAL_UNKNOWN`；Authority 完整的 Runtime 问题走 normal repair/planning。
- `USER_DECISION_REQUIRED` 是 verifier 的用户决策 claim。Brain 确认真实产品、权限或验收决策缺口后，才形成已有的 `HUMAN_REQUIRED` Brain-owned operational pause；用户离线或停止发送消息本身不构成该缺口。
- `VERIFIER_OVERREACH` 是有效终止 disposition：表示 Finding 缺乏 accepted Plan 与 tech-spec 的 normative support，或超出了 Verifier 的审查职责边界（如 Stage Reviewer 依赖 PRD 提出 claim、或要求超出 Plan/tech-spec 约定的实现设计）。此时 `accepted_route_code = null`，不派发 producer repair，不触发 current-stage Replan，也不因 reviewer overreached 触发 `HUMAN_REQUIRED`。该 Finding 被驳回并终结。
- 独立新 Finding 单独走既有 route；它不继承无关 family 的 repair scope。
- synthesis-guided 修复后同 family 再现时，Brain 停止自动 redispatch，保留 adapter 当前合法 typed route/blocker；不发明 `UNRESOLVED_CV_FAILURE` 或其他 generic route。
- 未能重建 history 或 current basis 时，Brain 选择既有 recovery/fresh 或 typed blocker；不以隐藏 synthesis 继续推进。

## 9. 持久化与恢复

Synthesis 是派生决策，不形成第二事实源。Brain 重启后按 adapter 从可用的 MES facts、结构化 Result/Finding、candidate/accepted Plan、Authority、Git 和 lifecycle binding 重建；当前实现可用时再读取 Contract 定义的 `FINDING_DISPOSITION`。重建失败就进入既有 recovery/fresh 边界。

本 Contract 不恢复 Receipt、Manifest、Gate、Context credential、Primary Next Action、隐藏对话或旧 Agent metadata，也不要求任何新的 Runtime action、MES schema、状态或独立 result store。