/**
 * Explicit vNext Stage Plan admission CLI.
 *
 * The CLI main entry (`admitVNextStagePlanCli`, run when this file is invoked
 * directly) admits v2 `STAGE_PLAN_ADMISSION` requests via `admitVNextStagePlan`
 * from `../vnext`.  The `SPV_ADMISSION` validator/seam further below
 * (`validateSpvRequest` / `admitVNextSpvPass`) is a SEPARATE, independent SPV
 * admission seam — it is NOT this CLI's main entry and it never writes a Stage
 * Plan fact (P-05).
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { admitVNextStagePlan } from "../vnext";

const USAGE = [
  "Usage: node dist/cli/admit-vnext-stage-plan.js <request.json>",
  "       node dist/cli/admit-vnext-stage-plan.js --json '<request>'",
  "",
  "The request must be a v2 STAGE_PLAN_ADMISSION object (version: 2, schema_version: 2):",
  "",
  "Required request fields:",
  "  type             = \"STAGE_PLAN_ADMISSION\"",
  "  project_root     absolute project root path (trust boundary)",
  "  manifest_path    root-relative path to the vNext Manifest (REQUIRED)",
  "  stage_id         canonical Stage ID (e.g. \"S09\")",
  "  manifest_digest  lowercase SHA-256 (64 hex) of the vNext Manifest",
  "  plan_digest      lowercase SHA-256 (64 hex) of the bound Plan",
  "  snapshot_digest  canonical Git HEAD digest (40 hex)",
  "  spv              SPV_PASS authority object (see below)",
  "",
  "spv sub-object fields:",
  "  version           = 2",
  "  schema_version    = 2",
  "  type              = \"SPV_PASS\"",
  "  stage_id          same as request stage_id",
  "  manifest_digest   same as request manifest_digest",
  "  plan_digest       same as request plan_digest",
  "  snapshot_digest   same as request snapshot_digest",
  "  digest            = computeDigest of the spv object WITHOUT its digest field",
  "",
  "Examples:",
  "  node dist/cli/admit-vnext-stage-plan.js request.json",
  "  node dist/cli/admit-vnext-stage-plan.js --json '<request>'",
].join("\n");

function readArg(argv: readonly string[]): string {
  const [first, second] = argv;
  if (first === "--json") return second ?? "";
  if (first !== undefined) return fs.readFileSync(first, "utf8");
  return "";
}

export function admitVNextStagePlanCli(argv: readonly string[]): number {
  let raw: string;
  try { raw = readArg(argv); }
  catch (error) {
    console.log(JSON.stringify({ accepted: false, findings: [{ code: "RUNTIME.SCHEMA_MISMATCH", severity: "error", message: "Cannot read admission request: " + (error instanceof Error ? error.message : String(error)) }] }));
    return 1;
  }
  if (!raw) {
    console.log(JSON.stringify({ accepted: false, findings: [{ code: "RUNTIME.SCHEMA_MISMATCH", severity: "error", message: USAGE }] }));
    return 1;
  }
  try {
    const request = JSON.parse(raw) as Record<string, unknown>;
    const assertedRoot = argv[0] === "--json" ? argv[2] : argv[1];
    if (assertedRoot !== undefined && typeof request.project_root === "string" && path.resolve(assertedRoot) !== path.resolve(request.project_root)) {
      console.log(JSON.stringify({ accepted: false, findings: [{ code: "HOST.PROJECT_NOT_TRUSTED", severity: "error", message: "project root assertion does not match the request root" }] }));
      return 1;
    }
    const result = admitVNextStagePlan(request);
    console.log(JSON.stringify(result, null, 2));
    return result.accepted ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ accepted: false, findings: [{ code: "RUNTIME.SCHEMA_MISMATCH", severity: "error", message: "Invalid admission JSON: " + (error instanceof Error ? error.message : String(error)) }] }));
    return 1;
  }
}

if (require.main === module) process.exitCode = admitVNextStagePlanCli(process.argv.slice(2));

// ===========================================================================
// S10-B-T02 repair — independent SPV admission seam (authority §1.1:
// `admit_spv_result` is Runtime SPV admission and is NOT equivalent to Stage
// Plan admission).  This seam writes ONLY the SPV_PASS authority
// (`vnext-spv-pass.json`) write-once through the Runtime-owned receipt area;
// it never writes a Stage Plan fact.
//
// P-05: this seam is NOT the CLI main entry.  `admitVNextStagePlanCli` (the
// `require.main` entry above) accepts `STAGE_PLAN_ADMISSION` requests via
// `admitVNextStagePlan`; `admitVNextSpvPass` here is a separate seam whose
// request type is `SPV_ADMISSION`, consumed by
// `packages/runtime/src/cli/proofloop-plan.ts` (`plan admit-spv`).
// ===========================================================================

import { computeDigest, validateVNextSpvPassReceipt } from "@proofloop/kernel";
import type { VNextSpvPassReceipt } from "@proofloop/kernel";
import { readGitHead, resolveGitRoot } from "../git-source";
import { canonicalPathWithinRoot, openNoFollowRead } from "../path-guard";
import { readVNextManifest, assertCanonicalStageId } from "../vnext";

export interface VNextSpvPassAdmissionRequest {
  readonly version: 2;
  readonly schema_version: 2;
  readonly type: "SPV_ADMISSION";
  readonly project_root: string;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  readonly spv: VNextSpvPassReceipt;
}

export interface VNextSpvPassAdmissionSuccess {
  readonly accepted: true;
  readonly stage_id: string;
  readonly spv_receipt_path: string;
  readonly spv: VNextSpvPassReceipt;
}

export interface VNextSpvPassAdmissionFailure {
  readonly accepted: false;
  readonly stage_id: string;
  readonly findings: readonly [{
    readonly code: "RUNTIME.SCHEMA_MISMATCH";
    readonly severity: "error";
    readonly message: string;
  }];
}

export type VNextSpvPassAdmissionResult =
  | VNextSpvPassAdmissionSuccess
  | VNextSpvPassAdmissionFailure;

export class VNextSpvPassAdmissionError extends Error {
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
    | "write-failed";

  constructor(code: VNextSpvPassAdmissionError["code"], message: string) {
    super(message);
    this.name = "VNextSpvPassAdmissionError";
    this.code = code;
  }
}

const SPV_REQUEST_FIELDS = new Set([
  "version", "schema_version", "type", "project_root", "stage_id",
  "manifest_digest", "plan_digest", "snapshot_digest", "spv",
]);

function spvIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function spvFail(code: VNextSpvPassAdmissionError["code"], message: string): never {
  throw new VNextSpvPassAdmissionError(code, message);
}

function spvRootBound(root: string, value: string, label: string): string {
  const canonical = canonicalPathWithinRoot(root, value);
  if (canonical === null) spvFail("root-escape", label + " escapes the project root trust boundary");
  return canonical;
}

/**
 * Validate an `SPV_ADMISSION` request for the independent SPV admission seam
 * (`admitVNextSpvPass`).  This is NOT the stage-plan admission validator: the
 * CLI main entry `admitVNextStagePlanCli` accepts `STAGE_PLAN_ADMISSION`
 * requests via `admitVNextStagePlan` (P-05).
 */
