---
name: frontend-review
description: Independent read-only frontend review workflow for judging implemented user-facing UI against tech-spec/frontend.md, its canonical Technical Authority refs, optional design-prototype evidence, and the actual implementation/runtime. Use after frontend execution or bounded frontend repair to challenge product fidelity, contract/state behavior, accessibility, responsiveness, visual coherence, and material runtime quality. Do not use to implement fixes, author frontend Authority, or replace the host review lifecycle/result schema.
disable-model-invocation: true
---

# frontend-review

## Mission

Independently challenge an implemented frontend against its current handoff and observable reality.

Produce evidence-backed findings or a supported pass condition without modifying the implementation.

For ProofLoop frontend review, treat `tech-spec/frontend.md` as the frontend review basis. Follow its canonical refs when exact contract, architecture, acceptance, or cross-boundary semantics matter.

## Review independence

Build the review lens from Authority and the review snapshot before reading executor conclusions.

Use these sources in this order:

1. authorized review scope and exact implementation snapshot;
2. `tech-spec/frontend.md`;
3. canonical refs named by `frontend.md` when needed;
4. the design prototype named by `frontend.md`, with its declared normative/reference-only role;
5. incumbent design-system/code reality needed to judge consistency;
6. actual rendered/runtime/code/test evidence;
7. execution-stage evidence only as supporting evidence after independent observation.

Treat implementation evidence as evidence, not Authority.

A normative design prototype is binding only for the visible decisions that `frontend.md` says it establishes. A reference-only prototype informs intent, not pixel-level conformity. When no prototype exists, review against the handoff, incumbent design system, and general quality floor without inventing an absent visual brief.

## Core workflow: Ground → Observe → Challenge → Verify → Verdict

### 1. Ground

Reconstruct the intended frontend behavior from current Authority.

Identify for the review scope:

- user job and primary outcome;
- first-read object or information priority when material;
- surfaces, flows, actions, and reads;
- backend bindings and cross-boundary constraints;
- required UI-visible states;
- responsive or accessibility constraints already made explicit;
- design-prototype role, if any;
- open handoff gaps that could limit reviewability;
- exact implementation snapshot being reviewed.

Do not use the executor's summary to fill missing Authority.

**Completion criterion:** the reviewer can state what the user must be able to perceive/do, which Authority establishes it, and exactly which implementation snapshot is under review.

### 2. Observe

Inspect the implementation before forming findings.

Prefer direct runtime/rendered evidence when available. Inspect enough states and widths to observe the actual experience, not only the happy-path source code.

Load `references/runtime-evidence.md` when live browser/runtime, screenshots, rendered fixtures, or performance evidence are available or materially required.

Record observable facts before interpretation:

- what appears;
- what can be interacted with;
- what changes after interaction;
- what the runtime/network reports when relevant;
- what happens at representative widths;
- what happens in required non-happy states.

When runtime evidence is unavailable, use the strongest available code/test/render evidence and narrow claims to what that evidence can support.

**Completion criterion:** the evidence set covers the primary flow plus every material state/viewport needed for the review, or the missing evidence is explicit enough to block the affected conclusion.

### 3. Challenge

Read `references/review-dimensions.md` and challenge every applicable dimension independently.

Design counterexamples rather than checking only declared success paths.

Challenge at least:

- Authority fidelity;
- product legibility and flow;
- state and interaction completeness;
- accessibility and responsive robustness;
- visual coherence and product specificity;
- material runtime/performance quality when the requirement or evidence makes it relevant.

One strong dimension must not mask a failure in another. Do not average quality into a generic score.

Use the binding prototype for fidelity challenges only to the degree declared in `frontend.md`.

**Completion criterion:** every applicable dimension has been actively challenged with at least one concrete observation, scenario, or counterexample rather than inferred from implementation intent.

### 4. Verify

Turn only supported defects into findings.

Every material finding must contain:

