/**
 * @proofloop/runtime — Unified admit pipeline (AWI-006 / PO-S02-E-01)
 *
 * The single Receipt-creation path for the Stage's 7 admit operations
 * (S02-E-T02..T04 wire each admit method onto this pipeline):
 *
 *   request schema validation (fail closed) → reconcile current state →
 *   reducer precheck / state advance (per-admit steps) → canonical Receipt
 *   construction (type/stage/slice/payload binding + previous_digest chain
 *   linkage) → persistence through the injected `ReceiptWriterPort`
 *   (kernel `writeReceipt` by default) → post-write chain verification →
 *   `{ accepted, receipt_ref, new_state, findings }`.
 *
 * Fail-closed contract (AWI-006 forbidden shortcuts):
 *   - invalid input or an unreconcilable state → structured rejection with a
 *     canonical Finding and NO Receipt;
 *   - a broken target category chain blocks the admit
 *     (RUNTIME.RECEIPT_CHAIN_BROKEN);
 *   - persistence ONLY through the writer port — this module performs no
 *     direct file writes (directory scaffolding via mkdir and read-only
 *     chain-tip resolution are the only fs access).
 *
 * The `AdmissionRequest` union is open for S03/S04/S05 extension (SPV /
 * GATE / GATE_INTERRUPTED / SLICE_PLAN kinds); the pipeline accepts any
 * member unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  writeReceipt,
  verifyReceiptChain,
  ReceiptChainError,
  SchemaValidationError,
  StageState,
  InvalidTransitionError,
} from '@proofloop/kernel';
import type {
  Finding,
  ReceiptType,
  ReceiptWriterOptions,
  WriteReceiptResult,
  ChainVerificationResult,
} from '@proofloop/kernel';
import type { ReconcileStageResult } from './reconcile';
import { reconcileStage } from './reconcile';
import { reduceRuntimeAction } from './reducer';
import type { ReconciledStageState, RuntimeAction } from './state-model';
import { planReceiptDir, stageGateReceiptDir } from './receipt-layout';
import { manifestFileDigest } from './manifest-source';
import { assertAdmissionRequest, admissionRequestStageId } from './admission-request';
import type {
  AdmissionRequest,
  SpvResultAdmissionRequest,
  GateResultAdmissionRequest,
  GateInterruptedAdmissionRequest,
} from './admission-request';

// ============================================================
// Receipt persistence seam — the ONLY write path (AWI-006)
// ============================================================

/**
 * Persistence port through which the pipeline writes receipts.
 *
 * The default implementation delegates to the kernel ReceiptWriter seams
 * (`writeReceipt` / `verifyReceiptChain`); tests inject a fake port to prove
 * the pipeline never touches the filesystem for persistence on its own.
 */
export interface ReceiptWriterPort {
  write(data: object, options: ReceiptWriterOptions): WriteReceiptResult;
  verifyChain(receiptDir: string): ChainVerificationResult;
}

/** Default port — kernel ReceiptWriter (temp → fsync → rename → digest verify → chain + lock). */
export const defaultReceiptWriter: ReceiptWriterPort = {
  write: (data, options) => writeReceipt(data, options),
  verifyChain: (receiptDir) => verifyReceiptChain(receiptDir),
};

// ============================================================
// Per-admit steps (wired by S02-E-T02..T04)
// ============================================================

/**
 * Reducer precheck result: accepted → the pipeline proceeds to write the
 * Receipt (nextState is the advanced post-admit state); refused → the
 * pipeline returns the structured rejection WITHOUT writing anything.
 *
 * Accepted variants may additionally carry:
 *   - `findings` — canonical Findings returned alongside the success result
 *     (empty when absent);
 *   - `writeReceipt: false` — a legal branch that advances the state but
 *     MUST NOT write a Receipt (review REPAIR, PO-S02-E-05/06): the
 *     pipeline returns `{ accepted: true, receipt_ref: null }` with the
 *     findings BEFORE any chain access or write.
 */
