---
name: frontend-execute
description: Frontend implementation workflow for turning an authorized frontend handoff into production UI. Use when implementing or modifying user-facing frontend behavior from tech-spec/frontend.md, a bounded frontend task, optional design-prototype evidence, and current code reality. Covers implementation choices, UI states, accessibility, responsive behavior, visual quality, runtime self-check, and delivery evidence. Do not use to author frontend Technical Authority, plan work, redefine backend contracts, or issue an independent review verdict.
disable-model-invocation: true
---

# frontend-execute

## Mission

Implement the frontend behavior authorized by the current handoff and scope, then return a self-verified implementation for independent review.

For ProofLoop frontend delivery, treat `tech-spec/frontend.md` as the primary frontend handoff. Follow its pointers to canonical Technical Authority when the implementation needs exact contract semantics.

Use current code reality to decide HOW. Do not let implementation convenience change WHAT the handoff requires.

## Authority and freedom

Read the smallest current basis needed for the authorized scope:

1. authorized task/scope from the host workflow;
2. `tech-spec/frontend.md` for frontend scope, flows, backend bindings, UI-visible states, cross-boundary constraints, design-prototype role, and open handoff gaps;
3. canonical refs named by `frontend.md` when exact backend or architecture semantics matter;
4. the design prototype when `frontend.md` names one;
5. current frontend code, routes, components, design system, tokens, dependencies, tests, and runtime conventions needed to decide implementation HOW.

Use this precedence:

- Product/Technical Authority owns required behavior and system boundaries.
- A normative design prototype owns the visible decisions that `frontend.md` says it establishes.
- Current code reality owns project-native implementation conventions unless Authority explicitly requires a change.
- This Skill supplies execution method and quality defaults only where higher authority leaves freedom.

When a design prototype is reference-only, preserve its useful structure and intent without treating every pixel as binding.

When no design prototype exists, implement from `frontend.md` and the incumbent design system. Choose only the visual/interaction HOW needed to make the authorized behavior coherent.

## Core workflow: Ground → Translate → Build → Exercise → Refine → Deliver

### 1. Ground

Read the current handoff, its relevant canonical refs, the authorized mutation scope, and the existing frontend seams before editing.

Identify:

- in-scope surfaces, flows, actions, reads, and UI-visible states;
- backend bindings and cross-boundary constraints;
- the design prototype's role, if any;
- open handoff gaps that intersect the current scope;
- existing routes, components, primitives, tokens, data/state patterns, and dependencies that should be reused;
- existing tests and runnable checks that can prove the change.

Treat a material open handoff gap as unresolved Authority, not as implementation freedom. Continue past unrelated gaps.

**Completion criterion:** every in-scope user-visible behavior has a current Authority basis and an identifiable implementation seam, or the blocking gap is explicitly reported before mutation.

### 2. Translate

Choose the smallest project-native implementation model that realizes the handoff.

Map in-scope behavior to concrete HOW:

- route/surface ownership;
- component boundaries;
- data-fetch and mutation seams;
- local/URL/server/shared state ownership;
- user-visible state transitions;
- responsive behavior;
- accessibility semantics;
- design-system primitives and tokens.

Keep this translation local to the implementation. Do not turn it into a new planning artifact or a second frontend spec.

Read `references/implementation-quality.md` before the first UI edit.

Read `references/visual-quality.md` only when the scope creates or materially reshapes a visual surface, or when meaningful visual direction remains open after reading the prototype/design system. A narrow behavior-only patch inside an established surface does not need that reference.

**Completion criterion:** every in-scope requirement has an implementation path that fits the current stack and does not require new product behavior, backend semantics, or unrelated architecture.

### 3. Build

Implement a coherent vertical slice of the authorized frontend behavior.

Preserve existing framework, routing, styling, design-system, data, and test conventions unless a concrete requirement makes them inadequate.

Implement the real contract and real visible states named by the handoff. Keep backend authority on the backend side; client convenience state must not become a competing source of truth.

Build for real content and interaction rather than a static success screenshot.

Prefer reuse and composition over new abstraction. Add a dependency only when the current project cannot satisfy the requirement cleanly with existing capabilities.

