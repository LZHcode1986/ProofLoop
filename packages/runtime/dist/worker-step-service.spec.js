"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const runtime_1 = require("@proofloop/runtime");
// ============================================================
// Fixtures — known-good literals (Blueprint §12 / §3b)
// ============================================================
const AUTHORITY_REFS = {
    manifest: '.proofloop/manifest.json',
    evidence: 'delivery/stages/S02/evidence/S02-B.md',
    taskReceipts: ['receipts/tasks/S02/S02-B/S02-B-T01.json'],
    cvReceipt: 'receipts/cv/S02/S02-B/cv-1.json',
};
const GIT_CONTEXT = {
    expectedHead: '12d7df006fa2833f6eec818cd33fa62113d4e519',
    integrationBase: '10fedb4',
};
const SCOPE = {
    allowedPaths: ['packages/runtime/src'],
    forbiddenPaths: ['packages/pi-extension', 'packages/kernel'],
};
const RESULT_CONTRACT = {
    resultPath: '.pi/proofloop-runtime/results/tok-02.json',
    schemaVersion: 1,
};
const DISPATCH_INPUT = {
    projectRoot: '/tmp/proofloop-fixture',
    parentSessionId: 'session-2',
    stageId: 'S02',
    sliceId: 'S02-B',
    taskId: 'S02-B-T02',
    mode: 'implement-task',
    continuation: 'prefer',
    timeoutMs: 30_000,
    actionToken: 'tok-02',
    authorityRefs: AUTHORITY_REFS,
    git: GIT_CONTEXT,
    scope: SCOPE,
    resultContract: RESULT_CONTRACT,
};
/** The exact packet the service must construct (Blueprint §12). */
const EXPECTED_PACKET = {
    protocolVersion: 1,
    actionToken: 'tok-02',
    stageId: 'S02',
    sliceId: 'S02-B',
    taskId: 'S02-B-T02',
    mode: 'implement-task',
    authorityRefs: AUTHORITY_REFS,
    git: GIT_CONTEXT,
    scope: SCOPE,
    resultContract: RESULT_CONTRACT,
};
/** The exact WorkerRelayStepInput the port must receive (§3b). */
const EXPECTED_RELAY_INPUT = {
    projectRoot: '/tmp/proofloop-fixture',
    parentSessionId: 'session-2',
    stageId: 'S02',
    sliceId: 'S02-B',
    taskId: 'S02-B-T02',
    mode: 'implement-task',
    actionToken: 'tok-02',
    packet: EXPECTED_PACKET,
    continuation: 'prefer',
    timeoutMs: 30_000,
};
const SCRIPTED_RESULT = {
    execution: 'completed',
    relay: 'spawned',
    lineageContinued: true,
    workerResult: {
        schemaVersion: 1,
        actionToken: 'tok-02',
        stageId: 'S02',
        sliceId: 'S02-B',
        taskId: 'S02-B-T02',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-B.md',
        changedFiles: ['packages/runtime/src/worker-step-service.ts'],
        verificationRuns: [{ commandId: 'vitest-run', exitCode: 0, logRef: 'logs/out-2' }],
        summary: 'S02-B-T02 complete',
    },
    diagnostics: { runRef: 'run-456', processTerminal: 'unknown' },
};
const INVALIDATION = {
    projectRoot: '/tmp/proofloop-fixture',
    parentSessionId: 'session-2',
    stageId: 'S02',
    sliceId: 'S02-B',
};
/** Minimal dispatch input — no taskId, no cvReceipt, no integrationBase. */
const MINIMAL_DISPATCH_INPUT = {
    projectRoot: '/tmp/proofloop-fixture',
    parentSessionId: 'session-2',
    stageId: 'S02',
    sliceId: 'S02-B',
    mode: 'recover-task',
    continuation: 'fresh',
    timeoutMs: 60_000,
    actionToken: 'tok-min',
    authorityRefs: {
        manifest: '.proofloop/manifest.json',
        evidence: 'delivery/stages/S02/evidence/S02-B.md',
        taskReceipts: [],
    },
    git: { expectedHead: '12d7df006fa2833f6eec818cd33fa62113d4e519' },
    scope: { allowedPaths: ['packages/runtime/src'], forbiddenPaths: [] },
    resultContract: { resultPath: '.pi/proofloop-runtime/results/tok-min.json', schemaVersion: 1 },
};
const MINIMAL_EXPECTED_PACKET = {
    protocolVersion: 1,
    actionToken: 'tok-min',
    stageId: 'S02',
    sliceId: 'S02-B',
    mode: 'recover-task',
    authorityRefs: {
        manifest: '.proofloop/manifest.json',
        evidence: 'delivery/stages/S02/evidence/S02-B.md',
        taskReceipts: [],
    },
    git: { expectedHead: '12d7df006fa2833f6eec818cd33fa62113d4e519' },
    scope: { allowedPaths: ['packages/runtime/src'], forbiddenPaths: [] },
    resultContract: { resultPath: '.pi/proofloop-runtime/results/tok-min.json', schemaVersion: 1 },
};
// ============================================================
// Fake port — zero Pi imports (ADR-012 / AWI-024)
// ============================================================
/**
 * Recording fake `WorkerRelayPort` satisfying the abstract seam purely from
 * `@proofloop/runtime` types — no host package imports, no host internals.
 */
