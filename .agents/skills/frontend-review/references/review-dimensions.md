# Frontend Review Dimensions

Apply every dimension that is material to the reviewed surface. A dimension is not a checklist to fill mechanically; challenge the ways that dimension could falsify the claimed frontend quality.

## Contents

1. Authority fidelity
2. Product legibility and flow
3. State and interaction completeness
4. Accessibility
5. Responsive and content robustness
6. Visual coherence and product specificity
7. Runtime quality
8. Finding threshold

## 1. Authority fidelity

Check whether the implementation realizes the current frontend handoff and the canonical refs it depends on.

Challenge:

- correct backend binding and real data path;
- auth/permission/error semantics;
- ordering, pagination, search, retry, realtime, and consistency rules when material;
- required UI-visible states;
- cross-boundary constraints;
- absence of fake/mock behavior where real capability is required.

A visual match cannot compensate for incorrect contract behavior.

## 2. Product legibility and flow

Check whether the user can understand and complete the intended job.

Challenge:

- first-read object or decision;
- primary action;
- sequence of surfaces/actions;
- navigation continuity and escape/back paths;
- information priority;
- copy/action naming consistency;
- empty/error guidance that helps the user recover.

A simple interface may pass. A polished interface that hides the real job may fail.

## 3. State and interaction completeness

Exercise the material interaction cycle.

Check:

- initial/loading/submitting;
- ready/empty;
- validation/request failure;
- success/confirmation;
- unauthenticated/forbidden/not-found;
- conflict/stale/reconnect when defined;
- disabled/pending behavior;
- focus and feedback after state transitions.

Use only states supported by the handoff or actual implementation requirement.

## 4. Accessibility

Challenge the actual interaction, not only the markup intent.

Check where applicable:

- semantic control choice;
- accessible names and labels;
- logical keyboard order;
- visible focus;
- overlay/dialog focus behavior;
- status/error announcement;
- non-color-only meaning;
- contrast/readability;
- reduced-motion behavior;
- touch-target usability.

A tool-generated accessibility score is supporting evidence, not a substitute for the relevant interaction challenge.

## 5. Responsive and content robustness

Check whether the user's job survives realistic width and content pressure.

Challenge:

- narrow and wide layouts;
- long labels/titles and large values;
- empty and large collections;
- overflow and truncation;
- localization-sensitive expansion when relevant;
- preservation of primary action and critical status;
- responsive navigation and table/data-density behavior.

"Everything stacks" is not sufficient if priority or operability is lost.

## 6. Visual coherence and product specificity

Judge visual decisions by their relationship to the product and its visual authority.

Check:

- hierarchy follows actual information priority;
- spacing, alignment, type, radius, color, and icon language are internally coherent;
- components belong to one design system;
- binding prototype decisions are preserved;
- reference-only prototype intent is respected without false pixel obligations;
- decoration has a communicative role;
- interaction states look like the same product;
- generic defaults do not erase product-specific hierarchy or identity.

Do not create universal bans on palettes, gradients, cards, serif/sans fonts, or motion. A choice fails when it is unsupported or harmful here, not because it belongs to a disliked trend.

## 7. Runtime quality

Apply this dimension when runtime behavior is material or evidence exposes a concern.

Challenge:

- console/runtime errors;
- failed or duplicated network requests;
- stale/incorrect request sequencing;
- interaction latency severe enough to affect the job;
- layout shifts or asset behavior that disrupt use;
- rendering of large or repeated data when the product expects it.

For performance claims, measure the actual symptom or stated requirement. Do not fail an implementation on speculative micro-optimization.

## Finding threshold

Retain a finding only when the observed defect has a concrete user/Authority consequence and a reproducible oracle.

Optional aesthetic preference, alternative-but-valid component structure, or harmless implementation variation is not a material finding.
