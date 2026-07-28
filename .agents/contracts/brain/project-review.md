# Brain Project Review Dispatch Contract

This contract describes the independent Project Review that occurs during PROJECT_ACCEPTANCE phase.

## Use when

All of the following conditions are met:
- All Architecture Work Items are closed
- All Stages have been ACCEPTED by Stage Reviewer
- The original PRD is still the current valid version
- No blocking Findings remain open
- ProjectAcceptanceManifest has been compiled
- Project E2E Gate Receipt has been written (verdict: PASS)

## Review method

`independent-goal-challenge` (project level)

The Project Reviewer does not re-run Stage Gates or Slice verifications. Instead, the Reviewer independently challenges whether the complete, integrated project satisfies the PRD Goals and Acceptance Criteria, using:

- ProjectAcceptanceManifest (path + digest)
- Project E2E Gate Receipt (path + digest)
- All Stage Review Receipts (one per Stage, with verdict and path)
- All Stage Gate Receipts (one per Stage, with verdict and path)
- All Architecture Work Item closure status
- Known limitations / deferred work summary

## Reviewer output format

The Reviewer produces a structured JSON file conforming to `ProjectReviewResultSchema`:

```jsonc
{
  "verdict": "PROJECT_ACCEPTED | PROJECT_REJECTED | PROJECT_BLOCKED",
  "reviewer": "string",                        // reviewer identity
  "reviewed_snapshot": "16-char hex digest",   // must match Manifest.expected_snapshot
  "project_manifest": {
    "path": "string",                          // path to manifest file
    "digest": "16-char hex"                    // must match computed manifest digest
  },
  "project_e2e_receipt": {
    "path": "string",                          // path to E2E receipt file
    "digest": "16-char hex"                    // must match actual E2E file digest
  },
  "criteria_results": [
    {
      "criteria": "AC-01",                     // acceptance criterion ID
      "passed": true,                          // whether this criterion is satisfied
      "notes": "optional explanation"          // optional notes
    }
  ],
  "findings": [
    {
      "category": "string",
      "description": "string"
    }
  ],
  "accepted_deviations": ["string", "..."],
  "reviewed_at": "ISO timestamp"
}
```

### Verdict semantics

**PROJECT_ACCEPTED**: All PRD Acceptance Criteria are satisfied in the integrated snapshot. All Stage Review verdicts are ACCEPTED. End-to-end scenarios pass. Unresolved deviations (if any) are explicitly documented.

**PROJECT_REJECTED**: One or more PRD Acceptance Criteria are not satisfied. At least one criteria_result has `passed: false`. The Reviewer must include findings describing the rejection reason.

**PROJECT_BLOCKED**: Project Acceptance cannot proceed due to external blockers, missing prerequisites, or environment issues.

## Review scope

### PRD Goals validation

- Every PRD Functional Requirement (FR-xxx) is addressed by at least one Stage Outcome
- Every PRD Acceptance Criterion (AC-xxx) is verifiable in the integrated snapshot
- No PRD requirement has been silently narrowed or removed

### Stage evidence audit

- Every Stage has a Stage Review Receipt with verdict ACCEPTED
- Every Stage has a Stage Gate Receipt with verdict PASS
- Receipt digests are consistent across manifest -> review -> gate (triple-binding)
- Receipts reference the same snapshot

### End-to-end scenarios

- Critical user journeys from PRD User Flow execute successfully on the integrated snapshot
- Error and edge-case scenarios from PRD are covered
- Non-functional requirements (NFR-xxx) are verifiably met

### Unresolved deviations

- Each unresolved deviation has a documented reason, impact assessment, and Brain acceptance
- Deferred work is tracked and does not block core user intent
- Degraded behavior is explicitly listed with mitigation plan

## Finalization

After the Reviewer produces the Project Review Result, Brain dispatches `finalize-project-review.js` to:

1. Read and validate all three inputs (Manifest, E2E Receipt, Review Result)
2. Cross-validate all digests and paths
3. Verify triple-binding of Stage evidence
4. Verify one-to-one coverage of acceptance criteria
5. Write final Project Review Receipt to `project-review.json`

The final receipt path is returned by the finalize script and persisted by Brain.