- affected surface/state/viewport;
- observed behavior;
- Authority or quality-floor basis;
- reproducible evidence or stable evidence pointer;
- user-visible consequence;
- a verification condition that would prove the defect resolved.

A finding that rests only on taste, trend, or "make it more modern/premium" language is unsupported.

Separate three cases:

- implementation defect → supported finding;
- missing/contradictory Authority → blocked review or Authority gap, not a design guess;
- optional refinement → note only when the host review format allows non-blocking observations; never elevate it into a material finding.

Read executor evidence at this stage, if provided, to corroborate observations or expose untested areas. It cannot convert an unverified claim into PASS.

Suggested repair direction may describe the observable outcome that needs to change. Do not prescribe mandatory component/CSS/state-management HOW.

**Completion criterion:** every retained finding is reproducible, Authority-grounded or quality-floor-grounded, and has a clear resolution oracle; unsupported taste comments have been removed.

### 5. Verdict

Return the review through the host workflow's review/result schema.

If no host schema exists, use these semantic outcomes:

- **PASS** — all applicable dimensions were independently challenged, evidence was sufficient, and no material finding remains;
- **FINDINGS** — at least one material implementation defect is supported;
- **BLOCKED** — required Authority, prototype evidence, runtime evidence, or review snapshot is missing/contradictory enough that a material conclusion cannot be made.

Do not create a new lifecycle, persistence mechanism, route code, or acceptance fact. The host review workflow owns those semantics.

A PASS must bind to the exact reviewed implementation snapshot and evidence basis. Passing tests or executor self-check alone is insufficient.

**Completion criterion:** the returned verdict is supported by the completed dimension challenges and exact snapshot; every non-PASS conclusion includes concrete evidence and affected scope.

## Finding discipline

Prefer a small set of material findings over a long list of taste edits.

A material finding changes at least one of:

- required user outcome;
- contract/state fidelity;
- ability to understand or complete the primary job;
- accessibility of an in-scope interaction;
- responsive preservation of the job;
- fidelity to a binding prototype/design system;
- a measured performance requirement;
- a quality-floor defect severe enough to make the interface misleading, unusable, or visibly incoherent.

Visual distinctiveness is not an end in itself. Treat generic-looking UI as a finding only when the unsupported default obscures hierarchy, weakens product-specific meaning, contradicts established visual authority, or creates a material usability/consistency defect.

## Read-only boundary

Keep the entire review read-only.

Do not edit code, tests, `tech-spec/frontend.md`, canonical Authority, design artifacts, or accepted plans.

Do not dispatch repair work from this Skill. Return evidence to the host workflow; repair ownership and lifecycle remain external.

## Recheck method

Use bounded recheck only when Authority, review scope, and the meaning of the affected surfaces remain current.

On recheck:

1. reread the finding and current snapshot;
2. inspect the repair diff/effect;
3. rerun the finding's resolution oracle;
4. inspect directly affected neighboring behavior;
5. return the host verdict for that bounded scope.

Require a fresh full review when material Authority, prototype binding, review scope, or reviewed surface intent changes. This is review methodology only; the host lifecycle decides how a fresh reviewer is created.

## Progressive references

- Load `references/review-dimensions.md` for every review.
- Load `references/runtime-evidence.md` when rendered/runtime evidence is available or necessary for the claim.
- Keep source-specific aesthetic rules outside this Skill unless they are actually part of the project's Authority or design system.

## Completion criteria

`frontend-review` is complete only when:

- the review lens was reconstructed independently from frontend Authority;
- the exact implementation snapshot is bound;
- all applicable quality dimensions were challenged without score averaging;
- runtime/rendered claims use evidence appropriate to those claims;
- design-prototype fidelity follows its declared normative/reference-only role;
- every material finding is observable, grounded, and verifiable;
- executor evidence remains supporting rather than authoritative;
- the reviewer stayed read-only and returned no mandatory implementation HOW;
- the host workflow, not this Skill, owns lifecycle and durable verdict semantics.
