/**
 * worker-step-service.spec.ts — PO-S02-B-02 / PO-S02-B-03
 *
 * Public seam: `WorkerStepService` exported from `@proofloop/runtime`, with a
 * `WorkerRelayPort` injected via the constructor (AWI-021).
 *
 * PO-S02-B-02: `executeStep` builds the canonical `WorkerDispatchPacket`
 * (protocolVersion: 1, resultContract.schemaVersion: 1) from the worker
 * action indication (stage/slice/task/mode/continuation/timeout) and the
 * caller-supplied actionToken / authorityRefs / git / scope / resultContract,
 * then calls the injected port's `executeStep` EXACTLY once (signal
 * passthrough) and returns the port's `WorkerRelayStepResult` unchanged
 * (Blueprint §12 / §5.2).  No direct success return, no repeated dispatch.
 *
 * PO-S02-B-03: `invalidateSlice` forwards projectRoot/parentSessionId/
 * stageId/sliceId to the injected port's `invalidateSlice` verbatim; the
 * runtime never holds or parses run IDs / session files (relay diagnostics
 * stay opaque — Blueprint #9.6 / #11 / #22), and executeStep is never
 * accidentally invoked by an invalidation.
 *
 * The fake port below contains ZERO Pi imports — only `@proofloop/runtime`
 * types + vitest + node builtins — proving the runtime depends solely on the
 * abstract port (ADR-012 / AWI-024 / HP-010).  Expected packet/input values
 * are known-good literals taken from the authority excerpts (Blueprint §12,
 * §3b), never derived from the service implementation.
 */
export {};
//# sourceMappingURL=worker-step-service.spec.d.ts.map