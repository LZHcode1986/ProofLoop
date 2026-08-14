import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  admitVNextStagePlan,
  computeVNextSpvPassReceiptDigest,
  persistVNextWorkerContext,
  projectVNextWorkerDispatch,
  readVNextAdmissionAuthority,
  resolveVNextReference,
  VNextNextActionService,
} from "@proofloop/runtime";
import type { VNextSpvPassReceipt, VNextStagePlanReceipt } from "@proofloop/runtime";
import { computeDigest, validateVNextSpvPassReceipt, validateVNextStagePlanReceipt } from "@proofloop/kernel";
import { validateVNextStagePlanAdmissionRequest } from "./admission";

const repo = path.resolve(__dirname, "../../../..");
const cleanups: string[] = [];
const DIGEST = "f".repeat(64);

afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-s04-admission-"));
  cleanups.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "vnext-admission@test.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "vNext Admission Test"]);
  execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".proofloop/\n", "utf8");
  const files = [
    ["delivery/stages/S04/tasks.md", "delivery/stages/S04/tasks.md"],
    [".proofloop/manifests/S04.json", ".proofloop/manifests/S04.json"],
    ["delivery/stages/S04/evidence/S04-A.md", "delivery/stages/S04/evidence/S04-A.md"],
    ["delivery/stages/S0-A/tasks.md", "delivery/stages/S0-A/tasks.md"],
  ] as const;
  for (const [source, target] of files) {
    const destination = path.join(root, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repo, source), destination);
  }
  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['delivery/stages/S04/tasks.md'],
        test_paths: ['delivery/stages/S0-A/tasks.md'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(root, "candidate-boundary.txt"), "final candidate boundary\n", "utf8");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "candidate boundary"]);
  return root;
}

function gitHead(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function requestFor(root: string, snapshotDigest = gitHead(root)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".proofloop/manifests/S04.json"), "utf8")) as any;
  const manifestDigest = computeDigest(manifest);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "SPV_PASS" as const,
    stage_id: "S04",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = {
    ...spvContent,
    digest: computeVNextSpvPassReceiptDigest(spvContent),
  };
  return {
    version: 2 as const,
    schema_version: 2 as const,
    type: "STAGE_PLAN_ADMISSION" as const,
    project_root: root,
    manifest_path: ".proofloop/manifests/S04.json",
    stage_id: "S04",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    spv,
  };
}

function findingsOf(result: ReturnType<typeof admitVNextStagePlan>) {
  if (result.accepted) throw new Error("expected vNext admission to fail");
  return result.findings;
}