export type AdmitPrecheckResult =
  | {
      readonly accepted: true;
      readonly nextState: ReconcileStageResult;
      /** Canonical Findings of an accepted admit (empty when absent). */
      readonly findings?: readonly Finding[];
      /** Set to false for legal branches that must NOT write a Receipt. */
      readonly writeReceipt?: boolean;
    }
  | { readonly accepted: false; readonly findings: readonly Finding[] };

/**
 * Canonical Receipt body built by the admit step (version, digest and
 * previous_digest are pipeline/writer-owned: the writer computes the
 * content-addressed digest; the pipeline binds previous_digest to the
 * target category chain tip).
 */
export interface ReceiptBuild {
  /** Kernel canonical 12-type literal — never an open string. */
  readonly type: ReceiptType;
  readonly stage_id: string;
  readonly slice_id?: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

/** Admit-specific steps — the per-operation part of the unified pipeline. */
export interface AdmitPipelineSteps {
  /** Reducer precheck / state advance (T02–T04 fill; refuse → no Receipt). */
  precheck(state: ReconcileStageResult): AdmitPrecheckResult;
  /** Construct the canonical Receipt body bound to type/stage/slice/payload. */
  buildReceipt(state: ReconcileStageResult): ReceiptBuild;
  /** Canonical category directory the receipt is appended to. */
  targetDir(state: ReconcileStageResult): string;
}

// ============================================================
// Pipeline input / output
// ============================================================

export interface AdmitPipelineInput {
  /** Request to admit (schema-validated inside the pipeline — fail closed). */
  readonly request: AdmissionRequest;
  /** Deterministic current-state source (reconcileStage for real callers). */
  readonly reconcile: (stageId: string) => ReconcileStageResult;
  /** Per-admit steps (precheck / receipt build / target directory). */
  readonly steps: AdmitPipelineSteps;
  /** Persistence port — defaults to the kernel ReceiptWriter. */
  readonly writer?: ReceiptWriterPort;
}

/**
 * Unified admit result (AWI-006): accepted flag, the written receipt digest
 * (null when refused), the post-admit state and the canonical Findings.
 *
 * `new_state` is null only when the request was rejected BEFORE
 * reconciliation (schema failure) — for every post-reconcile result it is
 * the current (or advanced) state.
 */
export interface AdmitResult {
  readonly accepted: boolean;
  readonly receipt_ref: string | null;
  readonly new_state: ReconcileStageResult | null;
  readonly findings: readonly Finding[];
}

// ============================================================
// Unified admit pipeline
// ============================================================

/** Structured rejection builder — canonical Finding + no Receipt ref. */
function reject(
  code: Finding['code'],
  message: string,
  newState: ReconcileStageResult | null,
): AdmitResult {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: newState,
    findings: [{ code, severity: 'error', message }],
  };
}

/** Human-readable chain failure detail from a kernel verification result. */
function chainFailureDetail(result: ChainVerificationResult): string {
  if (result.brokenLink) {
    return (
      `broken link at index ${result.brokenLink.index}: ` +
      `expected ${result.brokenLink.expected}, got ${result.brokenLink.actual}`
    );
  }
  if (result.duplicateDigests && result.duplicateDigests.length > 0) {
    return `duplicate digests: ${result.duplicateDigests.map((d) => d.digest).join(', ')}`;
  }
  return 'chain verification failed';
}

/**
 * Existence-gate attribution (PO-S03-H-05).
 *
 * A `DOMAIN.STAGE_NOT_FOUND` finding is either the manifest-declaration
 * branch (reconcile emits `manifest source unavailable for stage "…"` when
 * the manifest is missing / unreadable / stage_id-mismatched) or a
 * non-manifest branch (receipts referencing an unknown stage / slice, or an
 * unknown slice directory). Each finding is attributed to its concrete
 * source and the ORIGINAL finding content is carried in the message — never
 * a blanket "not declared in the manifest" for a receipt-sourced failure.
 */
