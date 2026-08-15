/**
 * proofloop-plan.ts — S10-B-T01: plan 域 handler（含 authority check）。
 *
 * Closed operation set（S10-B-T01 / dispatch 操作闭集）：
 *  - `plan compile` → compile-vnext-manifest seam
 *  - `plan validate` → validate-vnext-stage seam（read-only）
 *  - `plan initialize-evidence` → initialize-vnext-slice-evidence seam
 *  - `plan refresh-evidence` → refresh-vnext-slice-evidence seam（Runtime-owned
 *    pre-admission，只接受 current Manifest ref/digest + previous digest）
 *  - `plan status` → read-only plan status（Manifest digest / slices / admission）
 *  - `authority check` → read-only Authority refs / blocking Hard Part 就绪检查
 *
 * All operations consume the unified request contract（domain/operation +
 * bounded params）and emit the canonical envelope（ok:true + data，或
 * ok:false + findings）。Unknown operations are already rejected by the closed
 * registry in the dispatcher before this handler runs（exit 2，no write）。
 *
 * This handler only reuses the existing seams listed above — it never
 * re-implements compiler/validator/initializer/refresh internals.  Read-only
 * operations（validate/status/authority check）never write any file.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, VNEXT_SCHEMA_VERSION } from '@proofloop/kernel';
import {
  parseEvidencePlanBinding,
  readRootBoundFile,
  readRootBoundJson,
  validateVNextManifestArtifact,
} from './vnext-cli-support-vnext';
import { compileVNextManifestResult } from './compile-vnext-manifest';
import { validateVNextStage } from './validate-vnext-stage';
import { initializeVNextSliceEvidence } from './initialize-vnext-slice-evidence';
import { refreshVNextSliceEvidence } from '../vnext/evidence-refresh';
import { readActiveCandidateInput, admitVNextStagePlan, materializeCandidatePlan } from '../vnext';
import { admitVNextSpvPass } from './admit-vnext-stage-plan';
// P-11 task B: read-only STAGE_CLOSE archived-facts probe.  An archived
// Stage's Manifest is a historical snapshot — `plan validate` skips the
// reference/evidence digest re-validation and reports valid + archived:true.
import { readStageCloseFacts } from '../vnext/stage-close-facts';
import {
  errorEnvelope,
  failureEnvelope,
  okEnvelope,
  okEnvelopeWithRefs,
  type CliCommand,
  type CliEnvelope,
  type CliRequestInput,
  type ParsedCliArgs,
} from './proofloop-common';

/** Bounded plan/authority operation parameters（unified request contract）。 */
export interface PlanOperationParams {
  /** Target canonical Stage ID（`^S\d+$`）。 */
  readonly stage?: string;
  /** Root-relative vNext Manifest path（default `.proofloop/manifests/<stage>.json`）。 */
  readonly manifest?: string;
  /** `plan refresh-evidence`: previous Manifest digest the skeletons still bind. */
  readonly previous_manifest_digest?: string;
  /** Explicit evidence directory（default derived from the Manifest）。 */
  readonly evidence_dir?: string;
  /** `plan refresh-evidence`: transaction mode（refresh | recover | rollback）。 */
  readonly mode?: 'refresh' | 'recover' | 'rollback';
  /** `plan materialize`: read-only recheck mode（CANDIDATE_CHECKED，零写入）。
   * closed request schema 已登记 check 字段（A1 步骤 5 完成；boolean，非法值在
   * parseClosedRequestObject fail-closed），collectPlanParams 透传。 */
  readonly check?: boolean;
  /** `plan compile`: root-relative candidate input JSON. */
  readonly input_path?: string;
  /** `plan compile`: root-relative Manifest output path（default per stage）。 */
  readonly output_path?: string;
}

