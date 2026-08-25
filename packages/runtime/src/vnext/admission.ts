/** Minimal vNext Stage Plan admission seam. */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  computeDigest,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  validateVNextSpvPassReceipt,
  validateVNextStagePlanReceipt,
} from "@proofloop/kernel";
import type { VNextManifest, VNextSpvPassReceipt, VNextStagePlanReceipt } from "@proofloop/kernel";
import { canonicalPathWithinRoot } from "../path-guard";
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from "./stage-id";
// S13-S17 remediation Phase 4 (CV repair #7): Stage Plan admission enforces
// the mechanical Stage Composition Closure Audit before any authority write.
import { auditVNextStageComposition } from "./stage-composition-audit";
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
  VNextHandoffError,
} from "./dispatch";
import { assertStableGitBoundary as assertStableGitBoundaryNeutral, StableGitBoundaryError } from "./git-boundary";
// S14-A-T02 — replan epoch authority (append-only). The Runtime derives the
// epoch digest, verifies the parent chain and recomputes the impact set; a
// replan request can never declare a derived fact (epoch digest, impact
// scope, carry-forward/invalidated sets).
import {
  ReplanEpochError,
  computeReplanEpochDigest,
  persistReplanEpochAuthority,
  readCurrentEpoch,
  verifyReplanAdmissionFact,
  validateVNextReplanAdmissionDeclaration,
} from "./replan-epoch";
import type { ReplanCurrentEpoch, VNextReplanAdmissionDeclaration } from "./replan-epoch";

export interface VNextStagePlanAdmissionRequest {
  readonly version: 2;
  readonly schema_version: 2;
  readonly type: "STAGE_PLAN_ADMISSION";
  readonly project_root: string;
  readonly manifest_path: string;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  readonly spv: VNextSpvPassReceipt;
  /**
   * Optional replan declaration (§8.8): ONLY parent_epoch_digest plus the
   * Runtime preparation disposition ref/digest. The epoch digest and every
   * derived set are recomputed by the Runtime and never declarable.
   */
  readonly replan?: VNextReplanAdmissionDeclaration;
}

export interface VNextStagePlanAdmissionSuccess {
  readonly accepted: true;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  readonly spv_receipt_path: string;
  readonly stage_plan_receipt_path: string;
  readonly spv: VNextSpvPassReceipt;
  readonly stage_plan: VNextStagePlanReceipt;
  /** Present only for replan admissions: the derived epoch digest. */
  readonly replan_epoch_digest?: string;
  /** Present only for replan admissions: the epoch refs authority path. */
  readonly epoch_refs_path?: string;
}

export interface VNextStagePlanAdmissionFailure {
  readonly accepted: false;
  readonly stage_id: string;
  readonly findings: readonly [{
    readonly code: "RUNTIME.SCHEMA_MISMATCH";
    readonly severity: "error";
    readonly message: string;
  }];
}

export type VNextStagePlanAdmissionResult = VNextStagePlanAdmissionSuccess | VNextStagePlanAdmissionFailure;

export class VNextStagePlanAdmissionError extends Error {
  public readonly code:
    | "request-invalid"
    | "root-escape"
    | "manifest-invalid"
    | "manifest-binding"
    | "spv-invalid"
    | "spv-binding"
    | "git-unavailable"
    | "worktree-dirty"
    | "snapshot-binding"
    | "already-admitted"
    | "write-failed"
    | "replan-invalid"
    | "replan-parent"
    | "replan-fact"
    | "replan-impact"
    | "replan-epoch";

  constructor(code: VNextStagePlanAdmissionError["code"], message: string) {
    super(message);
    this.name = "VNextStagePlanAdmissionError";
    this.code = code;
  }
}