describe("vNext Stage Plan admission seam", () => {
  it("requires a clean HEAD-bound admission, then dispatches one task without a second SPV", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    const before = new VNextNextActionService().nextAction({ projectRoot: root, stageId: "S04", snapshotDigest: gitHead(root) });
    expect(before.action).toBe("VALIDATE");
    expect(before.findings[0]?.message).toMatch(/admission authority/);
    expect(admitVNextStagePlan(request).accepted).toBe(true);
    const after = new VNextNextActionService().nextAction({ projectRoot: root, stageId: "S04", snapshotDigest: gitHead(root), persistContext: true });
    expect(after.action).toBe("DISPATCH_WORKER");
    expect(after.stage_id).toBe("S04");
    expect(after.slice_id).toBe("S04-A");
    expect(after.task_id).toBe("S04-A-T01");
    expect(after.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    expect(after.manifest_digest).toBe(request.manifest_digest);
    expect(after.plan_digest).toBe(request.plan_digest);
    expect(after.proof_index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(after.snapshot_digest).toBe(gitHead(root));
    const context = fs.readFileSync(path.join(root, after.context_ref as string), "utf8");
    expect(context).not.toContain("Stage Goal");
    expect(context).not.toContain("Worker Evidence");
    expect(context).toContain("S04-A-T01");
  });

  it("fails closed on a later real HEAD change instead of auto re-SPV", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    expect(admitVNextStagePlan(request).accepted).toBe(true);
    fs.appendFileSync(path.join(root, "candidate-boundary.txt"), "later committed change\n", "utf8");
    execFileSync("git", ["-C", root, "add", "candidate-boundary.txt"]);
    execFileSync("git", ["-C", root, "commit", "-q", "-m", "later boundary"]);

    const after = new VNextNextActionService().nextAction({ projectRoot: root, stageId: "S04" });
    expect(after.action).toBe("VALIDATE");
    expect(after.findings[0]?.message).toMatch(/snapshot|digest|bind/);
  });

  it("blocks Worker dispatch after admission when a tracked file becomes dirty", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    expect(admitVNextStagePlan(request).accepted).toBe(true);
    fs.appendFileSync(path.join(root, "candidate-boundary.txt"), "post-admission tracked edit\n", "utf8");

    const result = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: "S04",
      snapshotDigest: gitHead(root),
      persistContext: true,
    });
    expect(result.action).toBe("VALIDATE");
    expect(result.findings[0]).toMatchObject({ code: "RUNTIME.SCHEMA_MISMATCH", severity: "error" });
    expect(result.findings[0]?.message).toMatch(/clean.*worktree|dirty/);
    expect(fs.existsSync(path.join(root, ".proofloop/context"))).toBe(false);
  });

  it("blocks Worker dispatch after admission when a non-ignored untracked file appears", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    expect(admitVNextStagePlan(request).accepted).toBe(true);
    fs.writeFileSync(path.join(root, "post-admission-untracked.txt"), "untracked edit\n", "utf8");

    const result = new VNextNextActionService().nextAction({
      projectRoot: root,
      stageId: "S04",
      snapshotDigest: gitHead(root),
      persistContext: true,
    });
    expect(result.action).toBe("VALIDATE");
    expect(result.findings[0]).toMatchObject({ code: "RUNTIME.SCHEMA_MISMATCH", severity: "error" });
    expect(result.findings[0]?.message).toMatch(/clean.*worktree|dirty/);
    expect(fs.existsSync(path.join(root, ".proofloop/context"))).toBe(false);
  });

  it("fails closed when request snapshot_digest does not match the current Git HEAD", () => {
    const root = fixtureRoot();
    const request = requestFor(root, "0".repeat(40));
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]).toMatchObject({
      code: "RUNTIME.SCHEMA_MISMATCH",
      severity: "error",
    });
    expect(findingsOf(result)[0]?.message).toMatch(/snapshot_digest.*HEAD|HEAD.*snapshot_digest/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("fails closed on a dirty tracked worktree", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    fs.appendFileSync(path.join(root, "candidate-boundary.txt"), "tracked edit\n", "utf8");
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]).toMatchObject({
      code: "RUNTIME.SCHEMA_MISMATCH",
      severity: "error",
    });
    expect(findingsOf(result)[0]?.message).toMatch(/clean.*worktree|dirty/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("fails closed on a dirty untracked worktree", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    fs.writeFileSync(path.join(root, "untracked-boundary.txt"), "untracked edit\n", "utf8");
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]).toMatchObject({
      code: "RUNTIME.SCHEMA_MISMATCH",
      severity: "error",
    });
    expect(findingsOf(result)[0]?.message).toMatch(/clean.*worktree|dirty/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("rejects a digest or root path mismatch without writing authority", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    const badDigest = { ...request, manifest_digest: DIGEST, spv: { ...request.spv, manifest_digest: DIGEST } };
    expect(admitVNextStagePlan(badDigest).accepted).toBe(false);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
    const badPath = { ...request, manifest_path: "../outside.json" };
    expect(admitVNextStagePlan(badPath).accepted).toBe(false);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("is write-once and refuses an existing different Stage Plan authority", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    const first = admitVNextStagePlan(request);
    expect(first.accepted).toBe(true);
    const target = path.join(root, ".proofloop/receipts/plan/S04/vnext-stage-plan.json");
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, "tampered\n", "utf8");
    const second = admitVNextStagePlan(request);
    expect(second.accepted).toBe(false);
    expect(fs.readFileSync(target, "utf8")).toBe("tampered\n");
    expect(original).not.toBe("tampered\n");
  });

  it("refuses v1 and unsupported admission requests fail closed", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    expect(admitVNextStagePlan({ ...request, version: 1 })).toMatchObject({ accepted: false });
    expect(admitVNextStagePlan({ ...request, type: "stage_plan" })).toMatchObject({ accepted: false });
  });

  it("keeps Plan reference file and section digests stable when the checkbox changes", () => {
    const root = fixtureRoot();
    const tasks = path.join(root, "delivery/stages/S04/tasks.md");
    const before = resolveVNextReference({ root, ref: "delivery/stages/S04/tasks.md#/entities/S04-A-T01", expectedKind: "task" });
    fs.writeFileSync(tasks, fs.readFileSync(tasks, "utf8").replace("- [ ] S04-A-T01", "- [x] S04-A-T01"), "utf8");
    const after = resolveVNextReference({ root, ref: "delivery/stages/S04/tasks.md#/entities/S04-A-T01", expectedKind: "task" });
    expect(after.fileDigest).toBe(before.fileDigest);
    expect(after.sectionDigest).toBe(before.sectionDigest);
  });

  it("rejects a different existing ContextRef content and an escaped ContextRef", () => {
    const root = fixtureRoot();
    const request = requestFor(root);
    expect(admitVNextStagePlan(request).accepted).toBe(true);
    const authority = readVNextAdmissionAuthority(root, "S04");
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ".proofloop/manifests/S04.json"), "utf8"));
    const dispatch = projectVNextWorkerDispatch({ root, manifest, manifestDigest: request.manifest_digest, snapshotDigest: gitHead(root), authority });
    persistVNextWorkerContext(root, dispatch);
    const contextPath = path.join(root, dispatch.context_ref);
    fs.writeFileSync(contextPath, "different\n", "utf8");
    expect(() => persistVNextWorkerContext(root, dispatch)).toThrow(/does not match/);
    expect(() => persistVNextWorkerContext(root, { ...dispatch, context_ref: "../outside.json" } as any)).toThrow(/escapes/);
  });
});