function stageNotFoundAttribution(
  stageId: string,
  findings: readonly Finding[],
): string {
  const lines: string[] = [];
  let manifestBranch = false;
  for (const f of findings) {
    if (f.message.startsWith('manifest source unavailable for stage')) {
      manifestBranch = true;
      lines.push(
        `stage "${stageId}" is not declared in the manifest (manifest missing or stage_id mismatch): ${f.message}`,
      );
      continue;
    }
    let source: string;
    if (f.message.includes('references unknown stage')) {
      source = 'receipt references an unknown stage';
    } else if (f.message.includes('references unknown slice')) {
      source = 'receipt references an unknown slice';
    } else if (f.message.startsWith('receipts reference unknown slice')) {
      source = 'receipts reference an unknown slice directory';
    } else {
      source = 'other DOMAIN.STAGE_NOT_FOUND source';
    }
    lines.push(`stage "${stageId}" admit refused — ${source}: ${f.message}`);
  }
  return lines.join('; ');
}

/**
 * Directory scaffolding only — ensures the canonical category directory
 * exists so the kernel ReceiptWriter can atomically write into it. This is
 * NOT a receipt-file write; persistence always goes through the port.
 */
function ensureReceiptDir(receiptDir: string): void {
  fs.mkdirSync(receiptDir, { recursive: true });
}

/**
 * Resolve the chain tip digest of a category directory (deterministic): the
 * unique digest no other receipt references as `previous_digest`. Empty or
 * unreadable directory → undefined (the new receipt becomes genesis); an
 * ambiguous multi-tip directory → undefined (the kernel writer's own
 * fork/tip validation still guards the append). Reads only — never writes.
 */
function resolveCategoryChainTip(receiptDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(receiptDir);
  } catch {
    return undefined;
  }
  const files = entries.filter((f) => f.endsWith('.json')).sort();
  const digests = new Set<string>();
  const referenced = new Set<string>();
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(receiptDir, file), 'utf-8'),
      ) as { digest?: unknown; previous_digest?: unknown };
      if (typeof parsed.digest === 'string' && parsed.digest.length > 0) {
        digests.add(parsed.digest);
      }
      if (typeof parsed.previous_digest === 'string' && parsed.previous_digest.length > 0) {
        referenced.add(parsed.previous_digest);
      }
    } catch {
      // Unreadable / invalid files are caught by the pre-write chain check
      // (writer.verifyChain) — this tip scan skips them deterministically.
    }
  }
  const tips = [...digests].filter((d) => !referenced.has(d)).sort();
  return tips.length === 1 ? tips[0] : undefined;
}

/**
 * Run the unified admit pipeline (AWI-006) for one AdmissionRequest.
 *
 * Every rejection path returns a structured `AdmitResult` with
 * `accepted: false`, `receipt_ref: null` and a canonical Finding — no
 * Receipt is ever produced for an invalid input or an unsatisfied state.
 */
