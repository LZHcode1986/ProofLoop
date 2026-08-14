import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { computeDigest, computeVNextSpvPassReceiptDigest, computeVNextStagePlanReceiptDigest } from "@proofloop/kernel";
import { admitVNextStagePlan, resolveVNextReference } from "../vnext";
import {
  VNEXT_CONTEXT_ROLES,
  isVNextContextRole,
  projectVNextRefutationObservation,
  projectVNextRoleContext,
  verifyVNextRefutationObservationBinding,
} from "../vnext";
import type { VNextNextActionOutput } from "../vnext";
import { nextActionFromInput } from "./next-action";

const repo = path.resolve(__dirname, "../../../..");
const cleanups: string[] = [];
afterEach(() => { for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-cli-next-"));
  cleanups.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "vnext-cli@test.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "vNext CLI Test"]);
  execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".proofloop/\n", "utf8");
  for (const pair of [
    ["delivery/stages/S04/tasks.md", "delivery/stages/S04/tasks.md"],
    [".proofloop/manifests/S04.json", ".proofloop/manifests/S04.json"],
    ["delivery/stages/S04/evidence/S04-A.md", "delivery/stages/S04/evidence/S04-A.md"],
    ["delivery/stages/S0-A/tasks.md", "delivery/stages/S0-A/tasks.md"],
  ] as const) {
    const target = path.join(root, pair[1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, pair[0]), target);
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
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "candidate boundary"]);
  return root;
}

function admit(root: string): void {
  const snapshotDigest = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".proofloop/manifests/S04.json"), "utf8")) as any;
  const manifestDigest = computeDigest(manifest);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "SPV_PASS" as const,
    stage_id: "S04",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
  };
  const request = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "STAGE_PLAN_ADMISSION" as const,
    project_root: root,
    manifest_path: ".proofloop/manifests/S04.json",
    stage_id: "S04",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    spv: { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) },
  };
  const result = admitVNextStagePlan(request);
  if (!result.accepted) throw new Error(result.findings[0].message);
}

describe("canonical next-action vNext routing", () => {
  it("routes an explicit malformed v2 Manifest to the vNext bounded failure and not v1", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-cli-malformed-"));
    cleanups.push(root);
    const manifest = path.join(root, ".proofloop/manifests/S04.json");
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ version: 2, plan: { schema_version: 2 } }), "utf8");
    const output = nextActionFromInput({ project_root: root, stage_id: "S04", manifest_path: manifest });
    expect(output.action).toBe("VALIDATE");
    expect(output.action_detail).toMatch(/vNext/);
    expect(output.findings[0]?.message).toMatch(/vNext Manifest/);
  });

  it("routes the admitted S04 v2 Manifest through the canonical CLI consumer", () => {
    const root = fixture();
    admit(root);
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S04",
      manifest_path: ".proofloop/manifests/S04.json",
    snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    const v2 = output as VNextNextActionOutput;
    expect(v2.action).toBe("DISPATCH_WORKER");
    expect(v2.responsible_role).toBe("worker");
    expect(v2.stage_id).toBe("S04");
    expect(v2.slice_id).toBe("S04-A");
    expect(v2.task_id).toBe("S04-A-T01");
    expect(v2.context_ref).toBeDefined();
    expect(v2.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.plan_digest).toBeDefined();
    expect(v2.proof_index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.snapshot_digest).toMatch(/^[a-f0-9]{40}$/);
  });

  it("fails closed on a non-canonical stage label before reading the Manifest or Authority", () => {
    // S09-REVIEW-001: the vNext next consumer must apply the canonical Stage
    // ID guard at its earliest entry (before any Manifest/Authority read), so
    // the parked S08B0/S08B labels can never reach a dispatch projection.
    for (const forgedStage of ['S08B0', 'S08B']) {
      const root = fixture();
      const forgedPath = path.join(root, `.proofloop/manifests/${forgedStage}.json`);
      fs.copyFileSync(path.join(root, '.proofloop/manifests/S04.json'), forgedPath);
      const output = nextActionFromInput({
        project_root: root,
        stage_id: forgedStage,
        manifest_path: `.proofloop/manifests/${forgedStage}.json`,
      });
      expect(output.action).toBe('VALIDATE');
      expect(output.findings[0]?.message).toMatch(/canonical Stage ID/);
      expect(fs.existsSync(path.join(root, '.proofloop/context'))).toBe(false);
    }
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

/** S08 real-file fixture mirroring the admitted S08 candidate boundary. */
function s08Fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnext-cli-next-s08-"));
  cleanups.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "vnext-cli-s08@test.local"]);
  execFileSync("git", ["-C", root, "config", "user.name", "vNext CLI S08 Test"]);
  execFileSync("git", ["-C", root, "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".proofloop/\n", "utf8");
  for (const pair of [
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
  ] as const) {
    const target = path.join(root, pair[1]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, pair[0]), target);
  }
  rebindS08ReferenceDigests(root);
  execFileSync("git", ["-C", root, "add", "-A"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "S08 candidate boundary"]);
  return root;
}

