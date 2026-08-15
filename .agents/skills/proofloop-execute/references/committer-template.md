# Committer 派发模板

本模板供 `proofloop-execute` 由 Brain 直接调度 Committer 使用。

## 派发数据包

```yaml
target_agent: committer
caller: brain
skill: proofloop-execute
contract_mode: vnext-template
mode: slice-output
stage_id: <stage-id>
slice_id: <slice-id>
project_root: <canonical-trust-root>
manifest_path: .proofloop/manifests/<stage-id>.json
manifest_digest: <sha256>
cv_receipt_path: .proofloop/receipts/cv/<stage-id>/<slice-id>/<receipt>.json
cv_receipt_digest: <sha256>
cv_verdict: PASS
verified_snapshot: <sha256>
pre_commit_head: <40-char-sha>
changed_files: []
tasks_path: delivery/stages/<stage-id>/tasks.md
evidence_path: delivery/stages/<stage-id>/evidence/<slice-id>.md
allowed_commit_files: []
forbidden_scope:
  - unrelated dirty files
  - authority changes
  - other Slice artifacts
  - manual Receipt creation
expected_result: BOUNDARY_CLOSED | BLOCKED
```

## 前置条件

- CV Receipt 存在、路径 canonical、verdict 为 `PASS`；
- CV snapshot 等于 `verified_snapshot`；
- `scope_violations` 为空；
- Evidence 已 finalize；
- changed-file set 可与当前 Slice 边界闭合；
- pre-commit HEAD、index 和 worktree 可核对。

## slice-output 命令工作流

在上述前置条件通过后，Committer 只对 packet 中的明确路径执行以下顺序；一次只
执行一条命令。若存在无法分离的无关 dirty file，返回 `BLOCKED`，不得扩大范围。

```text
git status --short --untracked-files=all
git diff --check
git diff --name-only -- <changed files> <tasks_path> <evidence_path> <cv_receipt_path>
git add -- <changed files>
git add -- <tasks_path>
git add -- <evidence_path>
git add -- <cv_receipt_path>
git diff --cached --name-only
git diff --cached --check
git commit -m "slice-output: <stage-id>-<slice-id>"
git status --short --untracked-files=all
```

不得使用 `git add .`、`git reset --hard`、`git checkout` 覆盖文件、隐藏错误输出、
命令链或手工写 Receipt。Committer 只返回 commit 事实；Slice Commit Receipt 仍由
Runtime 写入。

## 提交边界

Committer 只能提交：

- 当前 Slice 的实现代码和测试；
- 当前 Slice 的 tasks checkbox projection；
- Manifest 声明的 Slice Evidence；
- 已存在且已验证的 CV Receipt。

Committer 不创建 Slice Commit Receipt；Brain 将结构化结果交给 Runtime
admission，由 Runtime 验证 commit SHA、CV Receipt digest 和 snapshot 后写入
Receipt。Committer 不执行 Integration、Gate 或 Stage Review。

## 允许的结果

```yaml
result: BOUNDARY_CLOSED | BLOCKED
stage_id: <stage-id>
slice_id: <slice-id>
pre_commit_head: <40-char-sha>
slice_commit_sha: <40-char-sha | null>
commit_message: "slice-output: <stage-id>-<slice-id>"
changed_files: []
cv_receipt_ref: <canonical-path>
verified_snapshot: <sha256>
evidence_path: <path>
tasks_path: <path>
reason: <required for BLOCKED>
```

## 恢复

Committer session 只有在 HEAD、index、worktree 与 changed-file set 完全未变的
纯 runtime interruption 下才能继续；其他情况必须 fresh dispatch。
