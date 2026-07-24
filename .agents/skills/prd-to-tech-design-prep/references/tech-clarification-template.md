# Technical clarification checklist template

Use this after the PRD is confirmed. Keep questions answerable by a non-technical user.

```md
# Technical Clarification Checklist

## 1. Summary of PRD understanding
[One paragraph: what will be built, for whom, and main scope boundaries.]

## 2. Critical questions
| ID | Question | Why it matters | Recommended default | Related PRD section |
|---|---|---|---|---|
| TQ-001 | [plain-language question] | [future implementation impact] | [default] | [PRD ref] |

## 3. Optional questions
| ID | Question | Why it matters | Recommended default | Related PRD section |
|---|---|---|---|---|
| TQ-101 | [plain-language question] | [impact] | [default] | [PRD ref] |

## 4. Accepted defaults
| Decision | Default accepted | Why acceptable |
|---|---|---|
| [decision] | [default] | [reason] |

## 5. Blockers
- [missing product decision that blocks technical design]

## 6. Recommended next step
Ready for technical design / answer one critical question / return to PRD review.
```

## Common question bank

| Product area | Plain-language question | Typical default |
|---|---|---|
| Login | Do users need to register or log in before using this? | No login for public/simple tools; login if personal data is saved. |
| Saved data | Should users be able to return later and see previous work? | Yes if the product manages user-specific work. |
| Roles | Are there different kinds of users, such as normal user and admin? | No separate admin unless management/moderation is needed. |
| Permissions | Should some users be blocked from seeing or changing certain information? | Keep all data private to the owner unless collaboration is required. |
| Uploads | Do users need to upload files, images, PDFs, spreadsheets, audio, or video? | No uploads unless central to the workflow. |
| Integrations | Does this need to connect to another tool, such as email, Google Drive, Notion, Slack, WeChat, Feishu, Stripe, or a database? | No external integration for version 1 unless required. |
| Mobile | Must it work well on phones, or is desktop web enough? | Desktop web first; phone readable if low cost. |
| Notifications | Should users receive email, SMS, push, or in-app reminders? | In-app only unless time-sensitive. |
| Payment | Does the product need payment, subscription, invoices, or usage limits? | No payment in version 1 unless business validation requires it. |
| Privacy | Does it handle personal, sensitive, private, medical, legal, financial, or children's data? | Treat as private and minimize collection. |
| Content safety | Can users create or upload content that needs moderation? | No moderation unless public sharing exists. |
| Audit/history | Does the product need to show who changed what and when? | No audit log unless teams/admins/compliance require it. |