/** Merge the closed request input and CLI flags into bounded plan params. */
export function collectPlanParams(
  parsed: ParsedCliArgs,
  request: CliRequestInput,
): PlanOperationParams {
  // A1 step 5: the plan-domain `check` (closed boolean, validated in
  // parseClosedRequestObject) reaches the handler through the superset cast
  // precedent (same as gate re_gate / cutover confirmed).  A non-boolean
  // value is refused by the schema; only `true` enables the read-only
  // CANDIDATE_CHECKED recheck path.
  const extended = request as unknown as Record<string, unknown>;
  const declaredCheck = extended['check'];
  return {
    stage: parsed.stage ?? request.stage,
    manifest: request.manifest,
    previous_manifest_digest: request.previous_manifest_digest,
    evidence_dir: request.evidence_dir,
    mode: request.mode as PlanOperationParams['mode'],
    check: typeof declaredCheck === 'boolean' ? declaredCheck : undefined,
    input_path: request.input_path,
    output_path: request.output_path,
  };
}

// ============================================================
// Manifest resolution helpers
// ============================================================

type ResolvedManifest =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Resolve the root-relative Manifest path: explicit `manifest` param wins;
 * otherwise `.proofloop/manifests/<stage>.json`（stage required）。
 */
function resolveManifestPath(root: string, params: PlanOperationParams): ResolvedManifest {
  if (params.manifest !== undefined) {
    if (typeof params.manifest !== 'string' || params.manifest.length === 0) {
      return { ok: false, code: 'PLAN.ARGUMENT_INVALID', message: 'manifest must be a non-empty root-relative path' };
    }
    if (
      params.manifest.includes('\u0000') ||
      params.manifest.includes('\\') ||
      path.isAbsolute(params.manifest)
    ) {
      return { ok: false, code: 'PLAN.ARGUMENT_INVALID', message: `manifest must be a canonical root-relative path: "${params.manifest}"` };
    }
    const parts = params.manifest.split('/');
    if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
      return { ok: false, code: 'PLAN.ARGUMENT_INVALID', message: `manifest contains a non-canonical path component: "${params.manifest}"` };
    }
    return { ok: true, path: params.manifest };
  }
  if (params.stage === undefined) {
    return { ok: false, code: 'PLAN.STAGE_REQUIRED', message: 'plan operation requires a target stage (--stage <stage-id> or request field "stage")' };
  }
  return { ok: true, path: `.proofloop/manifests/${params.stage}.json` };
}

type ReadManifestResult =
  | { readonly ok: true; readonly value: Record<string, unknown>; readonly digest: string }
  | { readonly ok: false; readonly message: string };

