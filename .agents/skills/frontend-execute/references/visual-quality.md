# Frontend Visual Quality

Load this reference only when the scope creates or materially reshapes a visual surface, or meaningful visual direction remains open after reading the binding prototype and incumbent design system.

This reference governs free visual HOW. It does not override Product/Technical Authority, a normative design prototype, or an established design system.

## 1. Read the surface before styling it

Identify the surface's dominant job:

- **Operate** — complete a task; prioritize scanability, state, controls, and repeat use.
- **Read** — understand information; prioritize hierarchy, rhythm, line length, and comprehension.
- **Persuade** — decide and act; prioritize message hierarchy, evidence, and a clear primary action.
- **Showcase** — experience the artifact itself; let the content lead and keep interface chrome subordinate.

Use the job to resolve open choices about density, hierarchy, motion, and layout.

## 2. Make choices belong to this product

Derive visual decisions from:

- the actual user and task;
- domain objects and information priority;
- brand/design-system material already present;
- the binding or reference-only prototype;
- real content and interaction states.

Treat generic visual conventions as candidates, not defaults. A familiar pattern is good when it serves the job; it is weak when it appears only because the model reaches for it automatically.

## 3. Build hierarchy before decoration

Make the first-read object and primary action visually obvious.

Use spacing, type, alignment, grouping, contrast, and density to express information priority before adding decorative effects.

Cards, borders, badges, shadows, gradients, and containers must communicate a real grouping, status, elevation, or interaction boundary. Remove them when they only make the screen look "designed."

## 4. Use typography as structure

- Keep a small, coherent type hierarchy.
- Use the project's existing type system when one exists.
- Choose new type only when visual freedom genuinely includes typography and the project can support it.
- Keep labels, body text, headings, and data roles distinct through consistent scale/weight/spacing.
- Use real copy pressure to validate wrapping and hierarchy.
- Keep action language concrete and consistent through the whole flow.

## 5. Use color and motion with purpose

- Start from existing semantic tokens and palette.
- Introduce new color only when the scope permits it and the color has a role.
- Keep status meaning stable across surfaces.
- Use motion to explain change, continuity, feedback, or attention.
- Prefer one meaningful motion idea over many unrelated effects.
- Respect reduced-motion behavior.

No color family, radius, gradient, or animation style is banned universally; the test is whether the choice is supported by this product and its visual authority.

## 6. Keep interaction visibly complete

Controls should communicate:

- default;
- hover when relevant;
- focus;
- active/pressed;
- disabled when the action is unavailable;
- pending when the action is in progress.

Empty, failure, permission, and success states should look like intentional parts of the same product rather than fallback components from another visual system.

## 7. Preserve the job across widths

Responsive design may change composition, density, and navigation pattern.

Keep the user's primary job and critical status visible. Do not preserve desktop geometry at the expense of mobile comprehension.

## 8. Run one bounded critique pass

After the surface works, inspect the actual implementation once for:

- unclear first read;
- equal visual weight where priorities differ;
- generic repeated containers;
- inconsistent spacing/radius/type/color;
- weak interaction feedback;
- narrow-screen loss of the primary job;
- decorative choices unsupported by the product;
- divergence from the binding prototype or incumbent visual system.

Fix the material issues together. Stop when the remaining differences are optional taste, not defects in the intended experience.

The independent review stage, not this self-critique, owns the final quality verdict.