**Completion criterion:** all in-scope surfaces/actions/reads and required UI-visible states are implemented against the authorized contracts, with no placeholder behavior standing in for required functionality.

### 4. Exercise

Run the implementation through the user-visible conditions that matter for this scope.

Exercise:

- primary flow and critical branches;
- loading/submitting/empty/error/auth/permission/conflict states that the handoff actually defines;
- realistic short, long, empty, and repeated content where it can change layout or behavior;
- keyboard/focus behavior for interactive surfaces;
- narrow and wide layouts when responsiveness is in scope;
- relevant automated tests, type/build checks, and existing project checks.

Use live browser/runtime evidence when the environment provides it and it materially improves confidence. Tool absence does not authorize inventing runtime results; record the evidence actually available.

Classify failures before editing further:

- implementation defect → repair locally;
- stale or contradictory handoff/contract → report Authority gap;
- unrelated pre-existing failure → preserve evidence and avoid widening scope.

**Completion criterion:** every material in-scope state has been exercised by an available oracle, and every observed failure is either fixed or explicitly classified with evidence.

### 5. Refine

Make one bounded quality pass over the implemented surface.

Refine only observable issues that affect the user's job or the established visual language:

- hierarchy and scanability;
- spacing and alignment;
- content clarity;
- interaction feedback;
- responsive preservation of the primary job;
- visual consistency with the incumbent system or binding prototype;
- obvious generated/default-looking choices where Authority left visual freedom.

Keep product-specific simplicity when it already works. Refinement must not become redesign by momentum.

If `references/visual-quality.md` was loaded, apply its rules against the actual implemented surface, not as a preselected aesthetic.

**Completion criterion:** no known material usability, consistency, responsiveness, or visual-intent defect remains from the bounded pass; any optional polish is left out of the completion claim.

### 6. Deliver

Run the final scope-appropriate checks and prepare execution evidence for the host workflow or downstream reviewer.

Report:

- changed frontend files;
- implemented surfaces/actions/states;
- canonical contract refs actually exercised;
- commands/tests/runtime checks and actual outcomes;
- prototype/design-system fidelity notes when relevant;
- remaining unknowns or blocked gaps;
- known pre-existing failures kept outside scope.

Return implementation evidence, not a review verdict. Independent review owns PASS/FINDINGS or equivalent judgment.

**Completion criterion:** the authorized frontend scope is implemented, the final checks are evidenced, the diff stays inside authorized scope, and no unresolved implementation failure is hidden behind a completion claim.

## Gap discipline

Stop implementation for the affected behavior when safe execution would require inventing any of these:

- a missing backend capability or contract;
- product behavior absent from the handoff;
- permission/error semantics that change user outcomes;
- a required surface/flow decision;
- a binding design decision that a normative prototype was supposed to provide.

Use the host workflow's existing blocker/Authority-gap mechanism. This Skill defines no new workflow status or error enum.

Implementation choices such as component structure, state organization, styling technique, or animation library are HOW and remain local unless Authority already constrains them.

## Mutation discipline

Modify only the authorized frontend implementation/test scope.

Treat `tech-spec/frontend.md`, its upstream Technical Authority, accepted plans, and reviewer artifacts as read-only execution inputs unless the host workflow explicitly authorizes an Authority update.

Keep backend contract changes out of this Skill. A required backend change is a handoff gap, not a frontend workaround.

## Progressive references

- Always load `references/implementation-quality.md` before the first frontend edit.
- Load `references/visual-quality.md` only for material visual creation/reshaping or meaningful open visual direction.
- Do not load either reference merely to restate rules already fixed by a normative design prototype or incumbent design system.

## Completion criteria

`frontend-execute` is complete only when:

- the implementation is grounded in the current frontend handoff and relevant canonical refs;
- project-native stack and code reality determine HOW unless Authority requires otherwise;
- all in-scope frontend behaviors and required UI-visible states are implemented without mocks or invented backend semantics;
- accessibility and responsive behavior are addressed where the surface requires them;
- material flows/states are exercised with real available evidence;
- visual refinement is bounded and product-specific rather than a generic redesign;
- final checks and remaining unknowns are reported;
- the Skill returns execution evidence and does not self-issue the independent review verdict.