function readManifest(root: string, manifestPath: string): ReadManifestResult {
  try {
    const read = readRootBoundJson(root, manifestPath, 'vNext manifest');
    return { ok: true, value: read.value as Record<string, unknown>, digest: computeDigest(read.value) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** S10-B-T02 repair round 3: Manifest stage_id must bind the requested
 * stage exactly (CLI --stage / request stage / manifest.stage_id 一致)。
 * 显式 manifest 与错误 --stage 组合 fail closed 零写入。 */
function assertManifestStageBinding(
  command: CliCommand,
  manifest: Record<string, unknown>,
  requestedStage: string | undefined,
  manifestPath: string,
): CliEnvelope | null {
  if (requestedStage === undefined) return null;
  const manifestStage = manifest.stage_id;
  if (manifestStage !== requestedStage) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_BINDING',
      `Manifest "${manifestPath}" stage_id "${String(manifestStage)}" does not match requested stage "${requestedStage}"`,
    );
  }
  return null;
}

/** Derived evidence directory when every slice shares exactly one parent. */
function derivedEvidenceDir(root: string, manifest: Record<string, unknown>): string | null {
  const slices = manifest.slices;
  if (!Array.isArray(slices) || slices.length === 0) return null;
  const parents = new Set<string>();
  for (const slice of slices) {
    if (typeof slice !== 'object' || slice === null) return null;
    const evidencePath = (slice as Record<string, unknown>).evidence_path;
    if (typeof evidencePath !== 'string' || evidencePath.length === 0) return null;
    try {
      parents.add(path.dirname(path.resolve(root, evidencePath)));
    } catch {
      return null;
    }
  }
  return parents.size === 1 ? [...parents][0] : null;
}

function receiptExists(root: string, relative: string): boolean {
  try {
    return fs.existsSync(path.join(root, relative)) && fs.statSync(path.join(root, relative)).isFile();
  } catch {
    return false;
  }
}

function seamFindings(errors: ReadonlyArray<{ readonly type: string; readonly message: string }>) {
  return errors.map((error) => ({ code: error.type, message: error.message }));
}

// ============================================================
// plan validate（read-only）
// ============================================================

function runPlanValidate(root: string, command: CliCommand, params: PlanOperationParams): CliEnvelope {
  const resolved = resolveManifestPath(root, params);
  if (!resolved.ok) return errorEnvelope(command, resolved.code, resolved.message);

  const read = readManifest(root, resolved.path);
  if (!read.ok) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_NOT_FOUND',
      `Manifest "${resolved.path}" cannot be read as a root-bound file: ${read.message}`,
    );
  }

  const manifest = read.value;
  const stageBinding = assertManifestStageBinding(command, manifest, params.stage, resolved.path);
  if (stageBinding !== null) return stageBinding;
  const plan = manifest.plan;
  const tasksPath = typeof plan === 'object' && plan !== null && typeof (plan as Record<string, unknown>).ref === 'string'
    ? ((plan as Record<string, unknown>).ref as string)
    : null;
  if (tasksPath === null) {
    return errorEnvelope(command, 'PLAN.MANIFEST_INVALID', `Manifest "${resolved.path}" carries no valid plan.ref`);
  }

  // P-11 task B: 存在合法 v2 STAGE_CLOSE_RESULT envelope ⇒ Stage 已归档
  // （历史快照）：跳过 reference binding / evidence 校验，返回 valid +
  // archived:true（exit 0，envelope 结构不变）。探测 root-bound 且
  // fail-closed —— 目录不可读/破损时 block（绝不降级为“未归档”）。
  const manifestStageId = typeof manifest.stage_id === 'string' ? manifest.stage_id : null;
  if (manifestStageId !== null && /^S\d+$/.test(manifestStageId)) {
    let closeFacts: ReturnType<typeof readStageCloseFacts>;
    try {
      closeFacts = readStageCloseFacts(root, manifestStageId);
    } catch (error) {
      return errorEnvelope(
        command,
        'RUNTIME.RECEIPT_CHAIN_BROKEN',
        `plan validate blocked: stage-close facts are unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (closeFacts.archived) {
      return okEnvelope(command, {
        valid: true,
        stage_id: manifestStageId,
        schema_version: VNEXT_SCHEMA_VERSION,
        errors: [],
        archived: true,
      });
    }
  }

  let evidenceDir = params.evidence_dir;
  if (evidenceDir === undefined) {
    evidenceDir = derivedEvidenceDir(root, manifest) ?? undefined;
    if (evidenceDir === undefined) {
      return errorEnvelope(
        command,
        'PLAN.EVIDENCE_DIR_AMBIGUOUS',
        'Manifest slices do not share one evidence directory; pass request field "evidence_dir" explicitly',
      );
    }
  }

  const result = validateVNextStage(tasksPath, resolved.path, evidenceDir, root);
  if (result.valid) {
    return okEnvelope(command, result);
  }
  return failureEnvelope(command, seamFindings(result.errors));
}

// ============================================================
// plan status（read-only）
// ============================================================

function runPlanStatus(root: string, command: CliCommand, params: PlanOperationParams): CliEnvelope {
  const resolved = resolveManifestPath(root, params);
  if (!resolved.ok) return errorEnvelope(command, resolved.code, resolved.message);

  // S10-B-T02 repair: status must fail closed on v1 / unknown-version /
  // malformed / stage-mismatched / stale Manifest input instead of reporting
  // success (legacy or unknown input never produces an ok status).
  const manifestPath = path.join(root, resolved.path);
  if (!fs.existsSync(manifestPath)) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_NOT_FOUND',
      `Manifest "${resolved.path}" does not exist`,
    );
  }

  const read = readManifest(root, resolved.path);
  if (!read.ok) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_INVALID',
      `Manifest "${resolved.path}" cannot be read as valid JSON: ${read.message}`,
    );
  }

  const raw = read.value;
  const rawPlan = raw.plan;
  const planSchemaVersion =
    typeof rawPlan === 'object' && rawPlan !== null && !Array.isArray(rawPlan)
      ? (rawPlan as Record<string, unknown>).schema_version
      : undefined;
  if (raw.version !== 2 || planSchemaVersion !== 2) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_INVALID',
      `Manifest "${resolved.path}" must be version 2 with plan.schema_version 2 (received version=${String(raw.version)} plan.schema_version=${String(planSchemaVersion)}); legacy or unknown Manifests fail closed`,
    );
  }
  const stageId = typeof raw.stage_id === 'string' ? raw.stage_id : null;
  if (stageId === null || stageId !== params.stage) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_BINDING',
      `Manifest stage_id "${String(stageId)}" does not match requested stage "${String(params.stage)}"`,
    );
  }

  // Manifest/Plan/reference binding completeness: stale or incomplete
  // bindings fail closed (same strength as authority check).
  const checked = validateVNextManifestArtifact(root, raw, { verifyReferenceDigests: true });
  const manifest = checked.manifest;
  if (manifest === null) {
    return failureEnvelope(command, seamFindings(checked.errors));
  }

  const plan = manifest.plan as Record<string, unknown> | undefined;
  const slices = Array.isArray(manifest.slices)
    ? (manifest.slices as unknown as Array<Record<string, unknown>>)
    : [];

  const sliceStatus = slices.map((slice) => {
    const sliceId = typeof slice.slice_id === 'string' ? slice.slice_id : 'unknown';
    const evidencePath = typeof slice.evidence_path === 'string' ? slice.evidence_path : null;
    let evidencePresent = false;
    let bindingOk = false;
    if (evidencePath !== null) {
      try {
        const content = readRootBoundFile(root, evidencePath).content;
        evidencePresent = true;
        const binding = parseEvidencePlanBinding(content);
        bindingOk = binding !== null && binding.manifest_digest === read.digest;
      } catch {
        evidencePresent = false;
      }
    }
    return { slice_id: sliceId, evidence_path: evidencePath, evidence_present: evidencePresent, evidence_binding_ok: bindingOk };
  });

  // S10-B-T02 repair round 2: stale/missing Evidence must fail closed — a
  // status that reports success while an Evidence skeleton is missing or
  // bound to an old Manifest digest would mask a stale plan boundary.
  const brokenEvidence = sliceStatus.find(
    (status) => !status.evidence_present || !status.evidence_binding_ok,
  );
  if (brokenEvidence !== undefined) {
    return errorEnvelope(
      command,
      'PLAN.EVIDENCE_BINDING',
      `Slice "${brokenEvidence.slice_id}" Evidence is missing or not bound to the current Manifest digest (evidence_present=${String(brokenEvidence.evidence_present)} evidence_binding_ok=${String(brokenEvidence.evidence_binding_ok)})`,
    );
  }

  return okEnvelope(command, {
    stage_id: stageId,
    manifest_path: resolved.path,
    manifest_digest: read.digest,
    plan: {
      ref: typeof plan?.ref === 'string' ? plan.ref : null,
      plan_digest: typeof plan?.plan_digest === 'string' ? plan.plan_digest : null,
      schema_version: typeof plan?.schema_version === 'number' ? plan.schema_version : null,
    },
    slices: sliceStatus,
    admission: {
      spv: receiptExists(root, `.proofloop/receipts/plan/${stageId}/vnext-spv-pass.json`),
      stage_plan: receiptExists(root, `.proofloop/receipts/plan/${stageId}/vnext-stage-plan.json`),
    },
  });
}

// ============================================================
// authority check（read-only）
// ============================================================

/** Read-only Authority refs / blocking Hard Part readiness for a Stage. */
export function runAuthorityCheck(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: PlanOperationParams,
): CliEnvelope {
  const resolved = resolveManifestPath(root, params);
  if (!resolved.ok) return errorEnvelope(command, resolved.code, resolved.message);

  const read = readManifest(root, resolved.path);
  if (!read.ok) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_NOT_FOUND',
      `Manifest "${resolved.path}" cannot be read as a root-bound file: ${read.message}`,
    );
  }
  const stageBinding = assertManifestStageBinding(command, read.value, params.stage, resolved.path);
  if (stageBinding !== null) return stageBinding;

  const checked = validateVNextManifestArtifact(root, read.value, { verifyReferenceDigests: true });
  const manifest = checked.manifest;
  const stageId = typeof read.value.stage_id === 'string' ? read.value.stage_id : 'unknown';

  const authorityRefs: Array<{ ref_id: string; kind: string | null; ref: string | null; resolvable: boolean }> = [];
  const blockingRisks: Array<{ ref_id: string; kind: string | null; ref: string | null; resolvable: boolean }> = [];
  if (manifest !== null) {
    const authorityIds = manifest.authority_ref_ids ?? [];
    for (const refId of authorityIds) {
      const descriptor = manifest.reference_index[refId];
      authorityRefs.push({
        ref_id: refId,
        kind: descriptor?.kind ?? null,
        ref: descriptor?.ref ?? null,
        resolvable: descriptor !== undefined,
      });
    }
    for (const [refId, descriptor] of Object.entries(manifest.reference_index)) {
      if (descriptor.kind === 'risk') {
        blockingRisks.push({ ref_id: refId, kind: descriptor.kind, ref: descriptor.ref, resolvable: true });
      }
    }
  }

  const ready = manifest !== null && checked.errors.length === 0;
  const report = {
    stage_id: stageId,
    manifest_path: resolved.path,
    manifest_digest: read.digest,
    ready,
    authority_refs: authorityRefs,
    blocking_risks: blockingRisks,
    admission: {
      spv: receiptExists(root, `.proofloop/receipts/plan/${stageId}/vnext-spv-pass.json`),
      stage_plan: receiptExists(root, `.proofloop/receipts/plan/${stageId}/vnext-stage-plan.json`),
    },
  };
  if (!ready) {
    return failureEnvelope(command, seamFindings(checked.errors));
  }
  return okEnvelope(command, report);
}

// ============================================================
// plan compile
// ============================================================

function runPlanCompile(root: string, command: CliCommand, params: PlanOperationParams): CliEnvelope {
  if (params.input_path === undefined) {
    return errorEnvelope(command, 'PLAN.INPUT_REQUIRED', 'plan compile requires a candidate input (request field "input_path")');
  }
  if (
    typeof params.input_path !== 'string' ||
    params.input_path.length === 0 ||
    path.isAbsolute(params.input_path) ||
    params.input_path.includes('..') ||
    params.input_path.includes('\\') ||
    params.input_path.includes('\u0000')
  ) {
    return errorEnvelope(command, 'PLAN.ARGUMENT_INVALID', `input_path must be a canonical root-relative path: "${params.input_path}"`);
  }

  let outputPath = params.output_path;
  let stage = params.stage;
  if (outputPath === undefined) {
    if (stage === undefined) {
      // Derive the Stage from the candidate input itself.
      try {
        const loaded = JSON.parse(readRootBoundFile(root, params.input_path).content) as unknown;
        const candidateStage = typeof loaded === 'object' && loaded !== null
          ? (loaded as Record<string, unknown>).stage_id
          : undefined;
        if (typeof candidateStage !== 'string' || candidateStage.length === 0) {
          return errorEnvelope(command, 'PLAN.STAGE_REQUIRED', 'cannot derive stage_id from the candidate input; pass --stage or request field "stage"');
        }
        stage = candidateStage;
      } catch (error) {
        return errorEnvelope(
          command,
          'PLAN.INPUT_INVALID',
          `candidate input "${params.input_path}" cannot be read as root-bound JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    outputPath = `.proofloop/manifests/${stage}.json`;
  }
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    return errorEnvelope(command, 'PLAN.ARGUMENT_INVALID', 'output_path must be a non-empty root-relative path');
  }

  // S10-B-T02 repair round 3: candidate.stage_id must bind the requested
  // stage — an S04 candidate must never compile into an S10 target.
  if (stage !== undefined) {
    try {
      const loaded = JSON.parse(readRootBoundFile(root, params.input_path).content) as unknown;
      const candidateStage = typeof loaded === 'object' && loaded !== null
        ? (loaded as Record<string, unknown>).stage_id
        : undefined;
      if (candidateStage !== stage) {
        return errorEnvelope(
          command,
          'RUNTIME.INPUT_INVALID',
          `candidate input stage_id "${String(candidateStage)}" does not match requested stage "${stage}"`,
        );
      }
    } catch (error) {
      return errorEnvelope(
        command,
        'PLAN.INPUT_INVALID',
        `candidate input "${params.input_path}" cannot be read as root-bound JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const inputPathAbsolute = path.resolve(root, params.input_path);
  const result = compileVNextManifestResult(inputPathAbsolute, outputPath, root);
  if (result.success) {
    return okEnvelopeWithRefs(
      command,
      {
        success: true,
        manifest_path: result.manifest_path,
        manifest_digest: result.manifest_digest,
        stage_id: result.stage_id,
        schema_version: result.schema_version,
        errors: result.errors,
      },
      [{ ref: outputPath, digest: result.manifest_digest as string }],
    );
  }
  return failureEnvelope(command, seamFindings(result.errors));
}

// ============================================================
// plan initialize-evidence
// ============================================================

function runPlanInitialize(root: string, command: CliCommand, params: PlanOperationParams): CliEnvelope {
  const resolved = resolveManifestPath(root, params);
  if (!resolved.ok) return errorEnvelope(command, resolved.code, resolved.message);

  const read = readManifest(root, resolved.path);
  if (!read.ok) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_NOT_FOUND',
      `Manifest "${resolved.path}" cannot be read as a root-bound file: ${read.message}`,
    );
  }
  const stageBinding = assertManifestStageBinding(command, read.value, params.stage, resolved.path);
  if (stageBinding !== null) return stageBinding;

  const result = initializeVNextSliceEvidence(resolved.path, params.evidence_dir, root);
  if (result.success) {
    return okEnvelopeWithRefs(command, result, [{ ref: resolved.path, digest: read.digest }]);
  }
  return failureEnvelope(command, seamFindings(result.errors));
}

// ============================================================
// plan refresh-evidence（Runtime-owned pre-admission）
// ============================================================

function runPlanRefresh(root: string, command: CliCommand, params: PlanOperationParams): CliEnvelope {
  if (params.previous_manifest_digest === undefined) {
    return errorEnvelope(
      command,
      'PLAN.PREVIOUS_MANIFEST_DIGEST_REQUIRED',
      'plan refresh-evidence requires the previous Manifest digest (request field "previous_manifest_digest")',
    );
  }
  const resolved = resolveManifestPath(root, params);
  if (!resolved.ok) return errorEnvelope(command, resolved.code, resolved.message);

  const read = readManifest(root, resolved.path);
  if (!read.ok) {
    return errorEnvelope(
      command,
      'PLAN.MANIFEST_NOT_FOUND',
      `Manifest "${resolved.path}" cannot be read as a root-bound file: ${read.message}`,
    );
  }
  const stageBinding = assertManifestStageBinding(command, read.value, params.stage, resolved.path);
  if (stageBinding !== null) return stageBinding;

  const result = refreshVNextSliceEvidence({
    manifestPath: resolved.path,
    previousManifestDigest: params.previous_manifest_digest,
    evidenceDir: params.evidence_dir,
    projectRoot: root,
    mode: params.mode ?? 'refresh',
  });
  if (result.success) {
    return okEnvelopeWithRefs(command, result, [{ ref: resolved.path, digest: read.digest }]);
  }
  return failureEnvelope(command, seamFindings(result.errors));
}

// ============================================================
// plan materialize / admit-spv / admit-stage-plan（S10-B-T02 repair）
// ============================================================

/** Validate a root-relative input path（canonical, no traversal）。 */
function validateInputPath(
  command: CliCommand,
  inputPath: string,
): CliEnvelope | string {
  if (
    typeof inputPath !== 'string' ||
    inputPath.length === 0 ||
    path.isAbsolute(inputPath) ||
    inputPath.includes('..') ||
    inputPath.includes('\\') ||
    inputPath.includes('\u0000')
  ) {
    return errorEnvelope(
      command,
      'PLAN.ARGUMENT_INVALID',
      `input_path must be a canonical root-relative path: "${inputPath}"`,
    );
  }
  return inputPath;
}

/**
 * `plan materialize` — CLI seam of the Runtime Plan Materializer (A1 step 2):
 * validates the root-bound candidate input JSON, renders the candidate
 * tasks.md byte-identically to the active helper and writes it
 * (CANDIDATE_READY), or rechecks the already-rendered candidate read-only
 * when `check: true` (CANDIDATE_CHECKED).  Failures surface the helper's
 * structured subtype + reason verbatim (exit 2, no partial write); the
 * candidate input itself stays the single materializer-owned fact source.
 */
function runPlanMaterialize(
  root: string,
  command: CliCommand,
  params: PlanOperationParams,
): CliEnvelope {
  if (params.input_path === undefined) {
    return errorEnvelope(
      command,
      'PLAN.INPUT_REQUIRED',
      'plan materialize requires a candidate input (request field "input_path")',
    );
  }
  const inputPath = validateInputPath(command, params.input_path);
  if (typeof inputPath !== 'string') return inputPath;
  // Stage binding pre-check（fail closed 于任何渲染/写入之前）：candidate 自身
  // 的 stage_id 必须与请求的 --stage/request stage 精确一致。
  try {
    const { input } = readActiveCandidateInput(root, inputPath);
    if (params.stage !== undefined && params.stage !== input.stage_id) {
      return errorEnvelope(
        command,
        'RUNTIME.INPUT_INVALID',
        `candidate input stage_id "${input.stage_id}" does not match requested stage "${params.stage}"`,
      );
    }
  } catch (error) {
    return errorEnvelope(
      command,
      'PLAN.INPUT_INVALID',
      `candidate input "${inputPath}" is not an active materializer candidate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = materializeCandidatePlan(root, inputPath, { check: params.check === true });
  if (!result.ok) {
    // 结构化 helper 失败：原样透出 helper 的 subtype（错误码）与 reason（文案），
    // Brain 路由据此拿到精确的 PLAN_GAP/AUTHORITY_GAP/RUNTIME_BLOCKER 事实。
    return failureEnvelope(command, [{ code: result.subtype, message: result.reason }]);
  }
  let digest: string;
  try {
    digest = computeDigest(fs.readFileSync(path.join(root, result.candidate_plan_path), 'utf8'));
  } catch (error) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `candidate tasks.md cannot be read after materialization: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return okEnvelopeWithRefs(
    command,
    result,
    [{ ref: result.candidate_plan_path, digest }],
  );
}

/** Read the root-bound admission request JSON and check its project root. */
function readAdmissionRequest(
  root: string,
  command: CliCommand,
  params: PlanOperationParams,
): CliEnvelope | Record<string, unknown> {
  if (params.input_path === undefined) {
    return errorEnvelope(
      command,
      'PLAN.INPUT_REQUIRED',
      'this plan operation requires an admission request input (request field "input_path")',
    );
  }
  const inputPath = validateInputPath(command, params.input_path);
  if (typeof inputPath !== 'string') return inputPath;
  let value: unknown;
  try {
    value = readRootBoundJson(root, inputPath, 'plan admission request').value;
  } catch (error) {
    return errorEnvelope(
      command,
      'PLAN.INPUT_INVALID',
      `admission request "${inputPath}" cannot be read as root-bound JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return errorEnvelope(command, 'PLAN.INPUT_INVALID', 'admission request must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.project_root !== root) {
    return errorEnvelope(
      command,
      'RUNTIME.PATH_OUTSIDE_ROOT',
      `admission request project_root "${String(record.project_root)}" does not match the CLI trust root "${root}"`,
    );
  }
  // S10-B-T02 repair round 2: CLI --stage 与 request.stage_id 必须精确一致
  // （以 --stage S10 提交 S04 request 会写入错误 authority，fail closed 零写入）
  if (typeof record.stage_id !== 'string' || record.stage_id.length === 0) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      'admission request must carry a canonical stage_id',
    );
  }
  if (params.stage !== undefined && params.stage !== record.stage_id) {
    return errorEnvelope(
      command,
      'RUNTIME.INPUT_INVALID',
      `admission request stage_id "${record.stage_id}" does not match requested stage "${params.stage}"`,
    );
  }
  return record;
}

/** `plan admit-stage-plan` — wrapper of the Runtime Stage Plan admission seam. */
function runPlanAdmitStagePlan(
  root: string,
  command: CliCommand,
  params: PlanOperationParams,
): CliEnvelope {
  const request = readAdmissionRequest(root, command, params);
  if (!('type' in request)) return request as CliEnvelope;
  const result = admitVNextStagePlan(request);
  if (result.accepted) {
    return okEnvelopeWithRefs(
      command,
      {
        accepted: true,
        stage_id: result.stage_id,
        manifest_digest: result.manifest_digest,
        plan_digest: result.plan_digest,
        snapshot_digest: result.snapshot_digest,
        spv_receipt_path: result.spv_receipt_path,
        stage_plan_receipt_path: result.stage_plan_receipt_path,
      },
      [
        { ref: path.relative(root, result.spv_receipt_path), digest: result.spv.digest },
        { ref: path.relative(root, result.stage_plan_receipt_path), digest: result.stage_plan.digest },
      ],
    );
  }
  return failureEnvelope(
    command,
    result.findings.map((finding) => ({ code: finding.code, message: finding.message })),
  );
}

/** `plan admit-spv` — wrapper of the Runtime SPV-only admission seam (§1.1). */
function runPlanAdmitSpv(
  root: string,
  command: CliCommand,
  params: PlanOperationParams,
): CliEnvelope {
  const request = readAdmissionRequest(root, command, params);
  if (!('type' in request)) return request as CliEnvelope;
  const result = admitVNextSpvPass(request);
  if (result.accepted) {
    return okEnvelopeWithRefs(
      command,
      {
        accepted: true,
        stage_id: result.stage_id,
        spv_receipt_path: result.spv_receipt_path,
      },
      [{ ref: path.relative(root, result.spv_receipt_path), digest: result.spv.digest }],
    );
  }
  return failureEnvelope(
    command,
    result.findings.map((finding) => ({ code: finding.code, message: finding.message })),
  );
}

// ============================================================
// plan domain dispatch
// ============================================================

/** Run a closed plan-domain operation and return the canonical envelope. */
export function runPlan(
  root: string,
  _rootSource: 'explicit' | 'auto',
  command: CliCommand,
  params: PlanOperationParams,
): CliEnvelope {
  switch (command.operation) {
    case 'compile':
      return runPlanCompile(root, command, params);
    case 'validate':
      return runPlanValidate(root, command, params);
    case 'initialize-evidence':
      return runPlanInitialize(root, command, params);
    case 'refresh-evidence':
      return runPlanRefresh(root, command, params);
    case 'status':
      return runPlanStatus(root, command, params);
    case 'materialize':
      return runPlanMaterialize(root, command, params);
    case 'admit-spv':
      return runPlanAdmitSpv(root, command, params);
    case 'admit-stage-plan':
      return runPlanAdmitStagePlan(root, command, params);
    default:
      // Defensive: the dispatcher closed registry rejects unknown operations
      // before any handler runs; this branch never emits a write.
      return errorEnvelope(
        command,
        'RUNTIME.SCHEMA_MISMATCH',
        `unknown plan operation "${command.operation}" (closed set: materialize|compile|validate|initialize-evidence|refresh-evidence|status|admit-spv|admit-stage-plan)`,
      );
  }
}
