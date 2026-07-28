# ProofLoop v2

ProofLoop is a multi-agent software delivery framework that enforces end-to-end quality through structured delegation, adversarial verification, and goal-first review.

Unlike tools that focus on code generation or document templates, ProofLoop orchestrates a chain of specialized AI agents — each with bounded authority and a specific verification responsibility — to ensure that every delivered stage demonstrably satisfies the original product requirements.

---

## Core flow

```
Brain selects Stage
  → Planner decomposes into Slices and Tasks
  → Validator checks mechanical structure
  → SPV audits proof sufficiency
  → Worker implements one Slice with TDD
  → SCV adversarially challenges the Worker's claim
  → Executor integrates all Slices and runs Stage Gate
  → Stage Reviewer independently validates Stage Goal
  → Stage Close
  → Project Acceptance
```

### Quality control points

1. **Planner** gives each Worker a narrow, independently verifiable unit of work with explicit Proof Obligations.
2. **Worker** implements using TDD with tests bound to pre-approved Proof Obligations.
3. **SCV (Slice Challenge Verifier)** remains read-only and actively tries to refute the Worker's evidence before reading it.
4. **Stage Gate** verifies the integrated system actually runs and passes smoke scenarios.
5. **Stage Reviewer** performs a goal-first review from a different perspective than the Executor.

---

## Agent roles

| Agent | Authority | Key constraint |
|---|---|---|
| **Brain** | User entry point, global routing, authority documents | Does not write code or modify tasks/evidence |
| **Planner** | Stage → Slice → Task decomposition | Does not implement code |
| **Executor** | Stage runtime orchestration, Worker/SCV dispatch, integration | `edit: deny`, no direct code edits |
| **Worker** | One Slice implementation at a time | Reads only current Slice context, not full Stage Goal |
| **SCV** (Slice Challenge Verifier) | Adversarial verification of Worker claims | `edit: deny`, read-only, refutes before reading evidence |
| **Stage Reviewer** | Goal-first independent review of complete Stage | `edit: deny`, no re-running of full Stage Gate |
| **Committer** | Git boundary ownership | Does not edit content or judge quality |
| **Researcher** | External technical research | Does not edit repository |
| **Prototype** | Isolated technical experiments | Does not write production code |
| **General** | Bounded local tasks outside Active Stage | Does not fix Active Stage Slices or modify authority |

---

## Core concepts

### Slice vs Task vs Proof Obligation

| Concept | Scope | Who defines |
|---|---|---|
| **Slice** | A narrow but complete behavioral path within a Stage. Independently verifiable. | Planner |
| **Task** | An intermediate implementation goal within a Slice. Goal-oriented ("implement save behavior"), not a file checklist. | Planner |
| **Proof Obligation (PO)** | A specific, observable claim that must be proven for a Slice. "The API returns 403 for unauthenticated DELETE." | Planner |

Every Task completion contributes evidence toward closing its Slice's POs. A Slice is ready for SCV only when all its POs are demonstrably satisfied.

### TDD, SCV, Stage Gate, Stage Reviewer — what's the difference?

| Mechanism | What it does | Who runs it |
|---|---|---|
| **TDD** | Worker writes failing test (RED) → implements (GREEN) → refactors. Tests are bound to PO IDs. | Worker |
| **SCV** (Slice Challenge Verifier) | Read-only adversarial verifier that independently tries to refute a Worker's evidence. Can demand REPAIR (implementation fix), REPLAN (plan revision), or ESCALATION. | Executor dispatches |
| **Stage Gate** | Mechanical verification that all Slices are integrated, the system builds, starts, and passes smoke scenarios. Runs _before_ Stage Review. | Executor |
| **Stage Reviewer** | Independent goal-first review of the complete Stage. Reads code and evidence, designs counter-scenarios, then compares against the Executor's Stage Gate Receipt. | Brain dispatches |

---

## Important: `progress.md` is not an authority source

`progress.md` is a human-readable project status snapshot. It must never independently authorize a transition or completion verdict.

Before resuming work, always verify:
- Git state and working tree
- Active Stage artifacts (tasks.md, evidence.md)
- Manifest and Gate Receipts
- Evidence and unresolved Findings

---

## Installation and setup

### Prerequisites

- **Node.js** 18+ (for TypeScript runtime — authoritative Gate tooling)
- **npm** (for TypeScript runtime dependencies)

### TypeScript Runtime

The ProofLoop framework tools live in `.agents/runtime/`:

```bash
cd .agents/runtime
npm install
npm run build
```

Available scripts:

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript |
| `npm test` | Run unit tests |
| `npm run typecheck` | TypeScript type checking |
| `npm run validate-stage` | Validate Stage plan structure |
| `npm run compile-manifest` | Compile Manifest JSON from tasks.md |
| `npm run run-stage` | Execute Stage Runtime Proof |

### Usage examples

```bash
# Validate a Stage plan
node .agents/runtime/dist/validate-stage.js --stage S01 --path .

# Compile a Manifest
node .agents/runtime/dist/compile-manifest.js --stage S01 --path .

# Run Stage Gate steps
node .agents/runtime/dist/run-stage.js --stage S01 --path .
```

### CI / Verification

Stage plan validation uses two levels of gate:

1. **Mechanical Gate** — runs `npm run validate-stage` (TypeScript). This is the authoritative gate.
2. **Semantic Gate** — run by SPV (Stage Proof Verifier), a separate agent dispatched by the Planner.

### Validator implementation

All validators are implemented in TypeScript under `.agents/runtime/`. The authoritative Gate is `npm run validate-stage` (TypeScript).

---

## Continuation

ProofLoop currently uses **host-adapter (manual)** continuation:

- Session IDs are managed by the coding agent environment, not stored in Git
- To continue an interrupted session, copy the Session ID from the previous session and provide it to the new dispatch
- Automatic relay via plugin integration is a **future branch task** — not part of the current core flow

### Continuation rules by agent

| Agent | Continuation rule |
|---|---|
| **Planner** | Plan correction prefers the original Planner. New Stage or scope change requires a fresh Planner. |
| **Worker** | Consecutive tasks on the same Slice prefer the original Worker. Changed Slice contract requires a fresh Worker. |
| **SCV** | Pure execution interruption with unchanged inputs may continue. Changed code/tests/Contract requires fresh SCV. |
| **Stage Reviewer** | Pure execution interruption may continue. Changed Stage content requires fresh Reviewer. |

### Session loss degradation

If a continuation handle is lost:
1. Read the current target Contract
2. Read the current codebase state and working diff
3. Read the current Finding (if any)
4. Read related Gate Receipts and SCV Receipts
5. Create a fresh recovery Agent with bounded objective
6. Do not resend unrelated full project context

---

## Project structure

```
.agents/
  contracts/           Agent dispatch contracts (Brain, Executor, Planner, etc.)
  runtime/             TypeScript framework tools (validator, compiler, runner)
  skills/              Agent skills (TDD, code review, diagnose)

delivery/stages/       Stage artifacts (tasks.md, evidence.md)
tech-spec/             Technical specifications, architecture, hard parts register
docs/                  Design documents and blueprints
tests/                 Test fixtures and framework tests
```

---

## License

ProofLoop v2 — Multi-agent software delivery framework.
