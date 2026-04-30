# 统一就绪门禁质量检查

本文件用于 `propose` 与 `apply` 之间的放行判断，只保留三道门禁。

## 1. Proofability Check
- [ ] 最小闭环的真实入口是否明确？
- [ ] 用户真实操作顺序是否明确？
- [ ] authority 单源是否明确？
- [ ] 哪些证据明确不算完成，是否写清？
- [ ] 最终用什么验证方式证明闭环成立，是否写清？

## 2. Tasks Readiness Check
- [ ] `tasks.md` 是否已经把最小闭环拆成可执行步骤？
- [ ] 每个实现切片是否都已显式包含 `verifier` 子代理独立校验任务？
- [ ] 每个 `verifier` 校验任务是否都写清了校验范围与 `PASS/FAIL` gate？
- [ ] 每个关键任务是否有文件范围和验证命令？
- [ ] 若为 `interactive` change，`Blocking` 第一项是否已经是 `Proof Task`？
- [ ] proposal / design / specs / tasks 是否仍在描述同一条闭环？

## 3. Implementation Done Check
- [ ] 任务里的验证命令是否实际跑过？
- [ ] 每个实现切片的 `verifier` 校验是否都已经实际执行并拿到明确 `PASS/FAIL` 结论？
- [ ] `verifier` 是否独立读取 change artifacts、相关实现、相关测试与验证结果，而不是继承主代理口头结论？
- [ ] 若为 `interactive` change，是否已经有真实入口级证明，而不是内部直调伪验证？
- [ ] 代码、任务与验证结果是否一致？
