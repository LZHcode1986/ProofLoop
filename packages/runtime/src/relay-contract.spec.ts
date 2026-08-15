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

import { describe, it, expect } from 'vitest';
import {
  validateWorkerResultEnvelope,
  SchemaValidationError,
  WORKER_STEP_MODES,
  WORKER_CONTINUATIONS,
  WORKER_EXECUTIONS,
  WORKER_RELAY_KINDS,
  WORKER_OUTCOMES,
  WORKER_RELAY_TERMINALS,
  type WorkerRelayPort,
  type WorkerRelayStepInput,
  type WorkerRelayStepResult,
  type WorkerRelayDiagnostics,
  type WorkerRelayAttention,
  type WorkerSliceInvalidation,
  type WorkerDispatchPacket,
  type WorkerResultEnvelope,
  type WorkerStepMode,
  type WorkerContinuation,
  type WorkerExecution,
  type WorkerRelayKind,
  type WorkerOutcome,
  type WorkerTerminal,
} from '@proofloop/runtime';

// ============================================================
// Fixtures — known-good literals from §3b / Blueprint §6/§12/§13
// ============================================================

const VALID_PACKET: WorkerDispatchPacket = {
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

const VALID_INPUT: WorkerRelayStepInput = {
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

const VALID_DIAGNOSTICS: WorkerRelayDiagnostics = {
  runRef: 'run-123',
  lifecycleRef: 'lc-123',
  outputRef: 'out-123',
  processTerminal: 'observed',
};

const VALID_RESULT: WorkerRelayStepResult = {
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

const VALID_ENVELOPE: WorkerResultEnvelope = {
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

const VALID_INVALIDATION: WorkerSliceInvalidation = {
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
class RecordingFakeWorkerRelay implements WorkerRelayPort {
  public readonly executeCalls: Array<{ input: WorkerRelayStepInput; signal?: AbortSignal }> = [];
  public readonly invalidateCalls: WorkerSliceInvalidation[] = [];
  private readonly scriptedResult: WorkerRelayStepResult;

  constructor(scriptedResult: WorkerRelayStepResult) {
    this.scriptedResult = scriptedResult;
  }

  async executeStep(
    input: WorkerRelayStepInput,
    signal?: AbortSignal,
  ): Promise<WorkerRelayStepResult> {
    this.executeCalls.push({ input, signal });
    return this.scriptedResult;
  }

  async invalidateSlice(input: WorkerSliceInvalidation): Promise<void> {
    this.invalidateCalls.push(input);
  }
}

// ============================================================
// PO-S02-B-01 — WorkerRelayPort contract shape & call records
// ============================================================

describe('PO-S02-B-01 — WorkerRelayPort contract (fake port, zero Pi imports)', () => {
  it('accepts a fake implementation with the exact §3b signature and records calls', async () => {
    const port = new RecordingFakeWorkerRelay(VALID_RESULT);

    const result = await port.executeStep(VALID_INPUT);
    await port.invalidateSlice(VALID_INVALIDATION);

    expect(port.executeCalls).toHaveLength(1);
    expect(port.invalidateCalls).toHaveLength(1);

    // Exact input shape — deep-equal against the known-good literal, no
    // field aliases, no dropped/added fields.
    expect(port.executeCalls[0].input).toEqual(VALID_INPUT);
    expect(JSON.parse(JSON.stringify(port.executeCalls[0].input))).toEqual(VALID_INPUT);
    expect(port.invalidateCalls[0]).toEqual(VALID_INVALIDATION);

    // The port result is returned unchanged (normalized result passthrough).
    expect(result).toEqual(VALID_RESULT);
  });

  it('passes the AbortSignal through to executeStep', async () => {
    const port = new RecordingFakeWorkerRelay(VALID_RESULT);
    const controller = new AbortController();

    await port.executeStep(VALID_INPUT, controller.signal);

    expect(port.executeCalls[0].signal).toBe(controller.signal);
  });

  it('returns a result with the complete §3b structure (execution/relay/lineageContinued/diagnostics)', async () => {
    const port = new RecordingFakeWorkerRelay(VALID_RESULT);

    const result = await port.executeStep(VALID_INPUT);

    // Top-level result fields — exact set, no aliases.
    expect(Object.keys(result).sort()).toEqual(
      ['diagnostics', 'execution', 'lineageContinued', 'relay', 'workerResult'],
    );
    expect(result.execution).toBe('completed');
    expect(result.relay).toBe('spawned');
    expect(result.lineageContinued).toBe(true);

    // Opaque diagnostics structure — exact sub-fields, runtime never parses them.
    expect(Object.keys(result.diagnostics ?? {}).sort()).toEqual(
      ['lifecycleRef', 'outputRef', 'processTerminal', 'runRef'],
    );
    expect(result.diagnostics?.runRef).toBe('run-123');

    // workerResult carries the full envelope structure.
    const env = result.workerResult;
    expect(env?.schemaVersion).toBe(1);
    expect(env?.actionToken).toBe('tok-01');
    expect(env?.outcome).toBe('completed');
    expect(Array.isArray(env?.changedFiles)).toBe(true);
    expect(Array.isArray(env?.verificationRuns)).toBe(true);
  });

  it('accepts a result without optional workerResult/attention fields (diagnostics is required)', async () => {
    const minimalResult: WorkerRelayStepResult = {
      execution: 'needs-attention',
      relay: 'resumed',
      lineageContinued: false,
      diagnostics: {},
    };
    const port = new RecordingFakeWorkerRelay(minimalResult);

    const result = await port.executeStep(VALID_INPUT);

    expect(result.execution).toBe('needs-attention');
    expect(result.workerResult).toBeUndefined();
    expect(result.attention).toBeUndefined();
    // diagnostics is REQUIRED per §3b / Blueprint §6 — it may be empty
    // (every sub-field optional) but must be present.
    expect(result.diagnostics).toEqual({});
  });

  it('attention carries the §3b object shape { reason, details } when present', async () => {
    const attentionResult: WorkerRelayStepResult = {
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
    expect(result.attention).toEqual({
      reason: 'worker session requires user attention',
      details: { retry: true },
    });
    expect(result.diagnostics).toEqual({ runRef: 'run-777' });
  });

  it('records every execution and invalidation invocation in order', async () => {
    const port = new RecordingFakeWorkerRelay(VALID_RESULT);

    await port.executeStep(VALID_INPUT);
    await port.invalidateSlice(VALID_INVALIDATION);
    await port.executeStep(VALID_INPUT);

    expect(port.executeCalls).toHaveLength(2);
    expect(port.invalidateCalls).toHaveLength(1);
  });
});

// ============================================================
// PO-S02-B-01 — literal closures enforced at the type level
// ============================================================

describe('PO-S02-B-01 — exported literal-set constants are the exact canonical closed sets', () => {
  /** Canonical closed sets (§3b / Blueprint §6 / §13) — known-good literals. */
  const CANONICAL_MODES = ['implement-task', 'recover-task', 'finalize-slice', 'repair'] as const;
  const CANONICAL_CONTINUATIONS = ['prefer', 'fresh'] as const;
  const CANONICAL_EXECUTIONS = ['completed', 'needs-attention', 'failed', 'timed-out', 'cancelled'] as const;
  const CANONICAL_RELAYS = ['spawned', 'resumed', 'fresh-fallback'] as const;
  const CANONICAL_OUTCOMES = ['completed', 'blocked', 'needs-decision', 'failed'] as const;
  const CANONICAL_TERMINALS = ['observed', 'unknown', 'not-supported'] as const;

  it('WORKER_STEP_MODES is exactly the 4 canonical mode literals (no extra/duplicate/missing)', () => {
    expect(WORKER_STEP_MODES).toEqual(CANONICAL_MODES);
    expect(new Set(WORKER_STEP_MODES).size).toBe(4);
  });

  it('WORKER_CONTINUATIONS is exactly the 2 canonical continuation literals', () => {
    expect(WORKER_CONTINUATIONS).toEqual(CANONICAL_CONTINUATIONS);
    expect(new Set(WORKER_CONTINUATIONS).size).toBe(2);
  });

  it('WORKER_EXECUTIONS is exactly the 5 canonical execution literals', () => {
    expect(WORKER_EXECUTIONS).toEqual(CANONICAL_EXECUTIONS);
    expect(new Set(WORKER_EXECUTIONS).size).toBe(5);
  });

  it('WORKER_RELAY_KINDS is exactly the 3 canonical relay literals', () => {
    expect(WORKER_RELAY_KINDS).toEqual(CANONICAL_RELAYS);
    expect(new Set(WORKER_RELAY_KINDS).size).toBe(3);
  });

  it('WORKER_OUTCOMES is exactly the 4 canonical outcome literals', () => {
    expect(WORKER_OUTCOMES).toEqual(CANONICAL_OUTCOMES);
    expect(new Set(WORKER_OUTCOMES).size).toBe(4);
  });

  it('WORKER_RELAY_TERMINALS is exactly the canonical 3-value terminal closed set', () => {
    expect(WORKER_RELAY_TERMINALS).toEqual(CANONICAL_TERMINALS);
    expect(new Set(WORKER_RELAY_TERMINALS).size).toBe(3);
  });
});

describe('PO-S02-B-01 — literal closures are exact at the type level', () => {
  it('accepts every canonical literal of each closed set', () => {
    const modes: WorkerStepMode[] = [
      'implement-task', 'recover-task', 'finalize-slice', 'repair',
    ];
    const continuations: WorkerContinuation[] = ['prefer', 'fresh'];
    const executions: WorkerExecution[] = [
      'completed', 'needs-attention', 'failed', 'timed-out', 'cancelled',
    ];
    const relays: WorkerRelayKind[] = ['spawned', 'resumed', 'fresh-fallback'];
    const outcomes: WorkerOutcome[] = ['completed', 'blocked', 'needs-decision', 'failed'];
    const terminals: WorkerTerminal[] = ['observed', 'unknown', 'not-supported'];
    const attention: WorkerRelayAttention = {
      reason: 'worker session requires user attention',
      details: { retry: true },
    };

    expect(modes).toHaveLength(4);
    expect(continuations).toHaveLength(2);
    expect(executions).toHaveLength(5);
    expect(relays).toHaveLength(3);
    expect(outcomes).toHaveLength(4);
    expect(terminals).toHaveLength(3);
    expect(attention.reason.length).toBeGreaterThan(0);
  });

  it('rejects non-canonical literals at compile time (closed sets, no open strings)', () => {
    // @ts-expect-error — 'implement' is not a WorkerStepMode (closed 4-value set)
    const badMode: WorkerStepMode = 'implement';
    // @ts-expect-error — 'auto' is not a WorkerContinuation (closed 2-value set)
    const badContinuation: WorkerContinuation = 'auto';
    // @ts-expect-error — 'done' is not a WorkerExecution (closed 5-value set)
    const badExecution: WorkerExecution = 'done';
    // @ts-expect-error — 'reused' is not a WorkerRelayKind (closed 3-value set)
    const badRelay: WorkerRelayKind = 'reused';
    // @ts-expect-error — 'success' is not a WorkerOutcome (closed 4-value set)
    const badOutcome: WorkerOutcome = 'success';
    // @ts-expect-error — protocolVersion is the literal 1, not an open number
    const badVersion: WorkerDispatchPacket['protocolVersion'] = 2;
    // @ts-expect-error — resultContract.schemaVersion is the literal 1
    const badContractVersion: WorkerDispatchPacket['resultContract']['schemaVersion'] = 2;
    // @ts-expect-error — packet mode is closed; 'repair-x' is rejected
    const badPacketMode: WorkerDispatchPacket['mode'] = 'repair-x';
    // @ts-expect-error — envelope outcome is closed; 'success' is rejected
    const badEnvelopeOutcome: WorkerResultEnvelope['outcome'] = 'success';
    // @ts-expect-error — envelope schemaVersion is the literal 1
    const badEnvelopeVersion: WorkerResultEnvelope['schemaVersion'] = 3;
    // @ts-expect-error — attention is the { reason, details } object shape (§3b), not a bare string
    const badAttention: WorkerRelayStepResult['attention'] = 'worker session requires user attention';
    // @ts-expect-error — processTerminal is the closed 3-value set (§3b), no open strings
    const badTerminal: WorkerRelayDiagnostics['processTerminal'] = 'term-123';
    // @ts-expect-error — diagnostics is REQUIRED per §3b / Blueprint §6
    const missingDiagnostics: WorkerRelayStepResult = {
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

describe('PO-S02-B-04 — WorkerResultEnvelope validator (fail-closed, field-locatable)', () => {
  it('accepts a valid envelope and preserves every field (no mutation, no defaulting)', () => {
    const result = validateWorkerResultEnvelope(VALID_ENVELOPE);
    expect(result).toEqual(VALID_ENVELOPE);
    expect(result.schemaVersion).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.changedFiles).toEqual(VALID_ENVELOPE.changedFiles);
  });

  it('accepts an envelope without the optional taskId field', () => {
    const { taskId: _taskId, ...withoutTaskId } = VALID_ENVELOPE;
    expect(validateWorkerResultEnvelope(withoutTaskId)).toEqual(withoutTaskId);
  });

  it('rejects an invalid outcome with an error locatable to the outcome field', () => {
    const bad = { ...VALID_ENVELOPE, outcome: 'completed-ish' };
    expect(() => validateWorkerResultEnvelope(bad)).toThrow(SchemaValidationError);
    const err = captureError(() => validateWorkerResultEnvelope(bad));
    expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'outcome' })]),
    );
  });

  it('rejects a missing actionToken with an error locatable to the actionToken field', () => {
    const { actionToken: _actionToken, ...missing } = VALID_ENVELOPE;
    const err = captureError(() => validateWorkerResultEnvelope(missing));
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'actionToken' })]),
    );
  });

  it('rejects schemaVersion ≠ 1 with an error locatable to the schemaVersion field', () => {
    const err = captureError(() =>
      validateWorkerResultEnvelope({ ...VALID_ENVELOPE, schemaVersion: 2 }),
    );
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'schemaVersion' })]),
    );
  });

  it('rejects a non-array changedFiles with an error locatable to the changedFiles field', () => {
    const err = captureError(() =>
      validateWorkerResultEnvelope({ ...VALID_ENVELOPE, changedFiles: 'not-an-array' }),
    );
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'changedFiles' })]),
    );
  });

  it('rejects a changedFiles array containing a non-string element with an indexed path', () => {
    const err = captureError(() =>
      validateWorkerResultEnvelope({ ...VALID_ENVELOPE, changedFiles: ['ok.ts', 42] }),
    );
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'changedFiles[1]' })]),
    );
  });

  it('rejects a missing verificationRuns with an error locatable to the verificationRuns field', () => {
    const { verificationRuns: _verificationRuns, ...missing } = VALID_ENVELOPE;
    const err = captureError(() => validateWorkerResultEnvelope(missing));
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'verificationRuns' })]),
    );
  });

  it('fail closed — rejects empty required strings (no silent acceptance of blank fields)', () => {
    const err = captureError(() =>
      validateWorkerResultEnvelope({ ...VALID_ENVELOPE, actionToken: '' }),
    );
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'actionToken' })]),
    );
  });

  it('rejects an invalid mode with an error locatable to the mode field', () => {
    const err = captureError(() =>
      validateWorkerResultEnvelope({ ...VALID_ENVELOPE, mode: 'deploy' }),
    );
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'mode' })]),
    );
  });

  it('rejects a stageId / sliceId violating the identifier charset (F-2 path safety)', () => {
    const badIdentifiers = [
      '../../evil',
      '../S02',
      'S02/../x',
      'S 02',
      'S02..\\evil',
    ];
    for (const bad of badIdentifiers) {
      const errStage = captureError(() =>
        validateWorkerResultEnvelope({ ...VALID_ENVELOPE, stageId: bad }),
      );
      expect(errStage.code, `stageId ${JSON.stringify(bad)}`).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(errStage.fieldErrors, `stageId ${JSON.stringify(bad)}`).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'stageId' })]),
      );
      const errSlice = captureError(() =>
        validateWorkerResultEnvelope({ ...VALID_ENVELOPE, sliceId: bad }),
      );
      expect(errSlice.fieldErrors, `sliceId ${JSON.stringify(bad)}`).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'sliceId' })]),
      );
    }
    // Canonical identifier shapes still pass (letters/digits/-/_ only).
    expect(() =>
      validateWorkerResultEnvelope({
        ...VALID_ENVELOPE,
        stageId: 'S02-A',
        sliceId: 'S02-B_1',
      }),
    ).not.toThrow();
  });

  it('rejects malformed verificationRuns entries with nested field paths', () => {
    const bad = {
      ...VALID_ENVELOPE,
      verificationRuns: [{ commandId: 42 }],
    };
    const err = captureError(() => validateWorkerResultEnvelope(bad));
    const paths = err.fieldErrors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['verificationRuns[0].commandId', 'verificationRuns[0].exitCode', 'verificationRuns[0].logRef']),
    );
  });

  it('fail closed — multiple violations are all reported together (no partial acceptance)', () => {
    const { actionToken: _actionToken, ...missing } = VALID_ENVELOPE;
    const bad = { ...missing, outcome: 'bogus', schemaVersion: 2, changedFiles: 'x' };
    const err = captureError(() => validateWorkerResultEnvelope(bad));
    const paths = err.fieldErrors.map((e: { path: string }) => e.path);
    for (const expected of ['outcome', 'actionToken', 'schemaVersion', 'changedFiles']) {
      expect(paths).toContain(expected);
    }
  });

  it('fail closed — rejects unknown fields (strict, no silent tolerance)', () => {
    const bad = { ...VALID_ENVELOPE, extraField: 'sneaky' };
    const err = captureError(() => validateWorkerResultEnvelope(bad));
    expect(err.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'extraField' })]),
    );
  });

  it('fail closed — rejects non-object input outright', () => {
    for (const bad of [null, 'envelope', 42, ['schemaVersion'], undefined]) {
      expect(() => validateWorkerResultEnvelope(bad)).toThrow(SchemaValidationError);
    }
  });
});

// ============================================================
// Helpers
// ============================================================

function captureError(fn: () => unknown): {
  code: string;
  fieldErrors: Array<{ path: string; message: string }>;
} {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(SchemaValidationError);
  return thrown as { code: string; fieldErrors: Array<{ path: string; message: string }> };
}
