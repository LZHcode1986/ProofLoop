# PRD review rubric

Score out of 100. Do not reward technical detail if product intent is unclear.

| Dimension | Points | What to check |
|---|---:|---|
| Users and scenarios | 10 | Target users, roles, and usage scenarios are clear. |
| Problem and goals | 10 | Problem is concrete; goals are not vague slogans. |
| User flow | 10 | Primary flow, branches, and failure cases are understandable. |
| Functional requirements | 15 | Core features are numbered, described, and tied to user value. |
| Acceptance criteria | 15 | Key features have user-observable completion conditions. |
| Scope boundaries | 10 | Must-have, simplified, out-of-scope, and later-version items are explicit. |
| Decision ledger | 10 | Confirmed, inferred, open, optional, and intake decisions are separated. |
| Constraints and risks | 10 | Login, data saving, roles, uploads, imports, mobile, privacy/payment/safety are handled or marked open. |
| Glossary | 5 | Business and necessary technical terms are explained simply. |
| AI handoff readiness | 5 | AI can generate technical clarification questions without guessing product intent. |

## Ratings

- 90-100: Ready. Can proceed to technical clarification.
- 75-89: Mostly ready. Fix a few important gaps.
- 60-74: Needs revision. Flow, acceptance, scope, or constraints need work.
- Below 60: Blocked. Do not proceed to development.

## Common blocking gaps

- No target user.
- No clear problem.
- Feature list without user flow.
- Acceptance criteria are missing or only technical.
- Non-goals are missing.
- Inferred assumptions are presented as confirmed.
- Terms such as user, customer, account, admin, project, workspace, or owner are used inconsistently.
- Product facts that affect implementation are missing, such as login, data persistence, roles, uploads, privacy, or mobile usage.
- Stage candidates, if present, are technical task breakdowns rather than product-delivery boundaries.
