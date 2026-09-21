# Frontend Implementation Quality

Load this reference before the first frontend edit.

These are implementation defaults. Current Authority, a binding design prototype, and established project conventions override them when they conflict.

## Contents

1. Stay project-native
2. Structure around behavior
3. Put state with its owner
4. Bind real contracts
5. Implement complete interaction cycles
6. Use semantic and accessible interaction
7. Make responsiveness preserve the job
8. Use real content pressure
9. Keep performance proportional
10. Prove behavior, not markup

## 1. Stay project-native

- Reuse the existing framework, router, styling system, design system, tokens, form/data libraries, and test conventions.
- Inspect dependency files before importing third-party packages.
- Add a dependency only when it solves a demonstrated gap better than the existing stack.
- Prefer existing primitives and patterns over parallel abstractions.
- Keep new code colocated according to the repository's current convention rather than imposing a generic folder layout.

## 2. Structure around behavior

- Give a component one coherent responsibility; split when reuse, independent behavior, or testability earns the boundary.
- Prefer composition over configuration-heavy components.
- Separate remote-data orchestration from presentational rendering when doing so clarifies loading/error/data ownership.
- Avoid speculative component systems created for a single occurrence.
- Keep route/page-level orchestration visible enough that data flow and user flow remain understandable.

## 3. Put state with its owner

Choose the narrowest existing state mechanism that fits:

- component-local state for isolated interaction;
- URL state for shareable/navigation-relevant filters and selection;
- server-state mechanisms for remote data, cache, invalidation, and request lifecycle;
- shared client state only for genuinely cross-surface client-owned state.

Do not duplicate server-authoritative permissions, validation, ordering, or durable domain state as competing client truth.

Represent the UI-visible states required by `tech-spec/frontend.md`; implementation-only state may exist locally when it does not change product semantics.

## 4. Bind real contracts

- Use the canonical contract referenced by the handoff.
- Preserve auth, validation, pagination, ordering, retry, idempotency, and realtime semantics that matter to the frontend.
- Surface contract failures using the user-visible behavior defined by the handoff.
- Keep request/response adaptation at a clear seam instead of spreading backend field knowledge across unrelated components.
- Do not replace an unavailable backend capability with static data, a fake success path, or an undocumented mock.

## 5. Implement complete interaction cycles

A user action is incomplete until its material outcomes work.

For each in-scope flow, implement the handoff-defined states such as:

- initial/loading;
- ready;
- empty;
- editing/submitting;
- success;
- validation failure;
- request failure;
- unauthenticated/forbidden;
- conflict/stale/reconnect when applicable.

Use the states that actually exist; a generic checklist must not create product behavior.

Keep action names, resulting messages, and navigation outcomes consistent across the flow.

## 6. Use semantic and accessible interaction

- Prefer native semantic elements for buttons, links, inputs, headings, lists, tables, and dialogs.
- Give every control an accessible name and every form field a meaningful label.
- Preserve logical keyboard order and visible focus.
- Manage focus when opening/closing overlays or when a workflow transition would otherwise strand keyboard users.
- Announce material asynchronous status/error changes when visual updates alone are insufficient.
- Do not rely on color alone for status or validation.
- Respect reduced-motion preferences for nonessential motion.
- Preserve readable contrast and usable touch targets within the project's design system.

## 7. Make responsiveness preserve the job

Use the project's breakpoints and layout primitives.

At narrow widths, preserve:

1. the first-read object;
2. the primary action;
3. status or context required to make the next decision.

Collapse, reorder, or defer secondary information when needed. Merely stacking every desktop box vertically is not a responsive strategy.

Check long labels, large values, empty data, overflow, and localization-sensitive content where they can change the layout.

## 8. Use real content pressure

Prefer real project copy and representative data.

When fixtures are required, use content that exposes layout risk:

- short and long names/titles;
- empty collections;
- many items;
- large values;
- validation and error copy.

Avoid placeholder text that hides wrapping, hierarchy, or empty-state problems.

## 9. Keep performance proportional

Avoid obvious avoidable cost:

- repeated remote requests caused by render structure;
- unnecessary rerenders on continuous input;
- unbounded list rendering when the product can produce large sets;
- oversized assets or layout-shifting media;
- expensive motion that blocks interaction.

When performance is a stated requirement or an observed problem, measure before introducing optimization complexity.

## 10. Prove behavior, not markup

Prefer tests and runtime checks that observe what the user can do or see.

Cover the critical behavior and state transitions of the changed scope. Add lower-level tests only where they isolate meaningful logic.

Run the repository's relevant typecheck/build/lint/test commands. Preserve actual command outcomes as evidence; a green command is evidence for what it checks, not a universal quality verdict.
