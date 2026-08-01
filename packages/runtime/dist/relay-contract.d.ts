/**
 * @proofloop/runtime — WorkerRelayPort contract types & WorkerResultEnvelope validator
 *
 * PO-S02-B-01: `WorkerRelayPort` / `WorkerRelayStepInput` / `WorkerRelayStepResult`
 * public contract (§3b WorkerRelayPort Contract, Blueprint §6).  The port is the
 * ONLY seam through which the runtime executes worker steps — the runtime never
 * imports or references any host (pi-subagents) implementation (ADR-012 / AWI-024 /
 * HP-010).  A fake port implemented purely from these types proves any host can
 * satisfy the seam.
 *
 * PO-S02-B-04: `WorkerResultEnvelope` public type + fail-closed validator (§4 File /
 * Artifact Contracts, Blueprint §13).  The envelope is non-authoritative (Admission
 * consumes and deletes it); a Child-reported `completed` outcome never implies Task
 * completion by itself (Blueprint #13 / #9.6).
 *
 * All closed literal sets are declared `as const` and re-exported — no open
 * strings, no field aliases, no `any`.  Relay diagnostics (runRef etc.) stay
 * opaque: the runtime never parses them and they never enter business Receipts
 * (Blueprint #9.6 / #11 / #22).
 *
 * Types + one validator only — no behavior, no I/O, zero host imports.
 */
/** Worker step modes — closed 5-value set. */
export declare const WORKER_STEP_MODES: readonly ["implement-task", "recover-task", "finalize-slice", "diagnose", "repair"];
export type WorkerStepMode = (typeof WORKER_STEP_MODES)[number];
/** Continuation policy — closed 2-value set. */
export declare const WORKER_CONTINUATIONS: readonly ["prefer", "fresh"];
export type WorkerContinuation = (typeof WORKER_CONTINUATIONS)[number];
/** Execution status of a relayed worker step — closed 5-value set. */
export declare const WORKER_EXECUTIONS: readonly ["completed", "needs-attention", "failed", "timed-out", "cancelled"];
export type WorkerExecution = (typeof WORKER_EXECUTIONS)[number];
/** Relay transport kind — closed 3-value set. */
export declare const WORKER_RELAY_KINDS: readonly ["spawned", "resumed", "fresh-fallback"];
export type WorkerRelayKind = (typeof WORKER_RELAY_KINDS)[number];
/** Worker result outcome — closed 4-value set. */
export declare const WORKER_OUTCOMES: readonly ["completed", "blocked", "needs-decision", "failed"];
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];
/** Relay process-terminal status — closed 3-value set (§3b / Blueprint §6). */
export declare const WORKER_RELAY_TERMINALS: readonly ["observed", "unknown", "not-supported"];
export type WorkerTerminal = (typeof WORKER_RELAY_TERMINALS)[number];
/**
 * Immutable dispatch packet handed to the relay port.
 *
 * `protocolVersion` and `resultContract.schemaVersion` are the literal `1` —
 * never an open number.
 */
export interface WorkerDispatchPacket {
    readonly protocolVersion: 1;
    readonly actionToken: string;
    readonly stageId: string;
    readonly sliceId: string;
    readonly taskId?: string;
    readonly mode: WorkerStepMode;
    readonly authorityRefs: {
        readonly manifest: string;
        readonly evidence: string;
        readonly taskReceipts: readonly string[];
        readonly cvReceipt?: string;
    };
    readonly git: {
        readonly expectedHead: string;
        readonly integrationBase?: string;
    };
    readonly scope: {
        readonly allowedPaths: readonly string[];
        readonly forbiddenPaths: readonly string[];
    };
    readonly resultContract: {
        readonly resultPath: string;
        readonly schemaVersion: 1;
    };
}
/** Input to `executeStep` (§3b / Blueprint §6). */
export interface WorkerRelayStepInput {
    readonly projectRoot: string;
    readonly parentSessionId: string;
    readonly stageId: string;
    readonly sliceId: string;
    readonly taskId?: string;
    readonly mode: WorkerStepMode;
    readonly actionToken: string;
    readonly packet: WorkerDispatchPacket;
    readonly continuation: WorkerContinuation;
    readonly timeoutMs: number;
}
/**
 * Attention request returned by a relayed worker step (§3b / Blueprint §6).
 *
 * Object shape — the runtime never treats attention as a bare string.
 * `details` stays opaque (the runtime never parses it).
 */
export interface WorkerRelayAttention {
    readonly reason: string;
    readonly details: unknown;
}
/**
 * Opaque host diagnostics (runRef / lifecycleRef / outputRef / processTerminal).
 *
 * The runtime never parses these and they never enter business Receipts
 * (Blueprint #9.6 / #11 / #22).  `processTerminal` is the closed 3-value
 * set `observed | unknown | not-supported` — never an open string.
 */
export interface WorkerRelayDiagnostics {
    readonly runRef?: string;
    readonly lifecycleRef?: string;
    readonly outputRef?: string;
    readonly processTerminal?: WorkerTerminal;
}
/** Normalized result of a relayed worker step (§3b / Blueprint §6). */
export interface WorkerRelayStepResult {
    readonly execution: WorkerExecution;
    readonly relay: WorkerRelayKind;
    readonly lineageContinued: boolean;
    readonly workerResult?: WorkerResultEnvelope;
    readonly attention?: WorkerRelayAttention;
    readonly diagnostics: WorkerRelayDiagnostics;
}
/** Input to `invalidateSlice` (§3b / Blueprint §6 / #22). */
export interface WorkerSliceInvalidation {
    readonly projectRoot: string;
    readonly parentSessionId: string;
    readonly stageId: string;
    readonly sliceId: string;
}
/**
 * Abstract worker relay seam (AWI-021).
 *
 * The runtime executes worker steps ONLY through this port.  A fake port
 * implemented purely from these types proves any host (including S03's
 * pi-subagents implementation) can satisfy the seam without the runtime
 * knowing anything about the host.
 */
export interface WorkerRelayPort {
    executeStep(input: WorkerRelayStepInput, signal?: AbortSignal): Promise<WorkerRelayStepResult>;
    invalidateSlice(input: WorkerSliceInvalidation): Promise<void>;
}
/**
 * Non-authoritative Worker result envelope
 * (`.pi/proofloop-runtime/results/<action-token>.json`).
 *
 * schemaVersion is the literal `1`.  outcome is the closed 4-value set.
 */
export interface WorkerResultEnvelope {
    readonly schemaVersion: 1;
    readonly actionToken: string;
    readonly stageId: string;
    readonly sliceId: string;
    readonly taskId?: string;
    readonly mode: WorkerStepMode;
    readonly outcome: WorkerOutcome;
    readonly evidenceRef: string;
    readonly changedFiles: readonly string[];
    readonly verificationRuns: readonly {
        readonly commandId: string;
        readonly exitCode: number;
        readonly logRef: string;
    }[];
    readonly summary: string;
}
/**
 * Validate an unknown value as a canonical `WorkerResultEnvelope` (§4 / §13).
 *
 * Fail-closed: any violation throws `SchemaValidationError` with
 * `fieldErrors` (path + message per violation) — no partial acceptance, no
 * silent defaulting, no boolean-only result.  On success the input object is
 * returned unchanged (typed as `WorkerResultEnvelope`).
 */
export declare function validateWorkerResultEnvelope(data: unknown): WorkerResultEnvelope;
//# sourceMappingURL=relay-contract.d.ts.map