function s08Admit(root: string): void {
  const snapshotDigest = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, ".proofloop/manifests/S08.json"), "utf8")) as any;
  const manifestDigest = computeDigest(manifest);
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "SPV_PASS" as const,
    stage_id: "S08",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
  };
  const request = {
    version: 2 as const,
    schema_version: 2 as const,
    type: "STAGE_PLAN_ADMISSION" as const,
    project_root: root,
    manifest_path: ".proofloop/manifests/S08.json",
    stage_id: "S08",
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest as string,
    snapshot_digest: snapshotDigest,
    spv: { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) },
  };
  const result = admitVNextStagePlan(request);
  if (!result.accepted) throw new Error(result.findings[0].message);
}

describe("canonical next-action vNext routing on the real S08 candidate", () => {
  it("routes an unadmitted S08 Manifest to bounded VALIDATE without a Worker authority", () => {
    const root = s08Fixture();
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    expect(output.action).toBe("VALIDATE");
    expect(fs.existsSync(path.join(root, ".proofloop/context"))).toBe(false);
  });

  it("routes the admitted S08 v2 Manifest through the canonical CLI consumer", () => {
    const root = s08Fixture();
    s08Admit(root);
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    const v2 = output as VNextNextActionOutput;
    expect(v2.action).toBe("DISPATCH_WORKER");
    expect(v2.responsible_role).toBe("worker");
    expect(v2.stage_id).toBe("S08");
    expect(v2.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    expect(v2.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.proof_index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.snapshot_digest).toMatch(/^[a-f0-9]{40}$/);
  });

  it("returns exactly one structured S08 Primary Next Action with a digest-bound ContextRef and a minimal root-bound Context", () => {
    const root = s08Fixture();
    s08Admit(root);
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    const v2 = output as VNextNextActionOutput;
    // Unique structured Primary Next Action: exactly one canonical action
    // value plus owner, stage/slice/task and chain validity (S08-C Seam).
    expect(v2.action).toBe("DISPATCH_WORKER");
    expect(v2.responsible_role).toBe("worker");
    expect(v2.stage_id).toBe("S08");
    expect(v2.slice_id).toBe("S08-A");
    expect(v2.task_id).toBe("S08-A-T01");
    expect(v2.mode).toMatch(/^(implement-task|recover-task)$/);
    expect(v2.receipt_chain_valid).toBe(true);
    // Digest refs of the structured projection.
    expect(v2.context_ref).toMatch(/^\.proofloop\/context\/[a-f0-9]{64}\.json$/);
    expect(v2.manifest_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.proof_index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(v2.snapshot_digest).toMatch(/^[a-f0-9]{40}$/);
    // Digest-bound ContextRef: the persisted Context artifact must exist and
    // its content digest must equal the digest-addressed ref basename.
    expect(v2.context_ref).toBeDefined();
    const contextRef = v2.context_ref as string;
    const contextPath = path.join(root, contextRef);
    expect(fs.existsSync(contextPath)).toBe(true);
    const context = JSON.parse(fs.readFileSync(contextPath, "utf8")) as Record<string, unknown>;
    const refDigest = contextRef.replace(/^\.proofloop\/context\//, "").replace(/\.json$/, "");
    expect(context.context_digest).toBe(refDigest);
    const withoutDigest = { ...context };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(refDigest);
    // Minimal root-bound Context: goal/proof refs, skills, Evidence path, Plan
    // projection and the admitted Plan execution scope (non-empty code/test).
    expect(context.schema_version).toBe(2);
    expect(context.task_ref).toBe("delivery/stages/S08/tasks.md#/entities/S08-A-T01");
    expect(context.slice_goal_ref).toBe("REF-S08-A-GOAL");
    expect((context.proof_index as Record<string, unknown>).acceptance_refs).toContain("REF-S08-A-ACCEPTANCE");
    expect(context.required_skills).toEqual(["test-driven-development"]);
    expect(context.evidence_path).toBe("delivery/stages/S08/evidence/S08-A.md");
    expect(context.plan_projection_path).toBe("delivery/stages/S08/tasks.md");
    expect((context.allowed_code_scope as string[]).length).toBeGreaterThan(0);
    const executionScope = context.execution_scope as {
      code_paths: string[];
      test_paths: string[];
      forbidden_paths: string[];
    };
    expect(executionScope.code_paths.length).toBeGreaterThan(0);
    expect(executionScope.test_paths.length).toBeGreaterThan(0);
    expect(executionScope.forbidden_paths).toContain(".git");
    expect((context.scope as { mutable_projection_paths: string[] }).mutable_projection_paths).toEqual([
      "delivery/stages/S08/tasks.md",
    ]);
  });

  it("refuses to dispatch a tampered S08 Manifest binding and persists no Context authority", () => {
    const root = s08Fixture();
    s08Admit(root);
    const manifestPath = path.join(root, ".proofloop/manifests/S08.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      task_scopes: Record<string, { execution_scope: { code_paths: string[] } }>;
    };
    manifest.task_scopes["S08-A-T01"].execution_scope.code_paths.push(
      "packages/legacy-tools/tampered.ts",
    );
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    expect(output.action).toBe("VALIDATE");
    expect((output as VNextNextActionOutput).context_ref).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".proofloop/context"))).toBe(false);
  });

  it("fails closed on an admission authority whose Stage Plan binding no longer matches the Manifest", () => {
    const root = s08Fixture();
    s08Admit(root);
    // Rewrite the persisted Stage Plan authority so it is self-consistent but
    // stale: its manifest_digest no longer binds the admitted Manifest.
    const stagePlanPath = path.join(root, ".proofloop/receipts/plan/S08/vnext-stage-plan.json");
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, "utf8")) as Record<string, any>;
    const tampered: Record<string, any> = { ...stagePlan, manifest_digest: "c".repeat(64) };
    delete tampered.digest;
    fs.writeFileSync(
      stagePlanPath,
      JSON.stringify({ ...tampered, digest: computeVNextStagePlanReceiptDigest(tampered as never) }),
      "utf8",
    );
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    expect(output.action).toBe("VALIDATE");
    expect((output as VNextNextActionOutput).context_ref).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".proofloop/context"))).toBe(false);
  });

  it("fails closed when an admission fact is missing after admission and persists no Context authority", () => {
    const root = s08Fixture();
    s08Admit(root);
    // A missing fresh-SPV fact leaves the authority incomplete; the next
    // consumer must not re-derive or guess a Worker dispatch from the
    // remaining Stage Plan fact alone.
    fs.rmSync(path.join(root, ".proofloop/receipts/plan/S08/vnext-spv-pass.json"));
    const output = nextActionFromInput({
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    });
    expect(output.action).toBe("VALIDATE");
    expect((output as VNextNextActionOutput).context_ref).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".proofloop/context"))).toBe(false);
  });
});

