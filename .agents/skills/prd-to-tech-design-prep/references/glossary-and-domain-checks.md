# Glossary and domain checks

Use when the PRD contains business terms, role names, or technical words that may be ambiguous.

## Terminology conflict checks

Look for terms that may mean multiple things:

- user
- customer
- account
- workspace
- project
- organization
- team
- owner
- admin
- member
- role
- permission
- document
- record
- item
- task
- agent

If a term has conflicting meanings, ask a scenario-based question.

```md
### Terminology Clarification Needed

**Term**
[term]

**Potential meanings**
- Meaning A:
- Meaning B:

**Question**
In this PRD, should `[term]` mean [A] or [B]?

**Recommended default**
[default]

**Severity**
Critical | Optional
```

## Simple technical glossary

| Technical term | Plain-language explanation |
|---|---|
| Login / account | A way for the product to recognize different users and keep their data separate. |
| Permission | A rule for who can see or change something. |
| Data saving | Keeping information so users can come back later and continue. |
| Database | A structured place where the product stores information. |
| Upload | Sending a file from the user's device into the product. |
| Import | Bringing data from another tool into this product. |
| Export | Taking data out of this product into a file or another tool. |
| Integration | A connection between this product and another service or tool. |
| Mobile friendly | The product can be used comfortably on a phone browser. |
| Admin | A user with extra controls for managing other users, content, or settings. |
| Audit log | A history of important actions, such as who changed what and when. |
| Deployment | Putting the product somewhere users can access it. |
| API | A structured way for one software system to talk to another. Avoid this term unless needed. |
| Schema | A plan for how information is organized. Avoid this term unless needed. |
| ADR | A short note explaining an important technical decision and why it was made. |

## Scenario pressure tests

Use the smallest concrete example that exposes the decision:

- If an admin leaves the organization, who owns the workspace data?
- If a user uploads the wrong file type, what should happen?
- If two users edit the same item, which change should win?
- If a user loses project membership but remains an organization owner, what should they still see?
- If an external integration fails, should the user retry, skip, or see an error?
