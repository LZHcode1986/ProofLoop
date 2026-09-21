# Frontend Runtime Evidence

Use the strongest evidence available for the claim being reviewed. Tool availability changes the evidence you can gather; it does not change the quality bar.

## Evidence fit

Different evidence supports different claims:

- **Live browser/runtime** — interaction, focus, responsive layout, rendered states, console/network behavior.
- **Screenshots/rendered fixtures** — hierarchy, layout, visual fidelity, visible state at a captured moment.
- **Automated UI tests** — repeatable user-visible behavior covered by the test.
- **Unit/integration tests** — isolated logic or seam behavior covered by the test.
- **Source/code inspection** — implementation structure and reachable semantics, but not proof of rendered appearance.
- **Build/type/lint output** — the specific static/build property checked by that command.

Do not generalize a narrow evidence type into claims it cannot support.

## Live review pass

When live runtime/browser access exists, prefer one bounded pass that captures the important matrix instead of repeatedly polishing the evidence.

For the reviewed scope, inspect:

1. primary flow;
2. required non-happy states;
3. representative narrow and wide viewports;
4. keyboard/focus interaction where applicable;
5. console/network behavior when contracts or failures matter.

Capture stable evidence pointers when the host supports them.

## Prototype comparison

When a normative design prototype exists, compare the implementation to the binding interpretation recorded in `tech-spec/frontend.md`.

Focus on the decisions declared binding:

- surface structure;
- hierarchy;
- navigation/flow;
- core interaction;
- other explicitly named visible constraints.

Do not invent pixel-perfect obligations that the handoff did not establish.

For a reference-only prototype, use differences as prompts for investigation, not automatic findings.

## Runtime absence

When no live browser/runtime evidence is available:

- use committed screenshots, visual fixtures, tests, source, or build artifacts when available;
- limit visual/interaction claims to what those artifacts prove;
- mark dimensions BLOCKED when their material conclusion truly requires missing runtime evidence;
- do not fabricate screenshots, console results, network outcomes, or performance measurements.

## Performance evidence

Measure performance only when:

- Authority defines a performance requirement;
- the reviewed interaction visibly feels slow/janky;
- runtime traces show a plausible material problem;
- large-data behavior is part of the product requirement.

Record the measured condition, device/runtime context when known, and observed result. Avoid performance findings based only on theoretical code style.

## Evidence record

For each material observation, record enough context to reproduce it:

- surface/route;
- state or triggering action;
- viewport/device class when relevant;
- data condition;
- command/test/runtime action;
- actual result;
- Authority or quality dimension it supports.

Evidence is strongest when another reviewer can reproduce the same observation without relying on the executor's narrative.
