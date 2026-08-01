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

import { SchemaValidationError } from '@proofloop/kernel';

// ============================================================
// Closed literal sets (§3b / Blueprint §6 / §13)
// ============================================================

/** Worker step modes — closed 5-value set. */
export const WORKER_STEP_MODES = [
  'implement-task',
  'recover-task',
  'finalize-slice',
  'diagnose',
  'repair',
] as const;
export type WorkerStepMode = (typeof WORKER_STEP_MODES)[number];

/** Continuation policy — closed 2-value set. */
export const WORKER_CONTINUATIONS = ['prefer', 'fresh'] as const;
export type WorkerContinuation = (typeof WORKER_CONTINUATIONS)[number];

/** Execution status of a relayed worker step — closed 5-value set. */
export const WORKER_EXECUTIONS = [
  'completed',
  'needs-attention',
  'failed',
  'timed-out',
  'cancelled',
] as const;
export type WorkerExecution = (typeof WORKER_EXECUTIONS)[number];

/** Relay transport kind — closed 3-value set. */
export const WORKER_RELAY_KINDS = ['spawned', 'resumed', 'fresh-fallback'] as const;
export type WorkerRelayKind = (typeof WORKER_RELAY_KINDS)[number];

/** Worker result outcome — closed 4-value set. */
export const WORKER_OUTCOMES = ['completed', 'blocked', 'needs-decision', 'failed'] as const;
export type WorkerOutcome = (typeof WORKER_OUTCOMES)[number];

/** Relay process-terminal status — closed 3-value set (§3b / Blueprint §6). */
export const WORKER_RELAY_TERMINALS = ['observed', 'unknown', 'not-supported'] as const;
export type WorkerTerminal = (typeof WORKER_RELAY_TERMINALS)[number];

// ============================================================
// WorkerDispatchPacket (Blueprint §12)
// ============================================================

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

// ============================================================
// WorkerRelayStepInput / WorkerRelayStepResult / WorkerRelayPort (§3b)
// ============================================================

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
  executeStep(
    input: WorkerRelayStepInput,
    signal?: AbortSignal,
  ): Promise<WorkerRelayStepResult>;
  invalidateSlice(input: WorkerSliceInvalidation): Promise<void>;
}

// ============================================================
// WorkerResultEnvelope (§4 / Blueprint §13)
// ============================================================

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

// ============================================================
// WorkerResultEnvelope validator (PO-S02-B-04)
// ============================================================

/** Field-locatable validation error. */
interface FieldError {
  path: string;
  message: string;
}

const ENVELOPE_KNOWN_FIELDS = new Set([
  'schemaVersion',
  'actionToken',
  'stageId',
  'sliceId',
  'taskId',
  'mode',
  'outcome',
  'evidenceRef',
  'changedFiles',
  'verificationRuns',
  'summary',
]);

const VERIFICATION_RUN_KNOWN_FIELDS = new Set(['commandId', 'exitCode', 'logRef']);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function checkUnknownFields(
  obj: Record<string, unknown>,
  known: Set<string>,
  path: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      errors.push({ path: path ? `${path}.${key}` : key, message: `Unknown field "${key}"` });
    }
  }
}

function expectString(value: unknown, path: string, errors: FieldError[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    });
  }
}

/**
 * Identifier charset check (F-2): the envelope stageId / sliceId are used
 * verbatim in receipt category path construction, so they are restricted to
 * the safe charset `^[A-Za-z0-9_-]+$` — path separators and traversal
 * segments are rejected before any path is built or receipt written.
 */
const IDENTIFIER_CHARSET = /^[A-Za-z0-9_-]+$/;

function expectIdentifier(value: unknown, path: string, errors: FieldError[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    });
    return;
  }
  if (!IDENTIFIER_CHARSET.test(value)) {
    errors.push({
      path,
      message: `Expected identifier matching ^[A-Za-z0-9_-]+$, got ${JSON.stringify(value)}`,
    });
  }
}

function expectOptionalString(value: unknown, path: string, errors: FieldError[]): void {
  if (value !== undefined) expectString(value, path, errors);
}

function expectNumber(value: unknown, path: string, errors: FieldError[]): void {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    errors.push({
      path,
      message: `Expected number, got ${value === null ? 'null' : typeof value}`,
    });
  }
}

function expectStringLiteral(
  value: unknown,
  literals: readonly string[],
  path: string,
  errors: FieldError[],
): void {
  if (typeof value !== 'string') {
    errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
    return;
  }
  if (!(literals as readonly string[]).includes(value)) {
    errors.push({
      path,
      message: `Expected one of: ${literals.map((l) => JSON.stringify(l)).join(', ')}`,
    });
  }
}

function expectStringArray(value: unknown, path: string, errors: FieldError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: `Expected array, got ${value === null ? 'null' : typeof value}` });
    return;
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string') {
      errors.push({ path: `${path}[${i}]`, message: `Expected string, got ${typeof item}` });
    }
  });
}

function validateVerificationRuns(value: unknown, path: string, errors: FieldError[]): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: `Expected array, got ${value === null ? 'null' : typeof value}` });
    return;
  }
  value.forEach((run, i) => {
    if (!isRecord(run)) {
      errors.push({ path: `${path}[${i}]`, message: 'Expected object' });
      return;
    }
    checkUnknownFields(run, VERIFICATION_RUN_KNOWN_FIELDS, `${path}[${i}]`, errors);
    expectString(run.commandId, `${path}[${i}].commandId`, errors);
    expectNumber(run.exitCode, `${path}[${i}].exitCode`, errors);
    expectString(run.logRef, `${path}[${i}].logRef`, errors);
  });
}

/**
 * Validate an unknown value as a canonical `WorkerResultEnvelope` (§4 / §13).
 *
 * Fail-closed: any violation throws `SchemaValidationError` with
 * `fieldErrors` (path + message per violation) — no partial acceptance, no
 * silent defaulting, no boolean-only result.  On success the input object is
 * returned unchanged (typed as `WorkerResultEnvelope`).
 */
export function validateWorkerResultEnvelope(data: unknown): WorkerResultEnvelope {
  const errors: FieldError[] = [];

  if (!isRecord(data)) {
    errors.push({
      path: '',
      message: `Expected object, got ${data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data}`,
    });
    throw new SchemaValidationError(
      `Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      errors,
    );
  }

  checkUnknownFields(data, ENVELOPE_KNOWN_FIELDS, '', errors);

  if (data.schemaVersion !== 1) {
    errors.push({
      path: 'schemaVersion',
      message: `Expected 1, got ${JSON.stringify(data.schemaVersion)}`,
    });
  }
  expectString(data.actionToken, 'actionToken', errors);
  expectIdentifier(data.stageId, 'stageId', errors);
  expectIdentifier(data.sliceId, 'sliceId', errors);
  expectOptionalString(data.taskId, 'taskId', errors);
  expectStringLiteral(data.mode, WORKER_STEP_MODES, 'mode', errors);
  expectStringLiteral(data.outcome, WORKER_OUTCOMES, 'outcome', errors);
  expectString(data.evidenceRef, 'evidenceRef', errors);
  expectStringArray(data.changedFiles, 'changedFiles', errors);
  validateVerificationRuns(data.verificationRuns, 'verificationRuns', errors);
  expectString(data.summary, 'summary', errors);

  if (errors.length > 0) {
    throw new SchemaValidationError(
      `Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      errors,
    );
  }

  return data as unknown as WorkerResultEnvelope;
}
