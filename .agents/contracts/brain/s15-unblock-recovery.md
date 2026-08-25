# S15 Unblock Recovery Contract

本 Contract 只适用于已 admission 的 S15 在首次 slice-local CV 前被 Runtime/Host
实现缺陷阻断的恢复边界。它不是新的 public CLI、Stage、Plan authority 或 Receipt 类型。

## 进入条件

必须同时满足：

- S15 当前 Plan、Manifest 与 Stage Plan admission 未被产品或计划变更取代；
- S15-A 的 CV 尚未产生 CV Receipt，阻塞原因为现有 `stage admit-cv` route 无法接纳
  slice-local nested `CV_RESULT` schema 3；
- S15-A-T01/T02 的 Worker Receipt、Evidence 与代码 patch 已完整保留；
- 用户已明确授权本 Recovery Boundary；
- 当前修复只实现已确认 Contract/HP-022 中的 Runtime/Host route 行为。

前置条件不满足时，返回 `RUNTIME_BLOCKER / RECOVERY.S15_BOUNDARY_MISMATCH`，不得
使用本 Contract 绕过状态。

## 所有权

- Brain：冻结事实、检查 scope、调度、验证 Git boundary、触发 fresh SPV/admission 和恢复。
- Runtime/Host repair specialist：实现既有 CV v3 route/test scope。
- Committer：建立独立 Runtime repair Git boundary。
- Runtime：唯一负责 Context、currentness、recover/recheck、Receipt 和 admission。
- General：只可执行只读审计，不得修改生产 Runtime 代码。

## 派发包

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
contract_mode: s15-unblock-recovery
mode: runtime-host-repair
stage_id: S15
slice_id: S15-A
task_id: S15-UNBLOCK-CV-ROUTE
project_root: <canonical-trust-root>
allowed_paths:
  - packages/runtime/src/cli/proofloop-stage.ts
  - packages/runtime/src/vnext/cv-admission.ts
  - packages/runtime/src/vnext/cv-validation.ts
  - <declared route parity tests only>
