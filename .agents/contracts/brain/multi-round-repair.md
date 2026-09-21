# Worker/CV Bounded Repair Adapter Contract

## 1. 责任与适用范围

本 Contract 是通用 `.agents/contracts/brain/finding-convergence.md` 在 Worker/CV pair 上的 adapter。通用 Contract 负责 currentness、failure family、history synthesis、`recheck_basis`、owner/route 与停止判断；本文件只负责 Worker/CV 的历史事实来源、repair 绑定语义和 CV recheck 入口。

Worker 的 repair packet/result schema 由 `.agents/skills/proofloop-execute/references/worker-template.md` 唯一拥有，Worker 的 repair 步骤由两个 Host 的 `worker.md` 文档分别拥有。本 adapter 不复制这些 schema 或步骤，不定义新的 Runtime action、MES fact kind、状态、route、Gate、Receipt、Context schema 或独立 result store。

## 2. 使用条件

- 当前 Slice 的 CV Finding 已由 Brain 按当前 binding 接纳，且既有 route 需要 Worker 执行 bounded `repair`；
- 当前 Slice、Plan、Authority、Git basis、scope 和 CV review identity 可由现有 Work Packet/JIT Read Set、lifecycle facts 或 bootstrap evidence 复核；
- 首次局部 repair 继续使用 `proofloop-execute`、两个 Host 的 `worker.md` 和 worker template 的正常语义；本 adapter 在跨轮 history 或 convergence 已触发时提供补充绑定。

同族 Finding 的识别、首次跨边界 Finding 的 synthesis，以及 synthesis 后同族失败的停止规则统一由 `finding-convergence.md` 决定。本文件不按 CV 轮次定义 failure family，也不定义通用 round cap。

## 3. 事实来源与 currentness

### NORMAL

Brain 从当前 MES durable facts、当前 Git/diff、accepted Plan/Authority、已接纳的 CV Result/Finding 和 Worker repair Result 建立 adapter 输入。历史只引用当前 work/binding 下可验证的 Result/Finding，不复制 Result 正文。

### PRE_MES_BOOTSTRAP

首个 MES-persistence Stage 的 bootstrap 窗口内，Brain 从 Git、Git-tracked candidate/accepted Plan、canonical Authority、结构化 Subagent transport evidence 和 Git/worktree reality 建立输入；不依赖 MES work identity 或 resultRef。seed 后恢复 `NORMAL`，本 adapter 不扩展 bootstrap 窗口。

Adapter 必须向 Brain synthesis 声明两个分析来源：
- `authoritative_history_source`：可重读的 Worker/CV Result/Finding 或 bootstrap evidence；
- `current_basis_source`：当前 Slice/Plan/Authority/Git/review binding facts。

这两个名称是 Brain 的分析声明，不是持久化字段。若当前 Contract 定义的 `FINDING_DISPOSITION` 在实现中可用，Brain 可以读取它；不可用时从已有 Result/Finding、Plan、Authority、Git 和 binding facts 重建。无法完整重建 history 或 current basis 时，Brain 走既有 recovery/fresh 或 typed blocker。

## 4. Canonical repair packet、Result 与 procedure

- bounded Repair Work Packet **唯一**读取 `.agents/skills/proofloop-execute/references/worker-template.md#bounded Repair Work Packet`；本 adapter 不重新列出 packet 字段。
- Worker repair procedure **唯一**读取所选 Host 的 `worker.md#repair` 顺序；本 adapter 不重复 RED、复现、最小修复、测试或 scope 操作。
- Repair Result envelope **唯一**读取 `.agents/skills/proofloop-execute/references/worker-template.md#Result envelope schema`；字段名、大小写、枚举、`actionToken`、`resultId`、`gitBasis` 和 `taskId` 规则均以该模板为准。本 adapter 不增加 `mode`、替代 `executionMode` 或其他 Result 字段。
- Adapter-specific 语义只有：Brain synthesis 的完整 failure-family scope 通过 canonical `repair_scope` 交给 Worker；taskless repair Result 经 Brain 接纳后只交给 CV recheck，不形成 Task、CV、Slice 或 Stage completion。

## 5. Repair history

Brain 按当前 binding 提供有序的历史引用，至少覆盖相关 CV Result/Finding 与已接纳 Worker repair Result/evidence；每个引用可复核其 `verification_type`、failure signature、failed criterion、counterexample、required recheck scope，以及 canonical Result/template 已定义的 repair diff/basis refs（适用时）。

这些引用是通用 convergence core 的 history 输入，不是新的 Worker Result schema。无法独立隔离累计 diff 时，不能把它解释成独立补丁证明；未接纳的 CV 叙事、progress、checkbox、隐藏会话和旧 Agent metadata 不能补全 history。

## 6. CV recheck adapter

- 当前 review target、Plan/Authority/Git basis、Slice scope、identity 和 clean-room 条件保持有效时，继续使用同一 CV continuation 做 bounded recheck；范围仅覆盖前次 failed criterion、concrete counterexample、repair diff 与 `required_recheck_scope`。
- target/basis 发生实质变化、session/identity 丢失、CV 写 artifact，或 binding/Result 无法完整重读时，使用现有 lifecycle 的 `REVIEW_RESET_REQUIRED` / recovery，重新进行 fresh initial CV。
- recheck 返回同一 failure family 时，先回 `finding-convergence.md`，由 Brain 更新 synthesis；本 adapter 不追加最新 Finding 后机械重派 Worker。
- recheck 返回独立 Finding 时，按 Brain 的既有 route 单独处理，不继承无关 family 的 repair scope。

## 7. Brain handoff

Brain 接纳 Repair Result 前重新读取当前 branch 的 durable facts、Plan/Authority、Git/diff、scope 和 review binding；不从 Worker narrative 判断完成。Result 验证通过后，Brain 按第 6 节把它交给 CV recheck，并依据 convergence core 的 `recheck_basis` 决定继续、fresh、recovery 或停止自动 redispatch。

CV 的 `claimed_route_code` 仍是 evidence。Brain 使用现有 `accepted_route_code` 和 typed blocker；本 adapter 不新增 `UNRESOLVED_CV_FAILURE`、`HUMAN_REQUIRED` 或其他 generic route。

## 8. 硬边界

- 不把本 adapter 用于首次正常 Task Result；
- 不把本文件的文字或示例当作 Worker packet/Result schema 的替代来源；
- 不恢复 Receipt、Manifest、Gate、Primary Next Action 或隐藏 credential chain；
- 不改变 `.opencode/agents/brain.md` 的固定 route；
- 不因 repair 轮次自动放宽权限；停止条件由通用 convergence core 与现有 adapter/lifecycle Contract 共同决定；
- Brain 负责跨轮归纳与 route，Worker 负责 bounded repair，CV 负责独立验证。