const REQUEST_FIELDS = new Set([
  "version", "schema_version", "type", "project_root", "manifest_path",
  "stage_id", "manifest_digest", "plan_digest", "snapshot_digest", "spv",
  "replan",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fail(code: VNextStagePlanAdmissionError["code"], message: string): never {
  throw new VNextStagePlanAdmissionError(code, message);
}

export function validateVNextStagePlanAdmissionRequest(value: unknown): VNextStagePlanAdmissionRequest {
  if (!isRecord(value)) fail("request-invalid", "vNext Stage Plan admission request must be an object");
  for (const key of Object.keys(value)) {
    if (!REQUEST_FIELDS.has(key)) fail("request-invalid", "Unknown admission request field " + key);
  }
  if (value.version !== 2 || value.schema_version !== 2 || value.type !== "STAGE_PLAN_ADMISSION") {
    fail("request-invalid", "Only version 2 STAGE_PLAN_ADMISSION requests are accepted");
  }
  if (typeof value.project_root !== "string" || !path.isAbsolute(value.project_root)) fail("request-invalid", "project_root must be an absolute path");
  if (typeof value.manifest_path !== "string" || value.manifest_path.length === 0) fail("request-invalid", "manifest_path must be a non empty path");
  if (typeof value.stage_id !== "string" || !CANONICAL_STAGE_ID_RE.test(value.stage_id)) fail("request-invalid", "stage_id has an invalid canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected");
  if (typeof value.manifest_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.manifest_digest)) fail("request-invalid", "manifest_digest must be a lowercase SHA-256 digest");
  if (typeof value.plan_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.plan_digest)) fail("request-invalid", "plan_digest must be a lowercase SHA-256 digest");
  if (typeof value.snapshot_digest !== "string" || !/^[a-f0-9]{40}$/.test(value.snapshot_digest)) fail("request-invalid", "snapshot_digest must be a canonical Git HEAD digest");
  try { validateVNextSpvPassReceipt(value.spv); }
  catch (error) { fail("spv-invalid", "SPV_PASS authority is invalid: " + (error instanceof Error ? error.message : String(error))); }
  if (value.replan !== undefined) {
    try { validateVNextReplanAdmissionDeclaration(value.replan); }
    catch (error) { fail("replan-invalid", "replan declaration is invalid: " + (error instanceof Error ? error.message : String(error))); }
  }
  return value as unknown as VNextStagePlanAdmissionRequest;
}

