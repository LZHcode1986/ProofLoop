/**
 * relay-contract.spec.ts — PO-S02-B-01 / PO-S02-B-04
 *
 * Public seam: `@proofloop/runtime` package entrypoint — the relay contract
 * exports (WorkerRelayPort / WorkerRelayStepInput / WorkerRelayStepResult /
 * WorkerDispatchPacket / WorkerResultEnvelope + validator).
 *
 * PO-S02-B-01: the fake port below contains ZERO Pi imports — it imports only
 * `@proofloop/runtime` types and vitest — proving that any host (including
 * S03's pi-subagents implementation) can satisfy the abstract port without
 * the runtime knowing anything about the host (ADR-012 / AWI-024 / HP-010).
 * Field names and literal values are asserted exactly (§3b WorkerRelayPort
 * Contract, Blueprint §6): execution 5 values, relay 3 values, mode 5 values,
 * continuation 2 values — no aliases, no open strings, no `any`.
 *
 * PO-S02-B-04: WorkerResultEnvelope validator matrix (§4 File / Artifact
 * Contracts, Blueprint §13): valid envelopes pass; invalid envelopes (wrong
 * outcome, missing actionToken, schemaVersion ≠ 1, changedFiles not an array,
 * wrong mode, malformed verificationRuns) fail closed with structured errors
 * locatable to the offending field — never partial acceptance, never silent
 * defaulting, never a boolean-only result.
 *
 * Expected values below are known-good literals taken from the authority
 * excerpts — not derived from the implementation.
 */
export {};
//# sourceMappingURL=relay-contract.spec.d.ts.map