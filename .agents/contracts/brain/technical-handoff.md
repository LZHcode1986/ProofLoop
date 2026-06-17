# Brain Technical Handoff Dispatch Contract

Use when PRD is confirmed and Brain needs plain-language technical preparation before formal design or planning. Brain loads `prd-to-tech-design-prep` before this dispatch.

Packet title:

Brain Dispatch: Technical Handoff

Required fields:
- PRD Path
- PRD Context Path (if exists)
- Confirmed Decisions Summary
- Accepted Defaults
- Known Glossary Terms
- Expected Output

Rules:
- One handoff dispatch per confirmed PRD.
- Do not reopen product discovery.
- Accept PRD scope boundaries as given.
- The receiving agent does not load skills. The receiving agent only persists Brain-confirmed Technical Design Input Brief content using `general-edit` boundaries.
- Output a Technical Design Input Brief for downstream design or planning.
- Do not generate architecture, schema, API contracts, or task breakdown.

Packet shape:

Brain Dispatch: Technical Handoff

PRD Path:
PRD Context Path:
Confirmed Decisions Summary:
- <decision>
Accepted Defaults:
- <area>: <default>
Known Glossary Terms:
- <term>: <explanation>
Expected Result:
- Technical Design Input Brief ready
- Clarification required (blocking)
