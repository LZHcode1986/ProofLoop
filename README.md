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
  → Executor dispatches exactly one Task per Worker
  → Worker writes Task Evidence before checking its checkbox
  → Executor reconciles persisted evidence and checkbox state
  → Executor dispatches mandatory `finalize-slice` Worker after all Tasks
  → Fresh CV (Code Verifier) adversarially challenges the finalized Slice
  → Executor integrates all Slices and runs Stage Gate
  → Stage Reviewer independently validates Stage Goal
  → Stage Close
  → Project Acceptance
```

### Quality control points

1. **Planner** gives each Worker a narrow, independently verifiable unit of work with explicit Proof Obligations.
2. **Worker** implements using TDD with tests bound to pre-approved Proof Obligations.
3. **CV (Code Verifier)** remains read-only and actively tries to refute the Worker's evidence before reading it.
4. **Stage Gate** verifies the integrated system actually runs and passes smoke scenarios.
5. **Stage Reviewer** performs a goal-first review from a different perspective than the Executor.

---

## Agent roles

| Agent | Authority | Key constraint |
|---|---|---|
| **Brain** | User entry point, global routing, authority documents | Does not write code or modify tasks/evidence |
| **Planner** | Stage → Slice → Task decomposition | Does not implement code |
| **Executor** | Stage runtime orchestration, Worker/CV dispatch, integration | `edit: deny`, no direct code edits |
| **Worker** | One dispatched Task at a time within a Slice | Reads only current Slice context, not full Stage Goal |
| **CV** (Code Verifier) | Adversarial verification of Worker claims | `edit: deny`, read-only, refutes before reading evidence |
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

Every Task completion contributes evidence toward closing its Slice's POs. A Slice is ready for CV only when all its POs are demonstrably satisfied.

### TDD, CV, Stage Gate, Stage Reviewer — what's the difference?

| Mechanism | What it does | Who runs it |
|---|---|---|
| **TDD** | Worker writes failing test (RED) → implements (GREEN) → refactors. Tests are bound to PO IDs. | Worker |
| **CV** (Code Verifier) | Read-only adversarial verifier that independently tries to refute a Worker's evidence. Can demand REPAIR (implementation fix), REPLAN (plan revision), or ESCALATION. | Executor dispatches |
| **Stage Gate** | Mechanical verification that all Slices are integrated, the system builds, starts, and passes smoke scenarios. Runs _before_ Stage Review. | Executor |
| **Stage Reviewer** | Independent goal-first review of the complete Stage. Reads code and evidence, designs counter-scenarios, then compares against the Executor's Stage Gate Receipt. | Brain dispatches |

---

## Important: `progress.md` is not an authority source

`progress.md` is a human-readable project status snapshot. It must never independently authorize a transition or completion verdict.

Before resuming work, always verify:
- Git state and working tree
- Active Stage manifest (`.proofloop/manifests/<stage-id>.json`)
- Manifest and Gate Receipts
- Per-Slice evidence files (`<stage>/evidence/<slice-id>.md`)
- Unresolved Findings

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
# Compile a Manifest from tasks.md
node .agents/runtime/dist/compile-manifest.js <tasks.md> .proofloop/manifests/<stage-id>.json

# Validate a Stage plan (with optional evidence directory)
node .agents/runtime/dist/validate-stage.js <tasks.md> .proofloop/manifests/<stage-id>.json [evidence-dir]

# Run Stage Gate steps (from compiled manifest)
node .agents/runtime/dist/run-stage.js .proofloop/manifests/<stage-id>.json [receipt-output-dir]

# Initialize per-Slice evidence files from Manifest
node .agents/runtime/dist/initialize-slice-evidence.js .proofloop/manifests/<stage-id>.json <delivery-root>

# Derive next action from current evidence state (file mode)
node .agents/runtime/dist/derive-next-action.js <state.json>

# Derive next action (inline JSON mode — useful for Executor with edit: deny)
node .agents/runtime/dist/derive-next-action.js --json '<json>'

# The state.json must conform to DeriveNextActionInput:
#   { "stage_gate": {"gate_run": bool, "gate_passed": bool},
#     "slices": [{...}],
#     "stage_committed": bool,
#     "stage_integrated": bool }
```