/**
 * S08-D-T01 — source/dist parity for v1/v2 fixture routing on the CLI seam.
 * Task Ref: REF-S08-D-T01
 *
 * The same v1/v2 fixture must produce the identical structured output from
 * the source entry (`src/cli/next-action.ts`) and the built dist entry
 * (`dist/cli/next-action.js`). The CLI dist entry loads the compiled runtime
 * consumers, so this also proves the runtime source/dist route split stays
 * consistent for v1/v2 fixtures.
 */
describe("canonical next-action v1/v2 fixture routing source/dist parity (S08-D-T01)", () => {
  const ROUTE_FIXTURES: ReadonlyArray<{
    readonly name: string;
    readonly manifest?: Record<string, unknown>;
  }> = [
    { name: "v2-explicit", manifest: { version: 2, plan: { schema_version: 2 } } },
    {
      name: "v1-explicit",
      manifest: { version: 1, stage_id: "S04", source_path: "delivery/stages/S04/tasks.md" },
    },
    {
      name: "v1-legacy-shape",
      manifest: { stage_id: "S04", source_path: "delivery/stages/S04/tasks.md" },
    },
    { name: "cross-version", manifest: { version: 1, schema_version: 2 } },
    { name: "unknown-version", manifest: { version: 3 } },
    { name: "absent" },
  ];

  it("routes every v1/v2 fixture identically from source and dist", async () => {
    const dist = (await import(
      pathToFileURL(path.join(repo, "packages/runtime/dist/cli/next-action.js")).href
    )) as { nextActionFromInput: typeof nextActionFromInput };
    for (const fx of ROUTE_FIXTURES) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `vnext-cli-parity-`));
      cleanups.push(root);
      if (fx.manifest !== undefined) {
        const manifestPath = path.join(root, ".proofloop/manifests/S04.json");
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify(fx.manifest), "utf8");
      }
      const input = {
        project_root: root,
        stage_id: "S04",
        manifest_path: ".proofloop/manifests/S04.json",
      };
      const source = nextActionFromInput(input);
      const built = dist.nextActionFromInput({ ...input });
      expect(JSON.stringify(built), `${fx.name}: structured output`).toBe(
        JSON.stringify(source),
      );
    }
  });

  it("projects the identical admitted v2 DISPATCH_WORKER from source and dist on the real S08 candidate", async () => {
    const dist = (await import(
      pathToFileURL(path.join(repo, "packages/runtime/dist/cli/next-action.js")).href
    )) as { nextActionFromInput: typeof nextActionFromInput };
    const root = s08Fixture();
    s08Admit(root);
    const input = {
      project_root: root,
      stage_id: "S08",
      manifest_path: ".proofloop/manifests/S08.json",
      snapshot_digest: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    };
    const source = nextActionFromInput(input);
    const built = dist.nextActionFromInput({ ...input });
    expect(JSON.stringify(built)).toBe(JSON.stringify(source));
    // Both entries project the same vNext Worker dispatch (route
    // discriminator sanity on the real fixture).
    expect(built).toMatchObject({ action: "DISPATCH_WORKER", stage_id: "S08" });
  });
});

