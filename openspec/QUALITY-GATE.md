# ProofLoop Quality Gate Index

This index redirects to individual gates used across the ProofLoop workflow.

## Gates
- **Propose Readiness (Spec Verifier)**: [propose-readiness.md](gates/propose-readiness.md)
- **Reality Readiness (Reality Verifier)**: [reality-readiness.md](gates/reality-readiness.md)
- **Implementation Done (Code Verifier)**: [implementation-done.md](gates/implementation-done.md)
- **Archive Readiness (Implementation Reviewer)**: [archive-readiness.md](gates/archive-readiness.md)

## Rules
- `BLOCKER`: Fails the gate. Blocks execution/apply/archive.
- `WARNING`: Records risk but does not block.
- `NOTE`: Non-blocking notes or formatting items.