### CI / Verification

Stage plan validation uses two levels of gate:

1. **Mechanical Gate** — runs `npm run validate-stage` (TypeScript). This is the authoritative gate.
2. **Semantic Gate** — run by SPV (Stage Proof Verifier), a separate agent dispatched by the Planner.

### Validator implementation

All validators are implemented in TypeScript under `.agents/runtime/`. The authoritative Gate is `npm run validate-stage` (TypeScript).

---

## Continuation (Runtime Relay)

Continuation is managed by the **Brain** and **Executor** through persistent
artifacts, not by copying Session IDs. Session IDs are runtime relay information
only and are never persisted in manifests, tasks, evidence, receipts, progress,
or Git history.

### How it works

1. **Brain** dispatches a Stage by selecting the Executor with the Stage's compiled Manifest.
2. **Executor** runs the Stage Loop: for each Slice, it dispatches exactly one Task per Worker, reconciles persisted evidence and checkbox state after each task, dispatches mandatory `finalize-slice` after all Tasks, then starts a fresh CV for the finalized Slice before Committer/Integration.
3. At every dispatch point the Executor calls `derive-next-action` against the persisted evidence and Manifest to determine the exact next action — no session memory required. Scope validation is receipt-backed and closes through Committer plus Integration/post-merge; there is no standalone scope action.
4. If an agent session is lost, the Executor re-reads the current evidence state and Manifest, calls `derive-next-action`, and dispatches a fresh agent with the derived packet.
5. **Brain** picks the Stage Reviewer after the Executor returns `STAGE_GATE_PASSED`.

### Continuation rules by agent

| Agent | Continuation rule |
|---|---|
| **Brain** | Fresh Stage dispatch for each Stage. Does not resume mid-Stage — Executor owns Stage Loops. |
| **Planner** | Plan correction prefers the original Planner. New Stage or scope change requires a fresh Planner. |
| **Worker** | Consecutive tasks on the same Slice prefer the original Worker when session is alive. Changed Slice contract requires a fresh Worker. If session lost, Executor reconstructs from persisted evidence. |
| **CV** | Fresh CV session for each verification round. CV reads current evidence + code state; for a recheck, Executor may additionally supply only the bounded failed criterion, counterexample, failure signature, repair diff, and required recheck scope copied from the immediately preceding immutable failure receipt—not unrestricted prior receipt history. |
| **Stage Reviewer** | Fresh review session per Stage. Reads the integrated result, Gate Receipt, and all per-Slice evidence. |
| **Executor** | Session-persistent across the Stage Loop. If lost, Brain re-dispatches fresh Executor who reads evidence and continues. |

### Recovery without a continuation handle

If a continuation handle is lost, the **Executor** (or re-dispatched Executor):
1. Reads `.proofloop/manifests/<stage-id>.json` and each Slice's declared
   `evidence_path`
2. Calls `derive-next-action` to determine the exact next dispatch
4. Constructs a fresh dispatch packet from the persisted state
5. Does not resend unrelated full project context

---

## Project structure

```
.agents/
  contracts/           Agent dispatch contracts (Brain, Executor, Planner, etc.)
  runtime/             TypeScript framework tools (validator, compiler, runner)
  skills/              Agent skills (TDD, code review, diagnose)

delivery/stages/       Stage artifacts (tasks.md and Manifest-declared Slice Evidence); manifests live at `.proofloop/manifests/<stage-id>.json`
tech-spec/             Technical specifications, architecture, hard parts register
docs/                  Design documents and blueprints
tests/                 Test fixtures and framework tests
```

---

## License

ProofLoop v2 — Multi-agent software delivery framework.
