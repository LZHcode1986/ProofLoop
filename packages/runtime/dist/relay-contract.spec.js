"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const runtime_1 = require("@proofloop/runtime");
// ============================================================
// Fixtures — known-good literals from §3b / Blueprint §6/§12/§13
// ============================================================
const VALID_PACKET = {
    protocolVersion: 1,
    actionToken: 'tok-01',
    stageId: 'S02',
    sliceId: 'S02-B',
    taskId: 'S02-B-T01',
    mode: 'implement-task',
    authorityRefs: {
        manifest: '.proofloop/manifest.json',
        evidence: 'delivery/stages/S02/evidence/S02-B.md',
        taskReceipts: [],
    },
    git: { expectedHead: '12d7df006fa2833f6eec818cd33fa62113d4e519' },
    scope: { allowedPaths: ['packages/runtime/src'], forbiddenPaths: [] },
    resultContract: {
        resultPath: '.pi/proofloop-runtime/results/tok-01.json',
        schemaVersion: 1,
    },
};
const VALID_INPUT = {
    projectRoot: '/tmp/proofloop-fixture',
    parentSessionId: 'session-1',
    stageId: 'S02',
    sliceId: 'S02-B',
    taskId: 'S02-B-T01',
    mode: 'implement-task',
    actionToken: 'tok-01',
    packet: VALID_PACKET,
    continuation: 'prefer',
    timeoutMs: 30_000,
};
const VALID_DIAGNOSTICS = {
    runRef: 'run-123',
    lifecycleRef: 'lc-123',
    outputRef: 'out-123',
    processTerminal: 'observed',
};
const VALID_RESULT = {
    execution: 'completed',
    relay: 'spawned',
    lineageContinued: true,
    workerResult: {
        schemaVersion: 1,
        actionToken: 'tok-01',
        stageId: 'S02',
        sliceId: 'S02-B',
        taskId: 'S02-B-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-B.md',
        changedFiles: ['packages/runtime/src/relay-contract.ts'],
        verificationRuns: [{ commandId: 'vitest-run', exitCode: 0, logRef: 'logs/out-1' }],
        summary: 'S02-B-T01 complete',
    },
    diagnostics: VALID_DIAGNOSTICS,
};
const VALID_ENVELOPE = {
    schemaVersion: 1,
    actionToken: 'tok-01',
    stageId: 'S02',
    sliceId: 'S02-B',
    taskId: 'S02-B-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S02/evidence/S02-B.md',
    changedFiles: ['packages/runtime/src/relay-contract.ts'],
    verificationRuns: [{ commandId: 'vitest-run', exitCode: 0, logRef: 'logs/out-1' }],
    summary: 'S02-B-T01 complete',
};
const VALID_INVALIDATION = {
    projectRoot: '/tmp/proofloop-fixture',
    parentSessionId: 'session-1',
    stageId: 'S02',
    sliceId: 'S02-B',
};
// ============================================================
// Fake port — zero Pi imports (PO-S02-B-01)
// ============================================================
/**
 * Recording fake `WorkerRelayPort`.
 *
 * Satisfies the abstract port purely from `@proofloop/runtime` types — no
 * host (pi-subagents) package imports, no host internals.  Records every
 * executeStep/invalidateSlice invocation so the test can assert exact input
 * shape, signal passthrough, and call records.
 */