function validateSpvRequest(value: unknown): VNextSpvPassAdmissionRequest {
  if (!spvIsRecord(value)) spvFail("request-invalid", "SPV admission request must be an object");
  for (const key of Object.keys(value)) {
    if (!SPV_REQUEST_FIELDS.has(key)) spvFail("request-invalid", "Unknown SPV admission request field " + key);
  }
  if (value.version !== 2 || value.schema_version !== 2 || value.type !== "SPV_ADMISSION") {
    spvFail("request-invalid", "Only version 2 SPV_ADMISSION requests are accepted");
  }
  if (typeof value.project_root !== "string" || !path.isAbsolute(value.project_root)) {
    spvFail("request-invalid", "project_root must be an absolute path");
  }
  assertCanonicalStageId(value.stage_id as string, "stage_id");
  if (typeof value.manifest_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.manifest_digest)) {
    spvFail("request-invalid", "manifest_digest must be a lowercase SHA-256 digest");
  }
  if (typeof value.plan_digest !== "string" || !/^[a-f0-9]{64}$/.test(value.plan_digest)) {
    spvFail("request-invalid", "plan_digest must be a lowercase SHA-256 digest");
  }
  if (typeof value.snapshot_digest !== "string" || !/^[a-f0-9]{40}$/.test(value.snapshot_digest)) {
    spvFail("request-invalid", "snapshot_digest must be a canonical Git HEAD digest");
  }
  let spv: VNextSpvPassReceipt;
  try {
    spv = validateVNextSpvPassReceipt(value.spv);
  } catch (error) {
    spvFail("spv-invalid", "SPV_PASS authority is invalid: " + (error instanceof Error ? error.message : String(error)));
  }
  return value as unknown as VNextSpvPassAdmissionRequest;
}