/**
 * S10-B-T02 — vNext role Context projection seam and CV Evidence read gate.
 * Task Ref: REF-S10-B-T02 (Acceptance B role Contexts, Seam Role transfer,
 * initial CV Evidence read gate).
 *
 * The seam is the SINGLE projection rule the CLI `context` domain consumes:
 * role is part of the Context content digest, so cross-role reuse of a
 * Context fails closed; the initial CV Context carries the Evidence read gate
 * declaration and a refutation observation must bind the exact
 * stage/slice/task/evidence_path/snapshot tuple to satisfy it.
 */
describe("vNext role Context projection seam (S10-B-T02)", () => {
  it("registers exactly the closed 7-role set and rejects unknown roles", () => {
    expect(VNEXT_CONTEXT_ROLES).toEqual([
      "planning",
      "spv",
      "worker",
      "cv",
      "committer",
      "stage-reviewer",
      "project-reviewer",
    ]);
    expect(isVNextContextRole("worker")).toBe(true);
    expect(isVNextContextRole("cv")).toBe(true);
    expect(isVNextContextRole("stage-reviewer")).toBe(true);
    expect(isVNextContextRole("bogus-role")).toBe(false);
  });

  it("projects a digest-bound cv Context with the Evidence read gate on the real S08 candidate", () => {
    const root = fixture();
    admit(root);
    const snapshot = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".proofloop/manifests/S04.json"), "utf8"),
    ) as Record<string, any>;
    const projection = projectVNextRoleContext({
      root,
      manifest,
      manifestDigest: computeDigest(manifest),
      snapshotDigest: snapshot,
      role: "cv",
      stageId: "S04",
      sliceId: "S04-A",
      taskId: "S04-A-T01",
    });
    expect(projection.role).toBe("cv");
    expect(projection.context.role).toBe("cv");
    expect(projection.context.schema_version).toBe(2);
    expect(projection.context.stage_id).toBe("S04");
    expect(projection.context.slice_id).toBe("S04-A");
    expect(projection.context.task_id).toBe("S04-A-T01");
    expect(projection.context.manifest_digest).toBe(computeDigest(manifest));
    expect(projection.context.plan_digest).toBe(manifest.plan.plan_digest);
    expect(projection.context.proof_index_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.context.snapshot_digest).toBe(snapshot);
    expect(projection.context.evidence_path).toBe("delivery/stages/S04/evidence/S04-A.md");
    expect(projection.context.plan_projection_path).toBe("delivery/stages/S04/tasks.md");
    // initial CV Evidence read gate declaration
    expect(projection.context.evidence_read_gate).toEqual({
      required: "refutation-observation",
      satisfied: false,
    });
    // digest-bound: content digest is self-consistent and ref is digest-addressed
    const withoutDigest: Record<string, unknown> = { ...projection.context };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(projection.context.context_digest);
    expect(projection.context_ref).toBe(
      `.proofloop/context/${projection.context.context_digest}.json`,
    );
  });

  it("projects distinct digests for every closed role on the same tuple", () => {
    const root = fixture();
    admit(root);
    const snapshot = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".proofloop/manifests/S04.json"), "utf8"),
    ) as Record<string, any>;
    const digests = new Set<string>();
    for (const role of VNEXT_CONTEXT_ROLES) {
      const projection = projectVNextRoleContext({
        root,
        manifest,
        manifestDigest: computeDigest(manifest),
        snapshotDigest: snapshot,
        role,
        stageId: "S04",
        sliceId: "S04-A",
        taskId: "S04-A-T01",
      });
      digests.add(projection.context.context_digest);
    }
    // role is part of the Context digest: 7 roles on one tuple => 7 distinct digests
    expect(digests.size).toBe(VNEXT_CONTEXT_ROLES.length);
  });

  it("fails closed on unknown role, non-canonical stage and unbound task", () => {
    const root = fixture();
    admit(root);
    const snapshot = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".proofloop/manifests/S04.json"), "utf8"),
    ) as Record<string, any>;
    expect(() =>
      projectVNextRoleContext({
        root,
        manifest,
        manifestDigest: computeDigest(manifest),
        snapshotDigest: snapshot,
        role: "bogus",
        stageId: "S04",
      }),
    ).toThrow(/outside the closed role set/);
    expect(() =>
      projectVNextRoleContext({
        root,
        manifest,
        manifestDigest: computeDigest(manifest),
        snapshotDigest: snapshot,
        role: "cv",
        stageId: "S08B0",
      }),
    ).toThrow(/canonical Stage ID/);
    expect(() =>
      projectVNextRoleContext({
        root,
        manifest,
        manifestDigest: computeDigest(manifest),
        snapshotDigest: snapshot,
        role: "cv",
        stageId: "S04",
        sliceId: "S04-A",
        taskId: "S04-A-T99",
      }),
    ).toThrow(/not bound to Slice/);
    // cv role requires a slice binding (Evidence read gate is slice-scoped)
    expect(() =>
      projectVNextRoleContext({
        root,
        manifest,
        manifestDigest: computeDigest(manifest),
        snapshotDigest: snapshot,
        role: "cv",
        stageId: "S04",
      }),
    ).toThrow(/requires a slice binding/);
  });

  it("projects a digest-bound refutation observation and verifies its Context binding", () => {
    const root = fixture();
    admit(root);
    const snapshot = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const cvContextDigest = "c".repeat(64);
    const projection = projectVNextRefutationObservation({
      root,
      stageId: "S04",
      sliceId: "S04-A",
      taskId: "S04-A-T01",
      evidencePath: "delivery/stages/S04/evidence/S04-A.md",
      snapshotDigest: snapshot,
      observation: "initial CV: Evidence read gate observation recorded before Evidence read",
      cvContextRef: `.proofloop/context/${cvContextDigest}.json`,
      cvContextDigest,
      recordedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(projection.observation.type).toBe("REFUTATION_OBSERVATION");
    expect(projection.observation.role).toBe("cv");
    expect(projection.observation.cv_context_digest).toBe(cvContextDigest);
    expect(projection.observation.recorded_at).toBe("2026-08-11T00:00:00.000Z");
    expect(projection.ref).toBe(
      `.proofloop/context/${projection.observation.context_digest}.json`,
    );
    const withoutDigest: Record<string, unknown> = { ...projection.observation };
    delete withoutDigest.context_digest;
    expect(computeDigest(withoutDigest)).toBe(projection.observation.context_digest);
    // binding verification: same tuple passes, a different task fails closed
    const sameTuple = verifyVNextRefutationObservationBinding(root, projection.observation, {
      stage_id: "S04",
      slice_id: "S04-A",
      task_id: "S04-A-T01",
      evidence_path: "delivery/stages/S04/evidence/S04-A.md",
      snapshot_digest: snapshot,
    });
    expect(sameTuple.ok).toBe(true);
    const wrongTask = verifyVNextRefutationObservationBinding(root, projection.observation, {
      stage_id: "S04",
      slice_id: "S04-A",
      task_id: "S04-A-T02",
      evidence_path: "delivery/stages/S04/evidence/S04-A.md",
      snapshot_digest: snapshot,
    });
    expect(wrongTask.ok).toBe(false);
    if (!wrongTask.ok) expect(wrongTask.field).toBe("task_id");
    const tampered = verifyVNextRefutationObservationBinding(
      root,
      { ...projection.observation, observation: "tampered" },
      {
        stage_id: "S04",
        slice_id: "S04-A",
        task_id: "S04-A-T01",
        evidence_path: "delivery/stages/S04/evidence/S04-A.md",
        snapshot_digest: snapshot,
      },
    );
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.field).toBe("context_digest");
  });
});