class RecordingFakeWorkerRelay {
    scriptedResult;
    executeCalls = [];
    invalidateCalls = [];
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
// PO-S02-B-02 — executeStep builds the canonical packet and dispatches once
// ============================================================
(0, vitest_1.describe)('PO-S02-B-02 — WorkerStepService.executeStep (packet construction, single dispatch)', () => {
    (0, vitest_1.it)('builds the canonical protocolVersion-1 packet and calls the port exactly once', async () => {
        const port = new RecordingFakeWorkerRelay(SCRIPTED_RESULT);
        const service = new runtime_1.WorkerStepService(port);
        const result = await service.executeStep(DISPATCH_INPUT);
        // Exactly one dispatch through the injected port — no direct return path.
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(1);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(0);
        const packet = port.executeCalls[0].input.packet;
        // Literal versions are the exact literal 1 (Blueprint §12).
        (0, vitest_1.expect)(packet.protocolVersion).toBe(1);
        (0, vitest_1.expect)(packet.resultContract.schemaVersion).toBe(1);
        // Token binding — the packet is bound to the caller-supplied actionToken.
        (0, vitest_1.expect)(packet.actionToken).toBe(DISPATCH_INPUT.actionToken);
        // Worker action indication (stage/slice/task/mode) is carried verbatim.
        (0, vitest_1.expect)(packet.stageId).toBe('S02');
        (0, vitest_1.expect)(packet.sliceId).toBe('S02-B');
        (0, vitest_1.expect)(packet.taskId).toBe('S02-B-T02');
        (0, vitest_1.expect)(packet.mode).toBe('implement-task');
        // Caller-supplied authorityRefs / git / scope / resultContract are bound
        // verbatim — no alias, no dropped or added field.
        (0, vitest_1.expect)(packet.authorityRefs).toEqual(AUTHORITY_REFS);
        (0, vitest_1.expect)(packet.git).toEqual(GIT_CONTEXT);
        (0, vitest_1.expect)(packet.scope).toEqual(SCOPE);
        (0, vitest_1.expect)(packet.resultContract).toEqual(RESULT_CONTRACT);
        // The complete packet is exactly the known-good literal.
        (0, vitest_1.expect)(packet).toEqual(EXPECTED_PACKET);
        // The port receives the full §3b step input (projectRoot / parentSessionId /
        // continuation / timeoutMs + packet).
        (0, vitest_1.expect)(port.executeCalls[0].input).toEqual(EXPECTED_RELAY_INPUT);
        // The port's normalized result is returned unchanged (passthrough).
        (0, vitest_1.expect)(result).toEqual(SCRIPTED_RESULT);
    });
    (0, vitest_1.it)('passes the AbortSignal through to the port unchanged', async () => {
        const port = new RecordingFakeWorkerRelay(SCRIPTED_RESULT);
        const service = new runtime_1.WorkerStepService(port);
        const controller = new AbortController();
        await service.executeStep(DISPATCH_INPUT, controller.signal);
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(1);
        (0, vitest_1.expect)(port.executeCalls[0].signal).toBe(controller.signal);
    });
    (0, vitest_1.it)('dispatches once per call — no hidden extra calls, no re-dispatch', async () => {
        const port = new RecordingFakeWorkerRelay(SCRIPTED_RESULT);
        const service = new runtime_1.WorkerStepService(port);
        await service.executeStep(DISPATCH_INPUT);
        await service.executeStep(DISPATCH_INPUT);
        // Two calls for two dispatches — never more, never less.
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(2);
        for (const call of port.executeCalls) {
            (0, vitest_1.expect)(call.input.packet).toEqual(EXPECTED_PACKET);
        }
    });
    (0, vitest_1.it)('propagates the port result for non-completed executions too (needs-attention / timed-out)', async () => {
        const attentionResult = {
            execution: 'needs-attention',
            relay: 'resumed',
            lineageContinued: true,
            attention: {
                reason: 'worker session requires user attention',
                details: { retry: true },
            },
            diagnostics: { runRef: 'run-999' },
        };
        const port = new RecordingFakeWorkerRelay(attentionResult);
        const service = new runtime_1.WorkerStepService(port);
        const result = await service.executeStep(DISPATCH_INPUT);
        (0, vitest_1.expect)(result).toEqual(attentionResult);
        (0, vitest_1.expect)(result.execution).toBe('needs-attention');
        // Attention is the §3b object shape { reason, details } — never a bare string.
        (0, vitest_1.expect)(result.attention).toEqual({
            reason: 'worker session requires user attention',
            details: { retry: true },
        });
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(1);
    });
    (0, vitest_1.it)('omitting optional taskId/cvReceipt/integrationBase yields a minimal canonical packet', async () => {
        const port = new RecordingFakeWorkerRelay(SCRIPTED_RESULT);
        const service = new runtime_1.WorkerStepService(port);
        await service.executeStep(MINIMAL_DISPATCH_INPUT);
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(1);
        const packet = port.executeCalls[0].input.packet;
        (0, vitest_1.expect)(packet.protocolVersion).toBe(1);
        (0, vitest_1.expect)(packet.taskId).toBeUndefined();
        (0, vitest_1.expect)(packet.authorityRefs.cvReceipt).toBeUndefined();
        (0, vitest_1.expect)(packet.git.integrationBase).toBeUndefined();
        (0, vitest_1.expect)(packet).toEqual(MINIMAL_EXPECTED_PACKET);
        (0, vitest_1.expect)(port.executeCalls[0].input.continuation).toBe('fresh');
        (0, vitest_1.expect)(port.executeCalls[0].input.mode).toBe('recover-task');
    });
    (0, vitest_1.it)('rejects non-canonical literals at compile time (closed sets, literal versions)', () => {
        // @ts-expect-error — mode is the closed 5-value WorkerStepMode set
        const badMode = 'deploy';
        // @ts-expect-error — continuation is the closed 2-value set
        const badContinuation = 'auto';
        // @ts-expect-error — protocolVersion is the literal 1, not an open number
        const badVersion = 2;
        // @ts-expect-error — resultContract.schemaVersion is the literal 1
        const badContractVersion = 2;
        void [badMode, badContinuation, badVersion, badContractVersion];
    });
});
// ============================================================
// PO-S02-B-02 — port failure semantics: rejections propagate unchanged
// ============================================================
/**
 * Fake port that records invocations then rejects with a fixed error —
 * proves the service never swallows host failure and never retries.
 */
class RejectingFakeWorkerRelay {
    error;
    executeCalls = [];
    invalidateCalls = [];
    constructor(error) {
        this.error = error;
    }
    async executeStep(input, signal) {
        this.executeCalls.push({ input, signal });
        throw this.error;
    }
    async invalidateSlice(input) {
        this.invalidateCalls.push(input);
        throw this.error;
    }
}
(0, vitest_1.describe)('PO-S02-B-02/03 — port failures propagate unchanged (no swallow, no retry)', () => {
    (0, vitest_1.it)('executeStep propagates the port rejection verbatim and dispatches exactly once', async () => {
        const boom = new Error('host relay failure');
        const port = new RejectingFakeWorkerRelay(boom);
        const service = new runtime_1.WorkerStepService(port);
        await (0, vitest_1.expect)(service.executeStep(DISPATCH_INPUT)).rejects.toBe(boom);
        // Exactly one dispatch attempt — no retry loop, no fake success return.
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(1);
        (0, vitest_1.expect)(port.executeCalls[0].input.packet).toEqual(EXPECTED_PACKET);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('invalidateSlice propagates the port rejection verbatim and forwards once', async () => {
        const boom = new Error('host invalidation failure');
        const port = new RejectingFakeWorkerRelay(boom);
        const service = new runtime_1.WorkerStepService(port);
        await (0, vitest_1.expect)(service.invalidateSlice(INVALIDATION)).rejects.toBe(boom);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(1);
        (0, vitest_1.expect)(port.invalidateCalls[0]).toEqual(INVALIDATION);
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(0);
    });
});
// ============================================================
// PO-S02-B-03 — invalidateSlice forwards verbatim; no relay internals
// ============================================================
(0, vitest_1.describe)('PO-S02-B-03 — WorkerStepService.invalidateSlice (verbatim forward, no internals)', () => {
    (0, vitest_1.it)('forwards the exact invalidation input and never calls executeStep', async () => {
        const port = new RecordingFakeWorkerRelay(SCRIPTED_RESULT);
        const service = new runtime_1.WorkerStepService(port);
        await service.invalidateSlice(INVALIDATION);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(1);
        (0, vitest_1.expect)(port.invalidateCalls[0]).toEqual(INVALIDATION);
        (0, vitest_1.expect)(port.invalidateCalls[0].projectRoot).toBe('/tmp/proofloop-fixture');
        (0, vitest_1.expect)(port.invalidateCalls[0].parentSessionId).toBe('session-2');
        (0, vitest_1.expect)(port.invalidateCalls[0].stageId).toBe('S02');
        (0, vitest_1.expect)(port.invalidateCalls[0].sliceId).toBe('S02-B');
        // An invalidation must never trigger a worker step execution.
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('repeated invalidations record one call each — still zero executeStep calls', async () => {
        const port = new RecordingFakeWorkerRelay(SCRIPTED_RESULT);
        const service = new runtime_1.WorkerStepService(port);
        await service.invalidateSlice(INVALIDATION);
        await service.invalidateSlice(INVALIDATION);
        (0, vitest_1.expect)(port.invalidateCalls).toHaveLength(2);
        (0, vitest_1.expect)(port.invalidateCalls[1]).toEqual(INVALIDATION);
        (0, vitest_1.expect)(port.executeCalls).toHaveLength(0);
    });
    (0, vitest_1.it)('the service module never touches relay internals (no fs, no session/runRef parsing)', () => {
        const src = (0, node_fs_1.readFileSync)(node_path_1.default.join(__dirname, 'worker-step-service.ts'), 'utf8');
        // No filesystem access — the service must not read session/runRef paths.
        (0, vitest_1.expect)(/from\s+['"](?:node:)?fs['"]/.test(src)).toBe(false);
        (0, vitest_1.expect)(/require\s*\(\s*['"](?:node:)?fs['"]/.test(src)).toBe(false);
        (0, vitest_1.expect)(/\breadFileSync\b|\bwriteFileSync\b|\bcreateReadStream\b|\bcreateWriteStream\b/.test(src)).toBe(false);
        // No parsing or holding of host run/session identifiers — diagnostics
        // stay opaque (Blueprint #9.6 / #11 / #22).
        (0, vitest_1.expect)(/runRef/.test(src)).toBe(false);
        (0, vitest_1.expect)(/sessionFile/.test(src)).toBe(false);
        (0, vitest_1.expect)(/processTerminal/.test(src)).toBe(false);
        // Zero host imports (ADR-012 / AWI-024): the module's only dependency is
        // the intra-package relay contract — no @earendil-works, no .agents, no
        // relative cross-package import.
        const froms = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
        (0, vitest_1.expect)(froms).toEqual(['./relay-contract']);
        for (const spec of froms) {
            (0, vitest_1.expect)(spec.startsWith('@earendil-works')).toBe(false);
            (0, vitest_1.expect)(spec.includes('.agents/')).toBe(false);
            (0, vitest_1.expect)(spec.startsWith('../')).toBe(false);
        }
    });
});
//# sourceMappingURL=worker-step-service.spec.js.map