function rootBound(root: string, value: string, label: string): string {
  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) fail("root-escape", label + " escapes the project root trust boundary");
  return canonical;
}
function authorityDirectory(root: string, stageId: string): string {
  return path.join(root, ".proofloop", "receipts", "plan", stageId);
}
function writeOnceJson(target: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2) + "\n";
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    throw new VNextStagePlanAdmissionError("write-failed", "vNext authority file could not be written without overwrite: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
function ensureAbsent(target: string): void {
  try { fs.lstatSync(target); fail("already-admitted", "vNext authority target already exists: " + target); }
  catch (error) {
    if (error instanceof VNextStagePlanAdmissionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("write-failed", "vNext authority target cannot be inspected: " + target);
  }
}

/**
 * Shared stable Git boundary gate for Stage Plan admission and Worker dispatch.
 * Bind the final candidate Plan/Evidence boundary to the canonical repository
 * root before authority or Context is consumed. `git status` deliberately uses
 * Git's normal ignore rules: ignored `.proofloop` Runtime artifacts are
 * allowed, while tracked or non-ignored untracked files keep the flow closed.
 */
export function assertStableGitBoundary(root: string, snapshotDigest?: string): string {
  try {
    return assertStableGitBoundaryNeutral(root, snapshotDigest);
  } catch (error) {
    if (error instanceof StableGitBoundaryError) fail(error.code, error.message);
    throw error;
  }
}

function admitValidated(request: VNextStagePlanAdmissionRequest): VNextStagePlanAdmissionSuccess {
  const root = request.project_root;
  let rootStat: fs.Stats;
  try { rootStat = fs.statSync(root); }
  catch { fail("root-escape", "project root is not readable: " + root); }
  if (!rootStat.isDirectory()) fail("root-escape", "project root is not a directory: " + root);
  assertStableGitBoundary(root, request.snapshot_digest);
  const manifestPath = rootBound(root, request.manifest_path, "manifest_path");
  let manifest: VNextManifest;
  try { manifest = readVNextManifest(root, manifestPath); }
  catch (error) {
    if (error instanceof VNextHandoffError) fail("manifest-invalid", error.message);
    fail("manifest-invalid", "vNext Manifest is invalid: " + (error instanceof Error ? error.message : String(error)));
  }
  if (manifest.stage_id !== request.stage_id) fail("manifest-binding", "Manifest stage_id does not match the request stage_id");
  const manifestDigest = computeDigest(manifest);
  if (manifestDigest !== request.manifest_digest) fail("manifest-binding", "manifest_digest does not match the root-bound vNext Manifest");
  if (manifest.plan.plan_digest !== request.plan_digest) fail("manifest-binding", "plan_digest does not match the vNext Manifest plan binding");
  try { assertVNextManifestReferenceBindings(root, manifest); }
  catch (error) { fail("manifest-binding", error instanceof Error ? error.message : String(error)); }

  // S13-S17 remediation Phase 4 (CV repair #7): Stage Plan admission enforces
  // the SAME mechanical Stage Composition Closure Audit before any authority
  // write — a caller-supplied fresh SPV never substitutes for composition
  // closure.  This runs BEFORE ensureAbsent/mkdir/writeOnceJson, so a gap is
  // a zero-write rejection.
  const composition = auditVNextStageComposition(manifest);
  if (!composition.closure_valid) {
    const first = composition.findings[0];
    fail(
      "manifest-invalid",
      `stage composition closure audit failed: ${first.missing_step}: ${first.reason}`,
    );
  }

  let spv: VNextSpvPassReceipt;
  try { spv = validateVNextSpvPassReceipt(request.spv); }
  catch (error) { fail("spv-invalid", error instanceof Error ? error.message : String(error)); }
  if (spv.stage_id !== request.stage_id || spv.manifest_digest !== request.manifest_digest || spv.plan_digest !== request.plan_digest || spv.snapshot_digest !== request.snapshot_digest) {
    fail("spv-binding", "fresh SPV_PASS is not bound to the Stage, Manifest, Plan, and snapshot");
  }

  if (request.replan !== undefined) return admitReplanValidated(request, spv);

  const stagePlanWithoutDigest: Omit<VNextStagePlanReceipt, "digest"> = {
    version: 2,
    schema_version: 2,
    type: "STAGE_PLAN",
    stage_id: request.stage_id,
    manifest_digest: request.manifest_digest,
    plan_digest: request.plan_digest,
    snapshot_digest: request.snapshot_digest,
    spv_receipt_digest: spv.digest,
  };
  const stagePlan: VNextStagePlanReceipt = { ...stagePlanWithoutDigest, digest: computeVNextStagePlanReceiptDigest(stagePlanWithoutDigest) };
  validateVNextStagePlanReceipt(stagePlan);

  const directory = rootBound(root, authorityDirectory(root, request.stage_id), "vNext authority directory");
  const spvPath = rootBound(root, path.join(directory, "vnext-spv-pass.json"), "SPV authority path");
  const stagePlanPath = rootBound(root, path.join(directory, "vnext-stage-plan.json"), "Stage Plan authority path");
  ensureAbsent(spvPath);
  ensureAbsent(stagePlanPath);
  fs.mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  try {
    writeOnceJson(spvPath, spv);
    written.push(spvPath);
    writeOnceJson(stagePlanPath, stagePlan);
    written.push(stagePlanPath);
  } catch (error) {
    for (const target of written.reverse()) { try { fs.unlinkSync(target); } catch { } }
    throw error;
  }
  return {
    accepted: true,
    stage_id: request.stage_id,
    manifest_digest: request.manifest_digest,
    plan_digest: request.plan_digest,
    snapshot_digest: request.snapshot_digest,
    spv_receipt_path: spvPath,
    stage_plan_receipt_path: stagePlanPath,
    spv,
    stage_plan: stagePlan,
  };
}

function mapReplanEpochError(error: unknown): VNextStagePlanAdmissionError["code"] {
  if (error instanceof ReplanEpochError) {
    switch (error.code) {
      case "REPLAN.ROOT_ESCAPE": return "root-escape";
      case "REPLAN.EPOCH_NO_AUTHORITY": return "replan-parent";
      case "REPLAN.EPOCH_CHAIN_BROKEN":
      case "REPLAN.EPOCH_CHAIN_AMBIGUOUS":
      case "REPLAN.EPOCH_ORPHAN":
      case "REPLAN.EPOCH_INVALID":
      case "REPLAN.EPOCH_ALREADY_ADMITTED":
      case "REPLAN.PERSIST_FAILED": return "replan-epoch";
      case "REPLAN.FACT_INVALID":
      case "REPLAN.FACT_MISSING": return "replan-fact";
      case "REPLAN.EPOCH_INPUT_INVALID": return "replan-invalid";
    }
  }
  return "replan-epoch";
}

/**
 * S14-A-T02 — replan Stage Plan admission. The Runtime:
 *  1. reads the current epoch through the validated parent chain and requires
 *     the declared parent_epoch_digest to match it (parent mismatch fails
 *     closed);
 *  2. reads + verifies the digest-addressed Runtime preparation disposition
 *     fact and RECOMPUTES the impact set; caller-forged derived sets fail
 *     closed;
 *  3. derives the epoch digest itself and persists the epoch-qualified
 *     SPV_PASS / STAGE_PLAN authority append-only under
 *     `.proofloop/receipts/plan/<stage>/epochs/<epoch_digest>/` — the initial
 *     canonical receipts are never touched (旧 Receipt 不覆盖).
 */
function admitReplanValidated(request: VNextStagePlanAdmissionRequest, spv: VNextSpvPassReceipt): VNextStagePlanAdmissionSuccess {
  const root = request.project_root;
  const replan = request.replan as VNextReplanAdmissionDeclaration;

  let current: ReplanCurrentEpoch;
  try { current = readCurrentEpoch(root, request.stage_id); }
  catch (error) { fail(mapReplanEpochError(error), "current epoch is unavailable: " + (error instanceof Error ? error.message : String(error))); }
  if (current.epoch_digest !== replan.parent_epoch_digest) {
    fail(
      "replan-parent",
      `replan parent_epoch_digest "${replan.parent_epoch_digest}" does not match the current epoch "${current.epoch_digest}"`,
    );
  }

  let verified: ReturnType<typeof verifyReplanAdmissionFact>;
  try {
    verified = verifyReplanAdmissionFact(
      root,
      replan.disposition_ref,
      replan.disposition_digest,
      {
        stage_id: request.stage_id,
        parent_epoch_digest: replan.parent_epoch_digest,
        manifest_digest: request.manifest_digest,
        plan_digest: request.plan_digest,
        snapshot_digest: request.snapshot_digest,
      },
      request.manifest_path,
    );
  } catch (error) {
    if (error instanceof ReplanEpochError && error.code === "REPLAN.FACT_INVALID" && /unresolved/.test(error.message)) {
      fail("replan-impact", error.message);
    }
    fail(mapReplanEpochError(error), "replan disposition fact verification failed: " + (error instanceof Error ? error.message : String(error)));
  }

  const stagePlanWithoutDigest: Omit<VNextStagePlanReceipt, "digest"> = {
    version: 2,
    schema_version: 2,
    type: "STAGE_PLAN",
    stage_id: request.stage_id,
    manifest_digest: request.manifest_digest,
    plan_digest: request.plan_digest,
    snapshot_digest: request.snapshot_digest,
    spv_receipt_digest: spv.digest,
  };
  const stagePlan: VNextStagePlanReceipt = { ...stagePlanWithoutDigest, digest: computeVNextStagePlanReceiptDigest(stagePlanWithoutDigest) };
  validateVNextStagePlanReceipt(stagePlan);

  const epochDigest = computeReplanEpochDigest({
    stage_id: request.stage_id,
    parent_epoch_digest: replan.parent_epoch_digest,
    disposition_digest: replan.disposition_digest,
    manifest_digest: request.manifest_digest,
    plan_digest: request.plan_digest,
    snapshot_digest: request.snapshot_digest,
  });

  let persisted: ReturnType<typeof persistReplanEpochAuthority>;
  try {
    persisted = persistReplanEpochAuthority({
      root,
      stage_id: request.stage_id,
      epoch_digest: epochDigest,
      parent_epoch_digest: replan.parent_epoch_digest,
      disposition_ref: replan.disposition_ref,
      disposition_digest: replan.disposition_digest,
      manifest_digest: request.manifest_digest,
      plan_digest: request.plan_digest,
      snapshot_digest: request.snapshot_digest,
      spv,
      stage_plan: stagePlan,
    });
  } catch (error) {
    fail(mapReplanEpochError(error), "replan epoch authority could not be persisted: " + (error instanceof Error ? error.message : String(error)));
  }

  return {
    accepted: true,
    stage_id: request.stage_id,
    manifest_digest: request.manifest_digest,
    plan_digest: request.plan_digest,
    snapshot_digest: request.snapshot_digest,
    spv_receipt_path: persisted.spv_receipt_path,
    stage_plan_receipt_path: persisted.stage_plan_receipt_path,
    spv,
    stage_plan: stagePlan,
    replan_epoch_digest: epochDigest,
    epoch_refs_path: persisted.epoch_refs_path,
  };
}

export function admitVNextStagePlan(value: unknown): VNextStagePlanAdmissionResult {
  let stageId = "unknown";
  try {
    if (isRecord(value) && typeof value.stage_id === "string") stageId = value.stage_id;
    const request = validateVNextStagePlanAdmissionRequest(value);
    stageId = request.stage_id;
    return admitValidated(request);
  } catch (error) {
    return {
      accepted: false,
      stage_id: stageId,
      findings: [{ code: "RUNTIME.SCHEMA_MISMATCH", severity: "error", message: error instanceof Error ? error.message : String(error) }],
    };
  }
}
