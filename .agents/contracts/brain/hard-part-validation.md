# Brain Hard Part Validation Contract

本 Contract 定义 Hard Part 验证结果如何进入 Authority Readiness，而不是把 Prototype/Researcher 的返回状态直接写入 Hard Parts Register。

## Use when

- Phase Registry 进入 `HARD_PART_VALIDATION`；或
- `TECHNICAL_UNKNOWN` 指向一个阻塞 Architecture、Contract 或 Work Item 的 Hard Part。

Prototype 的派发字段与结果 envelope 见 `.agents/contracts/brain/prototype.md`；Researcher 的外部事实验证遵循其 active contract。本 Contract 只负责 Brain 的状态映射、Authority 更新和路由。

## Persistence mapping

### `VALIDATED`

- 将 Hard Part Status 持久化为 `VALIDATED`；
- 记录已验证约束和可接受方案；
- 只有验证证据、Tech Spec 和下游影响检查完成后，才允许重新计算 Authority Readiness。

### `ASSUMPTION_REJECTED`

`ASSUMPTION_REJECTED` 是 Prototype result status，不是 Hard Parts Register status。Brain 必须：

1. 记录被否定的假设及证据；
2. 应用所需的 Tech Spec 与下游 invalidation 更新；
3. 确认验证问题已闭合且仍存在可行 Architecture 路径；
4. 只有满足第 3 条时，才将 Hard Part Register 状态持久化为 `VALIDATED`。

如果没有可行路径，或暴露了新的未决问题，不得写入 `VALIDATED`，而应按事实路由到 `TECHNICAL_UNKNOWN`、`AUTHORITY_GAP` 或 `USER_DECISION_REQUIRED`。

## Never persist directly

以下 Prototype result status 不能直接写入 Hard Parts Register：

- `ASSUMPTION_REJECTED`
- `PROTOTYPE_INCONCLUSIVE`
- `RESEARCH_REQUIRED`
- `RUNTIME_BLOCKER`

它们必须先经过本 Contract 的映射或现有全局路由。未完成的验证不能被 progress、Agent narrative 或 checkbox projection 补全。

## Completion criterion

Hard Part 只有在状态映射、验证约束、接受方案（如有）、受影响 Tech Spec/Work Items 和下游 invalidation 均已从持久化事实核对后，才能报告 `HARD_PART_RESULT_READY` 并重新计算下一阶段。