export function runAdmitPipeline(input: AdmitPipelineInput): AdmitResult {
  const writer = input.writer ?? defaultReceiptWriter;

  // ── 1. Request schema validation — fail closed (AWI-006: 验证输入) ──
  let request: AdmissionRequest;
  try {
    assertAdmissionRequest(input.request);
    request = input.request;
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return reject(
        'RUNTIME.SCHEMA_MISMATCH',
        `admission request rejected: ${err.message}`,
        null,
      );
    }
    throw err;
  }

  // ── 2. Reconcile current state (AWI-006: 检查当前状态, HP-003) ──
  let state: ReconcileStageResult;
  try {
    state = input.reconcile(admissionRequestStageId(request));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return reject(
      'RUNTIME.SCHEMA_MISMATCH',
      `reconcile failed for stage "${admissionRequestStageId(request)}": ${reason}`,
      null,
    );
  }

  // ── 2b. Existence gate (F-2, PO-S03-H-05): a schema-legal stageId that is
  //        not backed by persisted facts surfaces an error-level
  //        DOMAIN.STAGE_NOT_FOUND reconcile finding — refuse before any state
  //        advance or write, so a format-legal but non-existent stage (e.g.
  //        'S99') is genuinely rejected and can never produce a Receipt or
  //        touch a category directory. The refusal condition is the same for
  //        EVERY STAGE_NOT_FOUND source (fail closed — the release surface is
  //        never widened); only the rejection MESSAGE differs, attributing the
  //        refusal precisely:
  //          Branch A — "stage not declared in the manifest" (manifest
  //            missing / stage_id mismatch): the message says so explicitly
  //            and carries the original manifest-source finding content;
  //          Branch B — other sources (unknown slice directories, receipts
  //            referencing unknown stage/slice): the message attributes the
  //            refusal to the concrete receipt/directory source and carries
  //            the original finding content (never the branch-A wording). ──
  const stageNotFound = state.findings.filter(
    (f) => f.code === 'DOMAIN.STAGE_NOT_FOUND' && f.severity === 'error',
  );
  if (stageNotFound.length > 0) {
    return reject(
      'DOMAIN.STAGE_NOT_FOUND',
      stageNotFoundAttribution(state.stage_id, stageNotFound),
      state,
    );
  }

  // ── 3. Reducer precheck / state advance (T02–T04 wire per admit method;
  //        refuse → structured rejection, no Receipt) ──
  const pre = input.steps.precheck(state);
  if (!pre.accepted) {
    return {
      accepted: false,
      receipt_ref: null,
      new_state: state,
      findings: pre.findings,
    };
  }

  // ── 3b. Legal no-Receipt branch (review REPAIR, PO-S02-E-05/06): the
  //        state was advanced but NO Receipt may be written — return the
  //        warn Finding with a null receipt ref before any chain access. ──
  if (pre.writeReceipt === false) {
    return {
      accepted: true,
      receipt_ref: null,
      new_state: pre.nextState,
      findings: pre.findings ?? [],
    };
  }

  // ── 4. Target category chain must be intact before appending ──
  //        (RUNTIME.RECEIPT_CHAIN_BROKEN — never append to a broken chain)
  const targetDir = input.steps.targetDir(state);
  const preChain = writer.verifyChain(targetDir);
  if (!preChain.valid) {
    return reject(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `receipt chain broken in ${targetDir} before admit: ${chainFailureDetail(preChain)}`,
      pre.nextState,
    );
  }

  // ── 5. Canonical Receipt construction: type/stage/slice/payload binding + ──
  //        previous_digest chain-tip linkage (version/digest are writer-owned)
  const build = input.steps.buildReceipt(state);
  ensureReceiptDir(targetDir);
  const previousDigest = resolveCategoryChainTip(targetDir);
  const receiptData: Record<string, unknown> = {
    version: 1,
    type: build.type,
    stage_id: build.stage_id,
    timestamp: build.timestamp,
    payload: build.payload,
  };
  if (build.slice_id !== undefined) {
    receiptData.slice_id = build.slice_id;
  }
  if (previousDigest !== undefined) {
    receiptData.previous_digest = previousDigest;
  }

  // ── 6. Persist through the kernel ReceiptWriter port — the ONLY write ──
  //        path (AWI-006: 禁止服务内直接写文件绕过 ReceiptWriter)
  let writeResult: WriteReceiptResult;
  try {
    writeResult = writer.write(receiptData, { receiptDir: targetDir, tempDir: targetDir });
  } catch (err) {
    const code =
      err instanceof ReceiptChainError
        ? 'RUNTIME.RECEIPT_CHAIN_BROKEN'
        : 'RUNTIME.SCHEMA_MISMATCH';
    return reject(
      code,
      `writeReceipt failed for ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
      pre.nextState,
    );
  }

  // ── 7. Post-write chain verification ──
  const postChain = writer.verifyChain(targetDir);
  if (!postChain.valid) {
    return reject(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `receipt chain broken in ${targetDir} after admit: ${chainFailureDetail(postChain)}`,
      pre.nextState,
    );
  }

  // ── 8. Result ──
  return {
    accepted: true,
    receipt_ref: writeResult.digest,
    new_state: pre.nextState,
    findings: pre.findings ?? [],
  };
}

// ============================================================
// admitSpvResult / admitGateResult — S03 SPV/GATE admits (PO-S03-H-02)
// ============================================================
//
// SLICE_PLAN creation-path decision record (PO-S03-H-02): the kernel
// `SLICE_PLAN` receipt literal is retained but S03 does NOT create
// SLICE_PLAN receipts (no consumer today). In S03 a worker-result admit can
// never create a new slice — undeclared slices are refused by the worker
// precheck (DOMAIN.STAGE_NOT_FOUND) and no receipt of any type (in
// particular no SLICE_PLAN) is written for them. If a future flow
// (repartition / first-entry) creates a new slice, the S04 tool flow wires a
// `slice_plan` request member through THIS same unified pipeline extension
// point; the SPV/GATE methods below are the reference wiring.

/** Reducer seam signature for the SPV/GATE admits. */
export type SpvGateReduceFn = (
  state: ReconciledStageState,
  action: RuntimeAction,
) => ReconciledStageState;

/**
 * Dependencies of the SPV/GATE admit methods (PO-S03-H-02).
 *
 * `reconcile` defaults to `reconcileStage` over `projectRoot`, `reduce` to
 * `reduceRuntimeAction`, `writer` to the kernel ReceiptWriter, and
 * `readManifestDigest` to the canonical `.proofloop/manifests/<stage>.json`
 * digest — callers only override what they need (tests inject a fake writer).
 */
export interface SpvGateAdmissionDeps {
  /** Project root — canonical receipt category directories resolve under it. */
  readonly projectRoot: string;
  /** Deterministic current-state source. */
  readonly reconcile?: (stageId: string) => ReconcileStageResult;
  /** Reducer seam. */
  readonly reduce?: SpvGateReduceFn;
  /** Persistence port — kernel ReceiptWriter by default. */
  readonly writer?: ReceiptWriterPort;
  /**
   * Canonical manifest digest source (manifest lifecycle binding, same seam
   * as PO-S02-E-07). Defaults to reading
   * `<projectRoot>/.proofloop/manifests/<stage>.json` and computing the
   * runtime canonical digest.
   */
  readonly readManifestDigest?: (stageId: string) => string;
}

/** Structured precheck refusal — canonical Finding, no Receipt. */
function refusePrecheck(
  code: Finding['code'],
  message: string,
): AdmitPrecheckResult {
  return { accepted: false, findings: [{ code, severity: 'error', message }] };
}

/** Re-attach the Reconcile-only chain fields to a reducer-advanced state. */
function spvGateToStageResult(
  next: ReconciledStageState,
  source: ReconcileStageResult,
): ReconcileStageResult {
  return {
    ...next,
    receipt_chain_valid: source.receipt_chain_valid,
    receipt_categories: source.receipt_categories,
  };
}

/**
 * Advance the stage state through the reducer and verify the expected target
 * was reached. An illegal transition or a missed target refuses the admit
 * (DOMAIN.INVALID_TRANSITION) — never a guess, never a wrong advance.
 */
function advanceStageTo(
  state: ReconcileStageResult,
  action: RuntimeAction,
  reduce: SpvGateReduceFn,
  reached: (stage: StageState) => boolean,
): AdmitPrecheckResult {
  let next: ReconciledStageState;
  try {
    next = reduce(state, action);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return refusePrecheck(
        'DOMAIN.INVALID_TRANSITION',
        `state advance refused for stage "${state.stage_id}" via ${action.entity}.${action.event}: ${err.message}`,
      );
    }
    throw err;
  }
  if (!reached(next.stage_state)) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `state advance via ${action.entity}.${action.event} did not reach the expected target for stage "${state.stage_id}"`,
    );
  }
  return { accepted: true, nextState: spvGateToStageResult(next, state) };
}

/**
 * Manifest digest binding check (manifest lifecycle binding): the request
 * digest must equal the canonical digest of the stage manifest. Returns null
 * on mismatch/unavailability — callers map to a precise refusal.
 */
function boundManifestDigest(
  requestStageId: string,
  requestDigest: string,
  deps: SpvGateAdmissionDeps,
): string | null {
  const readDigest =
    deps.readManifestDigest ??
    ((stageId: string) => manifestFileDigest({ projectRoot: deps.projectRoot, stageId }));
  let canonical: string;
  try {
    canonical = readDigest(requestStageId);
  } catch {
    return null;
  }
  return requestDigest === canonical ? canonical : null;
}

// ── admitSpvResult (PO-S03-H-02) ─────────────────────────────────────────────

/**
 * Admit the SPV result of a planned stage: `SPV_PASS` Receipt to
 * `plan/<stage>/`. Preconditions (fail closed): the stage is derived PLANNING
 * and the request `manifestDigest` binds the canonical stage manifest digest.
 * On acceptance the reducer `FINALIZE_PLAN` advances PLANNING → READY (§6).
 *
 * @param request - `{ type: 'spv_result', stageId, manifestDigest, summary }`
 *        — schema-validated inside the pipeline.
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export function admitSpvResult(
  request: SpvResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitResult {
  return runAdmitPipeline({
    request,
    reconcile:
      deps.reconcile ?? ((stageId) => reconcileStage({ projectRoot: deps.projectRoot, stageId })),
    writer: deps.writer,
    steps: spvResultSteps(request, deps),
  });
}

/** Per-admit pipeline wiring for SPV-result admits. */
function spvResultSteps(
  request: SpvResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitPipelineSteps {
  const reduce = deps.reduce ?? reduceRuntimeAction;
  return {
    precheck: (state) => spvResultPrecheck(state, request, deps, reduce),
    buildReceipt: () => ({
      type: 'SPV_PASS',
      stage_id: request.stageId,
      timestamp: new Date().toISOString(),
      payload: {
        status: 'approved',
        manifest_digest: request.manifestDigest,
        summary: request.summary,
      },
    }),
    targetDir: () => planReceiptDir(deps.projectRoot, request.stageId),
  };
}

/**
 * SPV precheck (PO-S03-H-02):
 *   - the stage must be derived PLANNING (STAGE_PLAN receipt present, no
 *     SPV_PASS yet — a stage that was already approved / never planned is
 *     refused, which also makes repeated SPV admits impossible);
 *   - the request manifest digest must bind the canonical stage manifest
 *     digest (missing manifest source → DOMAIN.STAGE_NOT_FOUND; mismatch →
 *     DOMAIN.INVALID_TRANSITION);
 *   - reducer FINALIZE_PLAN advances PLANNING → READY (§6).
 */
function spvResultPrecheck(
  state: ReconcileStageResult,
  request: SpvResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
  reduce: SpvGateReduceFn,
): AdmitPrecheckResult {
  if (state.stage_state !== StageState.PLANNING) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage "${state.stage_id}" is ${state.stage_state}, expected PLANNING for SPV admit`,
    );
  }
  const canonical = boundManifestDigest(request.stageId, request.manifestDigest, deps);
  if (canonical === null) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match the canonical digest (or the manifest is unavailable)`,
    );
  }
  return advanceStageTo(
    state,
    { entity: 'stage', event: 'FINALIZE_PLAN' },
    reduce,
    (s) => s === StageState.READY,
  );
}

// ── admitGateResult (PO-S03-H-02) ────────────────────────────────────────────

/**
 * Admit the result of a Stage Gate run: `GATE_PASS` / `GATE_FAIL` Receipt to
 * `stage-gate/<stage>/`. Preconditions (fail closed, all verified on real
 * fixtures): every slice is derived INTEGRATED, the working tree is git-clean,
 * the request `snapshotDigest` binds the current git HEAD, and the request
 * `manifestDigest` binds the canonical stage manifest digest. A stage already
 * reviewed (COMPLETED) is refused. On PASS the stage stays at its derived
 * UNDER_REVIEW state (receipts-only reconciliation already derives
 * UNDER_REVIEW from SPV_PASS + all-integrated, §6 READY/UNDER_REVIEW rules);
 * a FAIL writes the receipt without any state advance.
 *
 * @param request - `{ type: 'gate_result', stageId, verdict, manifestDigest,
 *        snapshotDigest, summary }` — schema-validated inside the pipeline.
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export function admitGateResult(
  request: GateResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitResult {
  return runAdmitPipeline({
    request,
    reconcile:
      deps.reconcile ?? ((stageId) => reconcileStage({ projectRoot: deps.projectRoot, stageId })),
    writer: deps.writer,
    steps: gateResultSteps(request, deps),
  });
}

/** Per-admit pipeline wiring for gate-result admits. */
function gateResultSteps(
  request: GateResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitPipelineSteps {
  const reduce = deps.reduce ?? reduceRuntimeAction;
  return {
    precheck: (state) => gateResultPrecheck(state, request, deps, reduce),
    buildReceipt: () => ({
      type: request.verdict === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL',
      stage_id: request.stageId,
      timestamp: new Date().toISOString(),
      payload: {
        verdict: request.verdict,
        manifest_digest: request.manifestDigest,
        snapshot_digest: request.snapshotDigest,
        summary: request.summary,
      },
    }),
    targetDir: () => stageGateReceiptDir(deps.projectRoot, request.stageId),
  };
}

/**
 * Gate precheck (PO-S03-H-02), in deterministic order:
 *   1. every manifest slice must be derived INTEGRATED (reconcile fact);
 *   2. the stage must be derived UNDER_REVIEW (a COMPLETED / PLANNING /
 *      UNINITIALIZED stage is refused — the gate runs between execution and
 *      review);
 *   3. the working tree must be git-clean (`git status --porcelain` empty);
 *   4. the request HEAD binding must equal the current git HEAD;
 *   5. the request manifest digest must bind the canonical stage manifest
 *      digest.
 * No state advance: PASS/FAIL both keep the derived stage state (the receipt
 * is the fact; derive-next-action consumes GATE_PASS/GATE_FAIL presence).
 */
function gateResultPrecheck(
  state: ReconcileStageResult,
  request: GateResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
  _reduce: SpvGateReduceFn,
): AdmitPrecheckResult {
  // 1. all-integrated (a zero-slice stage carries no integration evidence).
  const notIntegrated = state.slices.filter((s) => !s.integrated);
  if (state.slices.length === 0 || notIntegrated.length > 0) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate refused: not every slice is integrated. ` +
        `Non-integrated slices: ${notIntegrated.map((s) => s.slice_id).join(', ')}`,
    );
  }
  // 2. stage must be derived UNDER_REVIEW (not yet reviewed, already executed).
  if (state.stage_state !== StageState.UNDER_REVIEW) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage "${state.stage_id}" is ${state.stage_state}, expected UNDER_REVIEW for gate admit`,
    );
  }
  // 3. git-clean working tree.
  let clean: boolean;
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: deps.projectRoot,
      encoding: 'utf-8',
    });
    clean = porcelain.trim().length === 0;
  } catch {
    clean = false;
  }
  if (!clean) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate refused: working tree is not clean in "${deps.projectRoot}" (git status --porcelain non-empty)`,
    );
  }
  // 4. HEAD binding — the gate run must be bound to the current HEAD.
  let head: string | null = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: deps.projectRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    head = null;
  }
  if (head === null || request.snapshotDigest !== head) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate refused: request snapshotDigest "${request.snapshotDigest}" does not match the current git HEAD "${head ?? 'unresolvable'}"`,
    );
  }
  // 5. manifest digest binding.
  const canonical = boundManifestDigest(request.stageId, request.manifestDigest, deps);
  if (canonical === null) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match the canonical digest (or the manifest is unavailable)`,
    );
  }
  return { accepted: true, nextState: state };
}

