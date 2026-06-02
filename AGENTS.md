# ProofLoop Repository Operating Rules

## Rule Priority

- For change workflow, spec structure, proposal/design/tasks format, archive rules, and implementation process, follow `openspec/` as the single source of truth.
- Use this file for repo-specific operating rules that OpenSpec itself does not encode.
- When this file conflicts with any older archived methodology document, this file wins.

## Source Of Truth

- Workflow and change rules: `openspec/`
- Product intent and stage plan: `PRD.md`, `CLARIFY.md`
- Long-term technical specifications: `tech-spec.md`, `tech-spec/`
- Top-level technical constraints: `openspec/config.yaml`, `openspec/QUALITY-GATE.md`, schema and gate documents
- Repo-wide operating constraints: `AGENTS.md`

## Authority Order

When documents conflict, follow this priority:

1. `openspec/` — change workflow, schema, proposal/design/spec/tasks format, apply, and archive rules
2. `AGENTS.md` — repository-wide operating rules not encoded by OpenSpec
3. `tech-spec.md` — long-term technical constraints, architecture, state model, canonical objects, and testing posture
4. `PRD.md` — product intent, stage plan, and acceptance criteria for the active product scope
5. `CLARIFY.md` — resolved clarifications and decision history, when present

## Workflow Rule Ownership

- **Brain (L0)**: Owns user intent, PRD intake, acceptance criteria, stage planning, Proof Posture classification, and archive transition decisions.
- **Propose (L1)**: Owns one-stage OpenSpec decomposition into proposal, design, specs, and tasks. Adjusts verifier intensity based on Proof Posture.
- **Executor (L1)**: Owns apply orchestration, Worker dispatch, run ledger, Git Boundary Mode selection, Evidence Packet assembly, and rescue flow.
- **Worker (L2)**: Owns one implementation task only. Produces local structured evidence.
- **Committer (L2)**: Owns git boundary closure (commits, diff-snapshots, or no-ops).
- **Reality Verifier (L2)**: Owns code-reality readiness checks. Focuses on contradictions; unverified assumptions do not block P0/P1 by default.
- **Code Verifier (L2)**: Owns slice-level semantic verification based strictly on the `Executor Evidence Packet`.
- **Implementation Reviewer (L2)**: Owns stage-level integrated review and archive execution.

## Proof Posture Classifier

Brain classifies each stage into one of three Proof Postures before planning:
- **P0 Fast Proof** (Low Risk): Docs, tooling, setup tasks, or single-file bugfixes with no security, privacy, payment, or storage/migration impact. Dispatches do not run independent L2 verifiers by default.
- **P1 Stage Proof** (Default / Normal Risk): Ordinary features, multi-file changes affecting a single user loop, or multi-slice changes with clear boundaries. L2 verifier warnings/risks do not block handoff.
- **P2 Audit Proof** (High Risk): Changes involving authentication, authorization, security controls, privacy, payment, database migrations, cross-repo sync, concurrency consistency, or audit-level requirements. Enforces hard verifier gates (any warning blocks).

## Failure Attribution & Rescue Rules

Executor categorizes Code Verifier failures and routes rescue actions:
- `IMPLEMENTATION DEFECT` => Dispatch Worker Fix in `repair` mode (max 2 attempts per slice gate, then diagnose).
- `EVIDENCE DEFECT` => Dispatch `@worker` in Evidence Backfill mode (max 1 attempt) to reconstruct missing evidence without modifying product code. Do not rerun code implementation.
- `PROTOCOL DEFECT` => Executor or dispatcher must fix the dispatch packet or agent contract. Stop execution. Do not edit product code.
- `PLANNING DEFECT` => Stop execution and return to Propose or Brain. Planning owner repairs planning artifacts.

## Git Boundary Mode Rules

Executor chooses Boundary Mode based on risk:
- `per-task`: Commit after each task. Used in P2, security/migration tasks, or tasks with overlapping file scopes.
- `slice`: Commit at the end of the slice gate. Intermediate tasks record `diff-snapshot` receipts (changed files and scope check without commit). Used in P1.
- `final`: Commit at the end of the change. Intermediate tasks record `diff-snapshots`. Used in P0.
- `no-op`: No commit needed. Used for read-only or docs tasks.

## Subagent Reliability

- Reuse the existing `task_id` for any continuation of the same Change, Stage, Slice, or task. Do not start a fresh session to recover context.
- Start a new session only when the scope is new, the previous session is complete and no longer needed, or the reused session returns an unrecoverable error.
- Every subagent dispatch must include an expected timeout. Default to 120 seconds.
- On timeout, retry once with the same `task_id` and instruct the subagent to continue from the last completed checkpoint.

## Rules Lazy Loading

To optimize agent context window efficiency, detailed guidelines and specific role contracts are lazy-loaded on demand using `opencode.json` instructions:
- **Quality Gates & Checklists**: Read `openspec/QUALITY-GATE.md` and files in `openspec/gates/` only during proposal verification, task validation, or implementation check.
- **Contract & Handoff Packets**: Read `.agents/contracts/` schemas when dispatching or validating messages between agents.
- **Role Specifications**: Refer to `.opencode/agents/` for agent definitions and boundaries.