/**
 * Rebind every Manifest reference to the fixture's copied authority files.
 * The archived S08 Manifest records compile-time (2026-08-05) file/section
 * digests, but the fixture mirrors the CURRENT repo files, so admission
 * would fail closed on digest mismatch. Recompute both digests per
 * reference against the fixture root with the same resolver the compiler
 * uses — the fixture keeps its "real S08 candidate shape" while staying
 * self-consistent (the archived repo Manifest is never touched).
 */
function rebindS08ReferenceDigests(root: string): void {
  const manifestPath = path.join(root, ".proofloop/manifests/S08.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, any>;
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

/** S08 real-file fixture: the current Stage Plan candidate, its Manifest,
 *  every S08 Evidence skeleton, the S0-A foundation Plan and every tech-spec
 *  authority referenced by the S08 reference index. */
function s08FixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-s08-admission-"));
  cleanups.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "vnext-s08-admission@test.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "vNext S08 Admission Test"]);
  execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".proofloop/\n", "utf8");
  const files = [
    ["delivery/stages/S08/tasks.md", "delivery/stages/S08/tasks.md"],
    [".proofloop/manifests/S08.json", ".proofloop/manifests/S08.json"],
    ["delivery/stages/S08/evidence/S08-A.md", "delivery/stages/S08/evidence/S08-A.md"],
    ["delivery/stages/S08/evidence/S08-B.md", "delivery/stages/S08/evidence/S08-B.md"],
    ["delivery/stages/S08/evidence/S08-C.md", "delivery/stages/S08/evidence/S08-C.md"],
    ["delivery/stages/S08/evidence/S08-D.md", "delivery/stages/S08/evidence/S08-D.md"],
    ["delivery/stages/S08/evidence/S08-E.md", "delivery/stages/S08/evidence/S08-E.md"],
    ["delivery/stages/S0-A/tasks.md", "delivery/stages/S0-A/tasks.md"],
    ["tech-spec/task-acceptance-matrix.md", "tech-spec/task-acceptance-matrix.md"],
    ["tech-spec/contract-state-matrix.md", "tech-spec/contract-state-matrix.md"],
    ["tech-spec/ai-coding-architecture.md", "tech-spec/ai-coding-architecture.md"],
    ["tech-spec/hard-parts-register.md", "tech-spec/hard-parts-register.md"],
  ] as const;
  for (const [source, target] of files) {
    const destination = path.join(root, target);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(repo, source), destination);
  }
  rebindS08ReferenceDigests(root);
  fs.writeFileSync(path.join(root, "candidate-boundary.txt"), "final candidate boundary\n", "utf8");
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "S08 candidate boundary"]);
  return root;
}