// ── admitGateInterrupted (S05-A-T05, HP-004/AWI-015) ────────────────────────

/**
 * Admit an INTERRUPTED Stage Gate run: `GATE_INTERRUPTED` Receipt to
 * `stage-gate/<stage>/` (additive 13th ReceiptType). The gate run was
 * cancelled or timed out — this is NOT a verdict: no PASS/FAIL is ever
 * written, the payload carries `reason: 'cancelled' | 'timeout'` and
 * `duration_ms`, and the receipt never blocks the next action like
 * GATE_FAIL nor passes the gate like GATE_PASS — the interrupted gate is
 * retryable (derive-next-action Row 11 still derives RUN_GATE because
 * `gate_fail_present` matches only GATE_FAIL).
 *
 * Preconditions (fail closed, mirror the gate-result context):
 *   1. every manifest slice is derived INTEGRATED;
 *   2. the stage is derived UNDER_REVIEW (the gate runs between execution
 *      and review);
 *   3. the request HEAD binding must equal the current git HEAD;
 *   4. the request manifest digest must bind the canonical stage manifest
 *      digest.
 *
 * Unlike `admitGateResult`, the working-tree git-clean check is NOT a
 * precondition: an interrupted run may leave a dirty tree, and the
 * interruption fact must still be recorded so the gate can be retried.
 * No state advance — the receipt is the fact; derive-next-action consumes
 * gate receipt presence.
 *
 * @param request - `{ type: 'gate_interrupted', stageId, reason,
 *        durationMs, manifestDigest, snapshotDigest }` — schema-validated
 *        inside the pipeline (reason ∈ closed {cancelled, timeout}).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export function admitGateInterrupted(
  request: GateInterruptedAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitResult {
  return runAdmitPipeline({
    request,
    reconcile:
      deps.reconcile ?? ((stageId) => reconcileStage({ projectRoot: deps.projectRoot, stageId })),
    writer: deps.writer,
    steps: gateInterruptedSteps(request, deps),
  });
}

/** Per-admit pipeline wiring for gate-interrupted admits. */
function gateInterruptedSteps(
  request: GateInterruptedAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitPipelineSteps {
  const reduce = deps.reduce ?? reduceRuntimeAction;
  return {
    precheck: (state) => gateInterruptedPrecheck(state, request, deps, reduce),
    buildReceipt: () => ({
      type: 'GATE_INTERRUPTED',
      stage_id: request.stageId,
      timestamp: new Date().toISOString(),
      payload: {
        reason: request.reason,
        duration_ms: request.durationMs,
        manifest_digest: request.manifestDigest,
        snapshot_digest: request.snapshotDigest,
      },
    }),
    targetDir: () => stageGateReceiptDir(deps.projectRoot, request.stageId),
  };
}

/**
 * Gate-interrupted precheck, in deterministic order (mirror the gate-result
 * context minus the git-clean requirement):
 *   1. every manifest slice must be derived INTEGRATED;
 *   2. the stage must be derived UNDER_REVIEW;
 *   3. the request HEAD binding must equal the current git HEAD;
 *   4. the request manifest digest must bind the canonical stage manifest
 *      digest.
 * No state advance — the interruption receipt is the fact.
 */
function gateInterruptedPrecheck(
  state: ReconcileStageResult,
  request: GateInterruptedAdmissionRequest,
  deps: SpvGateAdmissionDeps,
  _reduce: SpvGateReduceFn,
): AdmitPrecheckResult {
  // 1. all-integrated (a zero-slice stage carries no integration evidence).
  const notIntegrated = state.slices.filter((s) => !s.integrated);
  if (state.slices.length === 0 || notIntegrated.length > 0) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate interruption refused: not every slice is integrated. ` +
        `Non-integrated slices: ${notIntegrated.map((s) => s.slice_id).join(', ')}`,
    );
  }
  // 2. stage must be derived UNDER_REVIEW (the gate runs between execution
  //    and review).
  if (state.stage_state !== StageState.UNDER_REVIEW) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage "${state.stage_id}" is ${state.stage_state}, expected UNDER_REVIEW for gate interruption admit`,
    );
  }
  // 3. HEAD binding — the interrupted run must be bound to the current HEAD.
  let head: string | null = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: deps.projectRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    head = null;
  }
  if (head === null || request.snapshotDigest !== head) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate interruption refused: request snapshotDigest "${request.snapshotDigest}" does not match the current git HEAD "${head ?? 'unresolvable'}"`,
    );
  }
  // 4. manifest digest binding.
  const canonical = boundManifestDigest(request.stageId, request.manifestDigest, deps);
  if (canonical === null) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match the canonical digest (or the manifest is unavailable)`,
    );
  }
  return { accepted: true, nextState: state };
}