forbidden_paths:
  - .proofloop/**
  - delivery/stages/S15/**
  - packages/runtime/dist/**
  - tech-spec/**
  - .agents/**
  - .opencode/**
  - .git/**
expected_result: BOUNDARY_READY | BOUNDARY_BLOCKED
```

该派发包是 Runtime/Host repair boundary，不是普通 Stage Worker dispatch；因此不提供
Stage Context、Manifest Context digest、Evidence path 或 Worker/CV Receipt 输入。Worker
只能修改上述 route/test 文件，返回 changed files、测试命令/结果和结构化 boundary result，
不得写 Evidence、checkbox、Receipt 或提交 Git。

### Formal Plan Replan Runtime seam repair

当用户确认同一 S15 的正式 Plan Replan，且当前 candidate Plan 已由
`plan materialize`/`plan compile` 生成新 Plan/Manifest，但 Evidence rotation 因缺少
Runtime-owned disposition preparation 被阻断时，允许使用以下第二种 bounded repair packet：

```yaml
target_agent: worker
caller: brain
skill: proofloop-execute
contract_mode: s15-unblock-recovery
mode: runtime-replan-repair
stage_id: S15
slice_id: S15-A
task_id: S15-UNBLOCK-REPLAN-SEAM
allowed_paths:
  - packages/runtime/src/cli/admit-vnext-stage-plan.ts
  - packages/runtime/src/cli/proofloop-common.ts
  - packages/runtime/src/cli/proofloop-plan.ts
  - packages/runtime/src/cli/refresh-vnext-slice-evidence.ts
  - packages/runtime/src/vnext/admission.ts
  - packages/runtime/src/vnext/evidence-refresh.ts
  - packages/runtime/src/cli/refresh-vnext-slice-evidence.spec.ts
  - packages/runtime/src/cli/proofloop-plan-replan.spec.ts
  - packages/runtime/src/vnext/evidence-rotation.spec.ts
  - packages/runtime/src/vnext/replan-impact.spec.ts
  - packages/runtime/src/vnext/replan-epoch.ts
  - packages/runtime/src/vnext/replan-epoch.spec.ts
  # Validator parity for Runtime-owned Evidence history archives.
  - packages/runtime/src/cli/vnext-cli-support-vnext.ts
  - packages/runtime/src/cli/validate-vnext-stage.spec.ts
  # Current-epoch consumers: isolate invalidated historical TASK_COMPLETE facts,
  # route existing implementation through recover-task, and project Context from
  # the current epoch rather than the stale canonical admission path.
  - packages/runtime/src/vnext/next.ts
  - packages/runtime/src/cli/next-action-vnext.spec.ts
  - packages/runtime/src/cli/proofloop-context.ts
  - packages/runtime/src/cli/proofloop-context.spec.ts
forbidden_paths:
  - .proofloop/**
  - delivery/stages/S15/**
  - tech-spec/**
  - .agents/**
  - .opencode/**
  - .git/**
expected_result: BOUNDARY_READY | BOUNDARY_BLOCKED
```

该 packet 只修复现有 S15-A-T02 已声明的 Runtime seam：由 Runtime 从 current/candidate
Manifest、Task/Receipt/Evidence/Git facts 独立派生并绑定 disposition，再由
`plan refresh-evidence(mode=replan)` 执行 Evidence rotation 与 bounded projection
recovery。不得接受 caller 自报或 self-digest forged disposition。不得改变 Plan shape、
Task scope、Dependency、public operation、ReceiptType 或 Evidence/Receipt 内容。
当 Replan rotation 已产生 Runtime-owned `evidence/history/<parent-epoch>/` 归档时，
同一 repair boundary 也可修复 Planner Validator 对该受控归档目录的识别；只能允许
完整 digest 目录下声明 Slice 的 `.md` 归档，其他目录、文件、symlink 或 foreign Slice
必须继续 fail-closed。

当已 admission 的 Replan epoch 进入 `stage next` 或 `context prepare` 消费路径时，同一
repair boundary 也可修复 current-epoch authority 解析与历史事实隔离；Context 必须从
当前 epoch 的 admission authority 投影，并按同一祖先 disposition 规则过滤历史事实。
当 Git HEAD 变化但 Manifest/Plan contract 不变、需要生成下一 epoch 时，同一 boundary
也可让 Runtime 在严格验证祖先 Replan disposition 后忽略已标记为 historical invalidated
的旧 Worker Receipt，不能把未知或未被祖先事实覆盖的旧 Receipt 静默跳过。只有与
`previous_snapshot` 完全绑定、且由当前 disposition 标记为 invalidated 的历史
`TASK_COMPLETE` 才能从 active facts 隔离，并必须把已有实现路由为 `recover-task`；
当前 epoch、混合 epoch、伪造 digest、错误 Receipt chain、外层 Receipt binding 与
payload 不一致或未知任务必须继续 fail-closed。该修复不改变 Plan shape、Task scope、
Dependency、public operation、ReceiptType 或任何 Evidence/Receipt 内容。

## 允许范围

普通 CV v3 route repair 仅限：

- `packages/runtime/src/cli/proofloop-stage.ts`
- `packages/runtime/src/vnext/cv-admission.ts`
- `packages/runtime/src/vnext/cv-validation.ts`
- 与上述 route 直接对应的 source/built/public parity tests

`mode: runtime-replan-repair` 的 Runtime-owned consumer 修复仅限：

- `packages/runtime/src/cli/vnext-cli-support-vnext.ts`
- `packages/runtime/src/cli/validate-vnext-stage.spec.ts`
- `packages/runtime/src/cli/proofloop-context.ts`
- `packages/runtime/src/cli/proofloop-context.spec.ts`
- `packages/runtime/src/vnext/next.ts`
- `packages/runtime/src/cli/next-action-vnext.spec.ts`

## 禁止范围

- `delivery/stages/S15/tasks.md` 的 immutable Plan 内容；
- `.proofloop/manifests/**`、`.proofloop/receipts/**`、`.proofloop/context/**`；
- S15 Evidence、Worker/CV/Commit/Integration/Gate/Review Receipt；
- S15 dependency graph、Task acceptance、Replan impact 语义；
- 新建 Stage、public operation、ReceiptType 或 General 生产实现；
- 直接 dispatch 未 dependency-ready 的 S15-B；
- 手写 Receipt、Context、Manifest、Evidence 或 forged binding。

## 固定流程

```text
冻结 S15 Plan/Manifest/Receipt/Evidence
→ 停放现有 S15 recovery patch
→ Runtime/Host specialist 实现 route 修复
→ Committer 建立独立 Runtime repair Git boundary
→ 当前 HEAD fresh SPV
→ Stage Plan admission
→ 恢复现有 patch
→ Runtime recover-task/recheck T01/T02
→ public CV v3 route
```

repair commit 不是 Slice Commit；它不产生 Worker/CV Receipt。repair 改变 Plan、Manifest
shape、Contract、Task scope 或 public operation 时，立即返回
`RECOVERY.RUNTIME_REPAIR_SCOPE_VIOLATION`，转 `PLAN_GAP` 或 `AUTHORITY_GAP`。

## 验收

- outer CLI envelope 仍为 schema 2，slice-local nested `CV_RESULT` 使用 schema 3；
- source、built、public dispatcher 与 shared validator 语义一致；
- legacy/v2 route 零行为变化；混模式、错误 Stage/path、Worker tip、Context、Proof Index
  或三层 digest 不匹配均 zero-write；
- repair commit 后 fresh SPV、Stage Plan admission 和 T01/T02 `recover-task/recheck` 均
  由 Runtime 事实证明；不能由 progress 或 Agent 叙事补全。

## 允许返回

```yaml
result: BOUNDARY_READY | BOUNDARY_BLOCKED
route_code: RUNTIME_BLOCKER | PLAN_GAP | AUTHORITY_GAP | IMPLEMENTATION_DEFECT
subtype: <closed recovery subtype>
reason: <required>
invalidation_scope: []
resume_target:
  owner: <owner>
  phase: STAGE_EXECUTION
  stage: S15
```