class RecordingFakeWorkerRelay {
    executeCalls = [];
    invalidateCalls = [];
    scriptedResult;
    constructor(scriptedResult) {
        this.scriptedResult = scriptedResult;
    }
    async executeStep(input, signal) {
        this.executeCalls.push({ input, signal });
        return this.scriptedResult;
    }
    async invalidateSlice(input) {
        this.invalidateCalls.push(input);
    }
}
// ============================================================
// PO-S02-B-01 — WorkerRelayPort contract shape & call records
// ============================================================
(0, vitest_1.describe)('PO-S02-B-01 — WorkerRelayPort contract (fake port, zero Pi imports)', () => {
    (0, vitest_1.it)('accepts a fake implementation with the exact §3b signature and records calls', async () => {
        const port = new RecordingFakeWorkerRelay(VALID_RESULT);
        const result = await port.executeStep(VALID_INPUT);
        await port.invalidateSlice(VALID_INVALIDATION);
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(1);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(1);
        // Exact input shape — deep-equal against the known-good literal, no
        // field aliases, no dropped/added fields.
        (0, vitest_1.expect)(port.executeCalls[0].input).toEqual(VALID_INPUT);
        (0, vitest_1.expect)(JSON.parse(JSON.stringify(port.executeCalls[0].input))).toEqual(VALID_INPUT);
        (0, vitest_1.expect)(port.invalidateCalls[0]).toEqual(VALID_INVALIDATION);
        // The port result is returned unchanged (normalized result passthrough).
        (0, vitest_1.expect)(result).toEqual(VALID_RESULT);
    });
    (0, vitest_1.it)('passes the AbortSignal through to executeStep', async () => {
        const port = new RecordingFakeWorkerRelay(VALID_RESULT);
        const controller = new AbortController();
        await port.executeStep(VALID_INPUT, controller.signal);
        (0, vitest_1.expect)(port.executeCalls[0].signal).toBe(controller.signal);
    });
    (0, vitest_1.it)('returns a result with the complete §3b structure (execution/relay/lineageContinued/diagnostics)', async () => {
        const port = new RecordingFakeWorkerRelay(VALID_RESULT);
        const result = await port.executeStep(VALID_INPUT);
        // Top-level result fields — exact set, no aliases.
        (0, vitest_1.expect)(Object.keys(result).sort()).toEqual(['diagnostics', 'execution', 'lineageContinued', 'relay', 'workerResult']);
        (0, vitest_1.expect)(result.execution).toBe('completed');
        (0, vitest_1.expect)(result.relay).toBe('spawned');
        (0, vitest_1.expect)(result.lineageContinued).toBe(true);
        // Opaque diagnostics structure — exact sub-fields, runtime never parses them.
        (0, vitest_1.expect)(Object.keys(result.diagnostics ?? {}).sort()).toEqual(['lifecycleRef', 'outputRef', 'processTerminal', 'runRef']);
        (0, vitest_1.expect)(result.diagnostics?.runRef).toBe('run-123');
        // workerResult carries the full envelope structure.
        const env = result.workerResult;
        (0, vitest_1.expect)(env?.schemaVersion).toBe(1);
        (0, vitest_1.expect)(env?.actionToken).toBe('tok-01');
        (0, vitest_1.expect)(env?.outcome).toBe('completed');
        (0, vitest_1.expect)(Array.isArray(env?.changedFiles)).toBe(true);
        (0, vitest_1.expect)(Array.isArray(env?.verificationRuns)).toBe(true);
    });
    (0, vitest_1.it)('accepts a result without optional workerResult/attention fields (diagnostics is required)', async () => {
        const minimalResult = {
            execution: 'needs-attention',
            relay: 'resumed',
            lineageContinued: false,
            diagnostics: {},
        };
        const port = new RecordingFakeWorkerRelay(minimalResult);
        const result = await port.executeStep(VALID_INPUT);
        (0, vitest_1.expect)(result.execution).toBe('needs-attention');
        (0, vitest_1.expect)(result.workerResult).toBeUndefined();
        (0, vitest_1.expect)(result.attention).toBeUndefined();
        // diagnostics is REQUIRED per §3b / Blueprint §6 — it may be empty
        // (every sub-field optional) but must be present.
        (0, vitest_1.expect)(result.diagnostics).toEqual({});
    });
    (0, vitest_1.it)('attention carries the §3b object shape { reason, details } when present', async () => {
        const attentionResult = {
            execution: 'needs-attention',
            relay: 'resumed',
            lineageContinued: true,
            attention: {
                reason: 'worker session requires user attention',
                details: { retry: true },
            },
            diagnostics: { runRef: 'run-777' },
        };
        const port = new RecordingFakeWorkerRelay(attentionResult);
        const result = await port.executeStep(VALID_INPUT);
        // Attention is an OBJECT (reason + opaque details) — never a bare string.
        (0, vitest_1.expect)(result.attention).toEqual({
            reason: 'worker session requires user attention',
            details: { retry: true },
        });
        (0, vitest_1.expect)(result.diagnostics).toEqual({ runRef: 'run-777' });
    });
    (0, vitest_1.it)('records every execution and invalidation invocation in order', async () => {
        const port = new RecordingFakeWorkerRelay(VALID_RESULT);
        await port.executeStep(VALID_INPUT);
        await port.invalidateSlice(VALID_INVALIDATION);
        await port.executeStep(VALID_INPUT);
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(2);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(1);
    });
});
// ============================================================
// PO-S02-B-01 — literal closures enforced at the type level
// ============================================================
(0, vitest_1.describe)('PO-S02-B-01 — exported literal-set constants are the exact canonical closed sets', () => {
    /** Canonical closed sets (§3b / Blueprint §6 / §13) — known-good literals. */
    const CANONICAL_MODES = ['implement-task', 'recover-task', 'finalize-slice', 'diagnose', 'repair'];
    const CANONICAL_CONTINUATIONS = ['prefer', 'fresh'];
    const CANONICAL_EXECUTIONS = ['completed', 'needs-attention', 'failed', 'timed-out', 'cancelled'];
    const CANONICAL_RELAYS = ['spawned', 'resumed', 'fresh-fallback'];
    const CANONICAL_OUTCOMES = ['completed', 'blocked', 'needs-decision', 'failed'];
    const CANONICAL_TERMINALS = ['observed', 'unknown', 'not-supported'];
    (0, vitest_1.it)('WORKER_STEP_MODES is exactly the 5 canonical mode literals (no extra/duplicate/missing)', () => {
        (0, vitest_1.expect)(runtime_1.WORKER_STEP_MODES).toEqual(CANONICAL_MODES);
        (0, vitest_1.expect)(new Set(runtime_1.WORKER_STEP_MODES).size).toBe(5);
    });
    (0, vitest_1.it)('WORKER_CONTINUATIONS is exactly the 2 canonical continuation literals', () => {
        (0, vitest_1.expect)(runtime_1.WORKER_CONTINUATIONS).toEqual(CANONICAL_CONTINUATIONS);
        (0, vitest_1.expect)(new Set(runtime_1.WORKER_CONTINUATIONS).size).toBe(2);
    });
    (0, vitest_1.it)('WORKER_EXECUTIONS is exactly the 5 canonical execution literals', () => {
        (0, vitest_1.expect)(runtime_1.WORKER_EXECUTIONS).toEqual(CANONICAL_EXECUTIONS);
        (0, vitest_1.expect)(new Set(runtime_1.WORKER_EXECUTIONS).size).toBe(5);
    });
    (0, vitest_1.it)('WORKER_RELAY_KINDS is exactly the 3 canonical relay literals', () => {
        (0, vitest_1.expect)(runtime_1.WORKER_RELAY_KINDS).toEqual(CANONICAL_RELAYS);
        (0, vitest_1.expect)(new Set(runtime_1.WORKER_RELAY_KINDS).size).toBe(3);
    });
    (0, vitest_1.it)('WORKER_OUTCOMES is exactly the 4 canonical outcome literals', () => {
        (0, vitest_1.expect)(runtime_1.WORKER_OUTCOMES).toEqual(CANONICAL_OUTCOMES);
        (0, vitest_1.expect)(new Set(runtime_1.WORKER_OUTCOMES).size).toBe(4);
    });
    (0, vitest_1.it)('WORKER_RELAY_TERMINALS is exactly the canonical 3-value terminal closed set', () => {
        (0, vitest_1.expect)(runtime_1.WORKER_RELAY_TERMINALS).toEqual(CANONICAL_TERMINALS);
        (0, vitest_1.expect)(new Set(runtime_1.WORKER_RELAY_TERMINALS).size).toBe(3);
    });
});
(0, vitest_1.describe)('PO-S02-B-01 — literal closures are exact at the type level', () => {
    (0, vitest_1.it)('accepts every canonical literal of each closed set', () => {
        const modes = [
            'implement-task', 'recover-task', 'finalize-slice', 'diagnose', 'repair',
        ];
        const continuations = ['prefer', 'fresh'];
        const executions = [
            'completed', 'needs-attention', 'failed', 'timed-out', 'cancelled',
        ];
        const relays = ['spawned', 'resumed', 'fresh-fallback'];
        const outcomes = ['completed', 'blocked', 'needs-decision', 'failed'];
        const terminals = ['observed', 'unknown', 'not-supported'];
        const attention = {
            reason: 'worker session requires user attention',
            details: { retry: true },
        };
        (0, vitest_1.expect)(modes).toHaveLength(5);
        (0, vitest_1.expect)(continuations).toHaveLength(2);
        (0, vitest_1.expect)(executions).toHaveLength(5);
        (0, vitest_1.expect)(relays).toHaveLength(3);
        (0, vitest_1.expect)(outcomes).toHaveLength(4);
        (0, vitest_1.expect)(terminals).toHaveLength(3);
        (0, vitest_1.expect)(attention.reason.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('rejects non-canonical literals at compile time (closed sets, no open strings)', () => {
        // @ts-expect-error — 'implement' is not a WorkerStepMode (closed 5-value set)
        const badMode = 'implement';
        // @ts-expect-error — 'auto' is not a WorkerContinuation (closed 2-value set)
        const badContinuation = 'auto';
        // @ts-expect-error — 'done' is not a WorkerExecution (closed 5-value set)
        const badExecution = 'done';
        // @ts-expect-error — 'reused' is not a WorkerRelayKind (closed 3-value set)
        const badRelay = 'reused';
        // @ts-expect-error — 'success' is not a WorkerOutcome (closed 4-value set)
        const badOutcome = 'success';
        // @ts-expect-error — protocolVersion is the literal 1, not an open number
        const badVersion = 2;
        // @ts-expect-error — resultContract.schemaVersion is the literal 1
        const badContractVersion = 2;
        // @ts-expect-error — packet mode is closed; 'repair-x' is rejected
        const badPacketMode = 'repair-x';
        // @ts-expect-error — envelope outcome is closed; 'success' is rejected
        const badEnvelopeOutcome = 'success';
        // @ts-expect-error — envelope schemaVersion is the literal 1
        const badEnvelopeVersion = 3;
        // @ts-expect-error — attention is the { reason, details } object shape (§3b), not a bare string
        const badAttention = 'worker session requires user attention';
        // @ts-expect-error — processTerminal is the closed 3-value set (§3b), no open strings
        const badTerminal = 'term-123';
        // @ts-expect-error — diagnostics is REQUIRED per §3b / Blueprint §6
        const missingDiagnostics = {
            execution: 'completed',
            relay: 'spawned',
            lineageContinued: true,
        };
        void [
            badMode, badContinuation, badExecution, badRelay, badOutcome,
            badVersion, badContractVersion, badPacketMode, badEnvelopeOutcome, badEnvelopeVersion,
            badAttention, badTerminal, missingDiagnostics,
        ];
    });
});
// ============================================================
// PO-S02-B-04 — WorkerResultEnvelope validator matrix
// ============================================================
(0, vitest_1.describe)('PO-S02-B-04 — WorkerResultEnvelope validator (fail-closed, field-locatable)', () => {
    (0, vitest_1.it)('accepts a valid envelope and preserves every field (no mutation, no defaulting)', () => {
        const result = (0, runtime_1.validateWorkerResultEnvelope)(VALID_ENVELOPE);
        (0, vitest_1.expect)(result).toEqual(VALID_ENVELOPE);
        (0, vitest_1.expect)(result.schemaVersion).toBe(1);
        (0, vitest_1.expect)(result.outcome).toBe('completed');
        (0, vitest_1.expect)(result.changedFiles).toEqual(VALID_ENVELOPE.changedFiles);
    });
    (0, vitest_1.it)('accepts an envelope without the optional taskId field', () => {
        const { taskId: _taskId, ...withoutTaskId } = VALID_ENVELOPE;
        (0, vitest_1.expect)((0, runtime_1.validateWorkerResultEnvelope)(withoutTaskId)).toEqual(withoutTaskId);
    });
    (0, vitest_1.it)('rejects an invalid outcome with an error locatable to the outcome field', () => {
        const bad = { ...VALID_ENVELOPE, outcome: 'completed-ish' };
        (0, vitest_1.expect)(() => (0, runtime_1.validateWorkerResultEnvelope)(bad)).toThrow(runtime_1.SchemaValidationError);
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)(bad));
        (0, vitest_1.expect)(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'outcome' })]));
    });
    (0, vitest_1.it)('rejects a missing actionToken with an error locatable to the actionToken field', () => {
        const { actionToken: _actionToken, ...missing } = VALID_ENVELOPE;
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)(missing));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'actionToken' })]));
    });
    (0, vitest_1.it)('rejects schemaVersion ≠ 1 with an error locatable to the schemaVersion field', () => {
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, schemaVersion: 2 }));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'schemaVersion' })]));
    });
    (0, vitest_1.it)('rejects a non-array changedFiles with an error locatable to the changedFiles field', () => {
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, changedFiles: 'not-an-array' }));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'changedFiles' })]));
    });
    (0, vitest_1.it)('rejects a changedFiles array containing a non-string element with an indexed path', () => {
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, changedFiles: ['ok.ts', 42] }));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'changedFiles[1]' })]));
    });
    (0, vitest_1.it)('rejects a missing verificationRuns with an error locatable to the verificationRuns field', () => {
        const { verificationRuns: _verificationRuns, ...missing } = VALID_ENVELOPE;
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)(missing));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'verificationRuns' })]));
    });
    (0, vitest_1.it)('fail closed — rejects empty required strings (no silent acceptance of blank fields)', () => {
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, actionToken: '' }));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'actionToken' })]));
    });
    (0, vitest_1.it)('rejects an invalid mode with an error locatable to the mode field', () => {
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, mode: 'deploy' }));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'mode' })]));
    });
    (0, vitest_1.it)('rejects a stageId / sliceId violating the identifier charset (F-2 path safety)', () => {
        const badIdentifiers = [
            '../../evil',
            '../S02',
            'S02/../x',
            'S 02',
            'S02..\\evil',
        ];
        for (const bad of badIdentifiers) {
            const errStage = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, stageId: bad }));
            (0, vitest_1.expect)(errStage.code, `stageId ${JSON.stringify(bad)}`).toBe('RUNTIME.SCHEMA_MISMATCH');
            (0, vitest_1.expect)(errStage.fieldErrors, `stageId ${JSON.stringify(bad)}`).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'stageId' })]));
            const errSlice = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)({ ...VALID_ENVELOPE, sliceId: bad }));
            (0, vitest_1.expect)(errSlice.fieldErrors, `sliceId ${JSON.stringify(bad)}`).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'sliceId' })]));
        }
        // Canonical identifier shapes still pass (letters/digits/-/_ only).
        (0, vitest_1.expect)(() => (0, runtime_1.validateWorkerResultEnvelope)({
            ...VALID_ENVELOPE,
            stageId: 'S02-A',
            sliceId: 'S02-B_1',
        })).not.toThrow();
    });
    (0, vitest_1.it)('rejects malformed verificationRuns entries with nested field paths', () => {
        const bad = {
            ...VALID_ENVELOPE,
            verificationRuns: [{ commandId: 42 }],
        };
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)(bad));
        const paths = err.fieldErrors.map((e) => e.path);
        (0, vitest_1.expect)(paths).toEqual(vitest_1.expect.arrayContaining(['verificationRuns[0].commandId', 'verificationRuns[0].exitCode', 'verificationRuns[0].logRef']));
    });
    (0, vitest_1.it)('fail closed — multiple violations are all reported together (no partial acceptance)', () => {
        const { actionToken: _actionToken, ...missing } = VALID_ENVELOPE;
        const bad = { ...missing, outcome: 'bogus', schemaVersion: 2, changedFiles: 'x' };
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)(bad));
        const paths = err.fieldErrors.map((e) => e.path);
        for (const expected of ['outcome', 'actionToken', 'schemaVersion', 'changedFiles']) {
            (0, vitest_1.expect)(paths).toContain(expected);
        }
    });
    (0, vitest_1.it)('fail closed — rejects unknown fields (strict, no silent tolerance)', () => {
        const bad = { ...VALID_ENVELOPE, extraField: 'sneaky' };
        const err = captureError(() => (0, runtime_1.validateWorkerResultEnvelope)(bad));
        (0, vitest_1.expect)(err.fieldErrors).toEqual(vitest_1.expect.arrayContaining([vitest_1.expect.objectContaining({ path: 'extraField' })]));
    });
    (0, vitest_1.it)('fail closed — rejects non-object input outright', () => {
        for (const bad of [null, 'envelope', 42, ['schemaVersion'], undefined]) {
            (0, vitest_1.expect)(() => (0, runtime_1.validateWorkerResultEnvelope)(bad)).toThrow(runtime_1.SchemaValidationError);
        }
    });
});
// ============================================================
// Helpers
// ============================================================
function captureError(fn) {
    let thrown;
    try {
        fn();
    }
    catch (err) {
        thrown = err;
    }
    (0, vitest_1.expect)(thrown).toBeInstanceOf(runtime_1.SchemaValidationError);
    return thrown;
}
//# sourceMappingURL=relay-contract.spec.js.map