/**
 * Admit ONLY the fresh SPV_PASS authority for a Stage.  Bindings revalidated
 * against the root-bound Manifest and the current Git HEAD (fresh SPV), then
 * the SPV fact is written write-once to
 * `.proofloop/receipts/plan/<stage>/vnext-spv-pass.json`; an existing file
 * with identical content is idempotent, any other existing content fails
 * closed (already-admitted).
 *
 * Independent SPV admission seam (P-05): request type is `SPV_ADMISSION`;
 * this is NOT the stage-plan admission main entry (`admitVNextStagePlanCli`
 * accepts `STAGE_PLAN_ADMISSION`).
 */
export function admitVNextSpvPass(value: unknown): VNextSpvPassAdmissionResult {
  let stageId = "unknown";
  try {
    const request = validateSpvRequest(value);
    stageId = request.stage_id;
    const root = spvRootBound(request.project_root, request.project_root, "project_root");
    const spv = request.spv;

    // Manifest binding: the admitted v2 Manifest must exist and bind the
    // request digest tuple.
    let manifest: Record<string, unknown>;
    try {
      manifest = readVNextManifest(root, `.proofloop/manifests/${stageId}.json`) as unknown as Record<string, unknown>;
    } catch (error) {
      spvFail("manifest-invalid", "vNext Manifest is invalid or missing: " + (error instanceof Error ? error.message : String(error)));
    }
    if (manifest.stage_id !== stageId) spvFail("manifest-binding", "Manifest stage_id does not match the request stage_id");
    const manifestDigest = computeDigest(manifest);
    if (manifestDigest !== request.manifest_digest) spvFail("manifest-binding", "manifest_digest does not match the root-bound vNext Manifest");
    if ((manifest.plan as { plan_digest: string }).plan_digest !== request.plan_digest) {
      spvFail("manifest-binding", "plan_digest does not match the vNext Manifest plan binding");
    }

    // SPV binding: the SPV_PASS fact must bind the same Stage/Manifest/Plan/snapshot.
    if (
      spv.stage_id !== stageId ||
      spv.manifest_digest !== request.manifest_digest ||
      spv.plan_digest !== request.plan_digest ||
      spv.snapshot_digest !== request.snapshot_digest
    ) {
      spvFail("spv-binding", "fresh SPV_PASS is not bound to the Stage, Manifest, Plan, and snapshot");
    }

    // Fresh-SPV Git gate: current HEAD must equal the admitted snapshot and
    // the worktree must be clean (same boundary rule as Stage Plan admission).
    let gitRoot: string;
    try {
      gitRoot = resolveGitRoot(root);
    } catch (error) {
      spvFail("git-unavailable", "canonical Git project root is unavailable: " + (error instanceof Error ? error.message : String(error)));
    }
    let head: string;
    try {
      head = readGitHead(gitRoot);
    } catch (error) {
      spvFail("git-unavailable", "current Git HEAD is unavailable: " + (error instanceof Error ? error.message : String(error)));
    }
    if (head !== request.snapshot_digest) {
      spvFail("snapshot-binding", `SPV snapshot_digest "${request.snapshot_digest}" does not match current Git HEAD "${head}", fresh SPV is required`);
    }
    let porcelain: string;
    try {
      porcelain = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: gitRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      spvFail("git-unavailable", "current Git worktree status is unavailable");
    }
    if (porcelain.trim().length > 0) {
      spvFail("worktree-dirty", "SPV admission requires a clean Git worktree at the canonical project root");
    }

    // Write-once persistence of the SPV authority only.
    const directory = spvRootBound(root, path.join(root, ".proofloop", "receipts", "plan", stageId), "SPV authority directory");
    const spvPath = spvRootBound(root, path.join(directory, "vnext-spv-pass.json"), "SPV authority path");
    const payload = JSON.stringify(spv, null, 2) + "\n";
    try {
      fs.lstatSync(spvPath);
      spvFail("already-admitted", "SPV authority already exists (write-once): " + spvPath);
    } catch (error) {
      if (error instanceof VNextSpvPassAdmissionError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        spvFail("write-failed", "SPV authority target cannot be inspected: " + (error instanceof Error ? error.message : String(error)));
      }
    }
    fs.mkdirSync(directory, { recursive: true });
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    let fd: number | undefined;
    try {
      fd = fs.openSync(spvPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
    } catch (error) {
      spvFail("write-failed", "SPV authority could not be written without overwrite: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return {
      accepted: true,
      stage_id: stageId,
      spv_receipt_path: spvPath,
      spv,
    };
  } catch (error) {
    return {
      accepted: false,
      stage_id: stageId,
      findings: [{
        code: "RUNTIME.SCHEMA_MISMATCH",
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}