function s08RequestFor(root: string, snapshotDigest = gitHead(root)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".proofloop/manifests/S08.json"), "utf8")) as any;
  const manifestDigest = computeDigest(manifest);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "SPV_PASS" as const,
    stage_id: "S08",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = {
    ...spvContent,
    digest: computeVNextSpvPassReceiptDigest(spvContent),
  };
  return {
    version: 2 as const,
    schema_version: 2 as const,
    type: "STAGE_PLAN_ADMISSION" as const,
    project_root: root,
    manifest_path: ".proofloop/manifests/S08.json",
    stage_id: "S08",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    spv,
  };
}

/** Rebuild a fresh SPV fact with canonical self digest from content
 *  overrides, so a tuple-mismatch test exercises exactly the one binding it
 *  names instead of failing on the self-digest check. */
function s08Spv(root: string, snapshotDigest: string, overrides: Record<string, unknown> = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".proofloop/manifests/S08.json"), "utf8")) as any;
  const content = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "SPV_PASS" as const,
    stage_id: "S08",
    manifest_digest: computeDigest(manifest),
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    ...overrides,
  };
  return { ...content, digest: computeVNextSpvPassReceiptDigest(content) };
}

describe("vNext S08 Stage Plan admission digest tuple binding (S08-B-T02)", () => {
  it("binds Stage: a request stage_id that does not match the Manifest is rejected without authority", () => {
    const root = s08FixtureRoot();
    const request = s08RequestFor(root);
    const mismatched = { ...request, stage_id: "S07", spv: s08Spv(root, gitHead(root), { stage_id: "S07" }) };
    const result = admitVNextStagePlan(mismatched);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/stage_id/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("binds Plan: a plan_digest that does not match the Manifest plan binding is rejected without authority", () => {
    const root = s08FixtureRoot();
    const request = s08RequestFor(root);
    const other = "f".repeat(64);
    const mismatched = { ...request, plan_digest: other, spv: s08Spv(root, gitHead(root), { plan_digest: other }) };
    const result = admitVNextStagePlan(mismatched);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/plan_digest/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("binds snapshot: a snapshot_digest that is not the current Git HEAD is rejected without authority", () => {
    const root = s08FixtureRoot();
    const stale = "0".repeat(40);
    const result = admitVNextStagePlan(s08RequestFor(root, stale));
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/snapshot_digest/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("binds fresh SPV: a Stage-mismatched SPV is rejected", () => {
    const root = s08FixtureRoot();
    const request = { ...s08RequestFor(root), spv: s08Spv(root, gitHead(root), { stage_id: "S07" }) };
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/SPV_PASS is not bound/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("binds fresh SPV: a Plan-mismatched SPV is rejected", () => {
    const root = s08FixtureRoot();
    const request = { ...s08RequestFor(root), spv: s08Spv(root, gitHead(root), { plan_digest: "f".repeat(64) }) };
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/SPV_PASS is not bound/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("binds fresh SPV: a snapshot-mismatched SPV is rejected", () => {
    const root = s08FixtureRoot();
    const request = { ...s08RequestFor(root), spv: s08Spv(root, "0".repeat(40)) };
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/SPV_PASS is not bound/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("rejects a fresh SPV whose self digest is tampered", () => {
    const root = s08FixtureRoot();
    const request = { ...s08RequestFor(root), spv: { ...s08RequestFor(root).spv, digest: "f".repeat(64) } };
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/SPV_PASS authority is invalid/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("requires a canonical Git HEAD snapshot_digest in the admission request", () => {
    const root = s08FixtureRoot();
    const garbage = "not-a-git-snapshot";
    const request = { ...s08RequestFor(root), snapshot_digest: garbage, spv: s08Spv(root, garbage) };
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(findingsOf(result)[0]?.message).toMatch(/snapshot_digest must be a canonical Git HEAD digest/);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });
});

describe("vNext S08 Stage Plan admission seam (real S08 candidate files)", () => {
  it("admits the real S08 candidate at a clean HEAD and writes readback-valid write-once authority receipts", () => {
    const root = s08FixtureRoot();
    const request = s08RequestFor(root);
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.stage_id).toBe("S08");
    expect(result.manifest_digest).toBe(request.manifest_digest);
    expect(result.plan_digest).toBe(request.plan_digest);
    expect(result.snapshot_digest).toBe(gitHead(root));
    // Receipt ref/digest readback: the persisted authority files must
    // validate through the kernel and carry the exact returned digests.
    const spvReadback = JSON.parse(fs.readFileSync(result.spv_receipt_path, "utf8"));
    const stagePlanReadback = JSON.parse(fs.readFileSync(result.stage_plan_receipt_path, "utf8"));
    expect(validateVNextSpvPassReceipt(spvReadback)).toEqual(result.spv);
    const stagePlanValidated = validateVNextStagePlanReceipt(stagePlanReadback) as VNextStagePlanReceipt;
    expect(stagePlanValidated).toEqual(result.stage_plan);
    expect(stagePlanReadback.spv_receipt_digest).toBe(spvReadback.digest);
    // Write-once: a second admission of the identical request must fail
    // closed without replacing the persisted authority.
    expect(admitVNextStagePlan(request).accepted).toBe(false);
    expect(fs.readFileSync(result.spv_receipt_path, "utf8")).toBe(JSON.stringify(result.spv, null, 2) + "\n");
    expect(fs.readFileSync(result.stage_plan_receipt_path, "utf8")).toBe(JSON.stringify(result.stage_plan, null, 2) + "\n");
  });

  it("keeps the readback authority kernel-valid and bound to the request tuple", () => {
    const root = s08FixtureRoot();
    const request = s08RequestFor(root);
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    const spvReadback = JSON.parse(fs.readFileSync(result.spv_receipt_path, "utf8"));
    const stagePlanReadback = JSON.parse(fs.readFileSync(result.stage_plan_receipt_path, "utf8"));
    expect(spvReadback).toMatchObject({
      version: 2,
      schema_version: 2,
      type: "SPV_PASS",
      stage_id: "S08",
      manifest_digest: request.manifest_digest,
      plan_digest: request.plan_digest,
      snapshot_digest: request.snapshot_digest,
    });
    expect(stagePlanReadback).toMatchObject({
      version: 2,
      schema_version: 2,
      type: "STAGE_PLAN",
      stage_id: "S08",
      manifest_digest: request.manifest_digest,
      plan_digest: request.plan_digest,
      snapshot_digest: request.snapshot_digest,
      spv_receipt_digest: spvReadback.digest,
    });
  });

  it("fails closed on a missing admission input field without writing authority", () => {
    const root = s08FixtureRoot();
    const request = s08RequestFor(root);
    const missingSpv = { ...request, spv: undefined };
    expect(admitVNextStagePlan(missingSpv).accepted).toBe(false);
    const missingDigest = { ...request, manifest_digest: undefined };
    expect(admitVNextStagePlan(missingDigest).accepted).toBe(false);
    const missingSnapshot = { ...request, snapshot_digest: undefined };
    expect(admitVNextStagePlan(missingSnapshot).accepted).toBe(false);
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });

  it("refuses stale snapshot admission on the real S08 candidate and keeps no admission", () => {
    const root = s08FixtureRoot();
    const request = s08RequestFor(root, "0".repeat(40));
    const result = admitVNextStagePlan(request);
    expect(result.accepted).toBe(false);
    expect(result.stage_id).toBe("S08");
    expect(fs.existsSync(path.join(root, ".proofloop/receipts"))).toBe(false);
  });
});

describe('S09-C-T03 — Stage Plan admission rejects legacy stage labels before any read/write', () => {
  it('rejects an admission request whose stage_id is the parked S08B0 label', () => {
    const root = fixtureRoot();
    const request = { ...requestFor(root), stage_id: 'S08B0' };
    expect(() => validateVNextStagePlanAdmissionRequest(request)).toThrowError(/stage_id/);
  });

  it('rejects an admission request whose stage_id is the parked S08B label', () => {
    const root = fixtureRoot();
    const request = { ...requestFor(root), stage_id: 'S08B' };
    expect(() => validateVNextStagePlanAdmissionRequest(request)).toThrowError(/stage_id/);
  });
});
