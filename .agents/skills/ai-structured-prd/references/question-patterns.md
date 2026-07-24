# Clarification question patterns

Ask one question at a time. Each question should move the PRD materially closer to readiness.

## Highest-leverage question order

1. Target user or role unclear.
2. Desired outcome unclear.
3. Success criteria unclear.
4. Primary user flow unclear.
5. Must-have vs non-goal unclear.
6. Acceptance criteria unclear.
7. Product facts affecting technical design unclear: login, data saving, roles, uploads, integrations, mobile, privacy/payment/safety.
8. Terminology conflict.

## Plain-language technical concern translations

| Technical concern | Ask the user this instead |
|---|---|
| Authentication | Do users need to register or log in before using this? |
| Authorization / RBAC | Do different types of users see or do different things? |
| Database persistence | Should users be able to come back later and see previous data? |
| File/object storage | Do users need to upload images, documents, tables, audio, or video? |
| API integration | Does this need to connect with another tool or service? |
| Responsive design | Should this work well on phones, or is desktop web enough for version 1? |
| Payment integration | Does the product need online payment or subscriptions? |
| Privacy/security | Does it handle personal, private, payment, medical, legal, or sensitive data? |

## Scenario pressure test pattern

Use a concrete scenario when a concept is ambiguous:

```text
If [specific situation happens], should [user/role] be able to [action] or see [information]?
Recommended default: [default].
Severity: Critical | Optional
```

## Recommended default rules

- Default to simplest version 1 when the decision is not core to user value.
- Default to explicit login only when personal data, saved work, payments, or private information are involved.
- Default to web-first unless the user explicitly needs mobile-first.
- Default to no admin role unless moderation, user management, approval, or reporting requires it.
- Default to marking unclear decisions as `open`, not as confirmed.
