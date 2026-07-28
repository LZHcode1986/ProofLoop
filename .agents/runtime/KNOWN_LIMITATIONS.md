# ProofLoop v2 — Known Limitations

Version: RCM-1.0
Date: 2026-07-29

## 1. Git 祖先关系校验未实现
Stage Snapshot 与 Project Final Snapshot 之间的 Git 祖先/可达性校验尚未实现。
当前只校验字符串相等性。允许多个 Stage 引用不同 Snapshot，但 RC 阶段不证明 Stage Snapshot 已合入 Final Snapshot。

## 2. 独立 Project Reviewer 为模拟
当前 Project Reviewer 是一个外部 JSON 输入（project-review-result.json），
由人工或外部 Agent 生成。Reviewer 本身尚未作为独立 Agent 角色实现。

## 3. 跨平台服务管理差异
Windows 上无 SIGKILL，通过 taskkill /F 模拟。
PID 文件和服务注册表未在跨平台场景下全面测试。

## 4. Manifest digest 依赖 Zod 解析顺序
computeCanonicalJsonDigest 是确定性的，但其输出依赖 Zod Schema 定义的字段顺序。
Schema 变更可能导致 digest 变化。

## 5. 最终 Receipt 不包含签名
Project Review Receipt 不包含数字签名或公钥基础设施。
信任基于文件系统权限和 Agent 隔离，而非密码学验证。
