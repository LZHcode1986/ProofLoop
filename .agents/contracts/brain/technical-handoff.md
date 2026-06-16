# Brain Technical Handoff Dispatch Contract

Use when PRD is confirmed and Brain needs plain-language technical preparation before formal design or planning. The receiving agent loads `prd-to-tech-design-prep`.

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
- Load `prd-to-tech-design-prep` and follow its workflow:
  1. Read the PRD first.
  2. Map product facts to implementation-impact areas.
  3. Generate user-answerable technical clarification questions.
  4. Create or update glossary.
  5. Run scenario pressure tests when needed.
  6. Produce Technical Design Input Brief.
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
