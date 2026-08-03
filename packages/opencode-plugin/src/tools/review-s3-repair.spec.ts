/**
 * @proofloop/opencode-plugin — proofloop_review S3 CV repair proof
 * (S03-D-REFPATH-POSTWRITE-TOCTOU-SCOPE-001).
 *
 * Repair context: first CV REPAIR verdict on S03-D, failed criteria
 * PO-S03-D-02 / PO-S03-D-05 (enhanced fail-closed/ref-only artifact integrity).
 * Counterexamples closed here:
 *
 *   1. AUTHORITY-REF FAIL-CLOSED (recheck 1): `discoverAuthorityRefs` FAILS
 *      CLOSED with HOST.PATH_OUTSIDE_PROJECT when an authority artifact
 *      (PRD.md / tech-spec dir / tech-spec/*.md) resolves outside the trust
 *      root or through a symlink escape — it is NEVER silently omitted. A
 *      missing file stays an honest absence.
 *   2. CV-REF PATH INTEGRITY (recheck 2): ReviewInput CV refs use the receipt
 *      reader's ACTUAL persisted `latest.filePath` — never a synthesized
 *      `<digest>.json` string — so a renamed-but-valid receipt stays
 *      LOCATABLE (the test asserts `fs.existsSync` on the resolved path).
 *      An outside-root CV category fails closed (chain broken).
 *   3. FINALIZE POST-WRITE TOCTOU (recheck 3): ALL hard verification runs
 *      BEFORE `admitStageReview`; the post-admission manifest re-verify is
 *      DIAGNOSTIC-ONLY (warn finding, NEVER flips an admitted result to a
 *      failure with a persisted receipt). Proven via the documented test-only
 *      `beforeAdmit` / `afterAdmit` seam routed through the REAL built
 *      factory + execute envelope (S03-C-established closure).
 *   4. CONCURRENT DUPLICATE-FINALIZE (recheck 5): two parallel finalize
 *      ACCEPTED calls on one UNDER_REVIEW fixture produce at most one
 *      STAGE_REVIEW_PASS receipt (the runtime stage/state precondition
 *      refuses the second).
 *
 * Seam: the BUILT plugin entry (`packages/opencode-plugin/dist/index.js`,
 * rebuilt in beforeAll) — the same host-load seam as the T03 proof.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  admitCVResult,
  admitIntegration,
  admitSliceCommit,
  admitSpvResult,
  admitStagePlan,
  admitWorkerResult,
  manifestFileDigest,
  reconcileStage,
} from '@proofloop/runtime';
import type { AdmissionDeps, SpvGateAdmissionDeps } from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { deriveStageRiskLevel, normalizeRiskFact } from './review-common.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-D';
const TASKS: readonly string[] = ['S03-D-T01', 'S03-D-T02', 'S03-D-T03'];
const FIXED_ACTION_TOKEN = 'tok-repair-t03';

const DIST_ENTRY = path.join(
  process.cwd(),
  'packages',
  'opencode-plugin',
  'dist',
  'index.js',
);

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

beforeAll(() => {
  execFileSync(
    'npm',
    ['exec', '--', 'tsc', '-b', 'packages/kernel', 'packages/runtime', 'packages/opencode-plugin'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  expect(existsSync(DIST_ENTRY)).toBe(true);
});

/** Deterministic git commit environment (fixed dates → identical SHAs across fixtures). */
function gitCommitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z',
  };
}

// ============================================================
// Fixture (real temp git worktree + canonical layout)
// ============================================================

interface RepairFx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(riskFacts?: readonly string[]): void;
  writeAuthorityDocs(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(message?: string): string;
  cleanup(): void;
}

function makeFx(): RepairFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03d-repair-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03d@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03D Repair']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'Reviewer 准备并受理 Stage Review',
    observable_outcome: 'prepare/finalize through the built review host seam',
    public_seam: 'Hooks.tool.proofloop_review',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-D-02',
        behavior: 'prepare assembles ref-only ReviewInput from persisted facts',
        public_seam: 'built review tool execute',
        oracle_source: 'independent fixture oracle',
        success_criteria: 'field-by-field oracle equality + no Receipt body',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: RepairFx = {
    root,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (riskFacts = ['core_state_machine', 'irreversible_operation']) => {
      const manifest: Manifest = {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 stage review via the built review tool seam',
        outcomes: [
          'prepare returns a ref-only stage ReviewInput',
          'finalize admits ACCEPTED/REPAIR',
        ],
        slices: [sliceDef(SLICE_ID, TASKS)],
        dependencies: [],
        risk_facts: [...riskFacts],
      };
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeAuthorityDocs: () => {
      fx.write('PRD.md', '# PRD\n\nGoal-first proof.\n');
      fx.write('tech-spec/contract-state-matrix.md', '# Contract State Matrix\n\n§1.3 review ops.\n');
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      const content =
        `# Stage ${STAGE_ID} — S3 Review\n\n` +
        `## Slice ${SLICE_ID}\n<!-- SLICE:${SLICE_ID}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${SLICE_ID}:END -->\n`;
      fx.write(`delivery/stages/${STAGE_ID}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${SLICE_ID} Evidence\n\n## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-D-02 | review-s3-repair.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`, content);
    },
    commitAll: (message = 'baseline') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message], {
        env: gitCommitEnv(),
      });
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    },
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Worker envelope for fixture prerequisite admits (finalize-slice, FIXED token). */
function makeEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: FIXED_ACTION_TOKEN,
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S03-D-T01',
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/review.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 'repair worker',
  };
}

/** Seed an UNDER_REVIEW stage (plan → spv → finalize → CV → commit → integration). */
function buildUnderReview(fx: RepairFx): void {
  const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
  const manifestDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
  const deps: AdmissionDeps = { projectRoot: fx.root };
  const spvDeps: SpvGateAdmissionDeps = { projectRoot: fx.root };
  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest },
    deps,
  );
  expect(plan.accepted).toBe(true);
  const spv = admitSpvResult(
    { type: 'spv_result', stageId: STAGE_ID, manifestDigest, summary: 'spv ok' },
    spvDeps,
  );
  expect(spv.accepted).toBe(true);
  const worker = admitWorkerResult(
    { type: 'worker_result', envelope: makeEnvelope() as never },
    deps,
  );
  expect(worker.accepted).toBe(true);
  const cv = admitCVResult(
    { type: 'cv_result', stageId: STAGE_ID, sliceId: SLICE_ID, verdict: 'PASS', snapshotDigest: head, summary: 'cv pass' },
    deps,
  );
  expect(cv.accepted).toBe(true);
  const cvDigest = cv.receipt_ref as string;
  const commit = admitSliceCommit(
    { type: 'slice_commit', stageId: STAGE_ID, sliceId: SLICE_ID, commitSha: head, cvReceiptDigest: cvDigest },
    deps,
  );
  expect(commit.accepted).toBe(true);
  const integration = admitIntegration(
    { type: 'integration', stageId: STAGE_ID, sliceId: SLICE_ID, commitSha: head },
    deps,
  );
  expect(integration.accepted).toBe(true);
  expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
    'UNDER_REVIEW',
  );
}

/** Seed a full UNDER_REVIEW fixture WITH authority docs present. */
function underReviewWithAuthority(): RepairFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeAuthorityDocs();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll('baseline');
  buildUnderReview(fx);
  return fx;
}

/** Seed an UNDER_REVIEW fixture whose manifest uses the compiled COLON-form risk facts. */
function underReviewWithColonFacts(): RepairFx {
  const fx = makeFx();
  fx.writeManifest(['irreversible_operation: true', 'core_state_machine: true']);
  fx.writeAuthorityDocs();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll('baseline');
  buildUnderReview(fx);
  return fx;
}

// ============================================================
// Built host-load helpers
// ============================================================

function makeInput(root: string): PluginInput {
  return {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {} as PluginInput['$'],
  } as unknown as PluginInput;
}

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s03d-repair',
    messageID: 'msg-s03d-repair',
    agent: 'stage-reviewer',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type BuiltEntry = {
  default?: unknown;
  server?: unknown;
  [key: string]: unknown;
};

type BuiltExecuteTool = {
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<{ output: string }>;
};

async function loadBuilt(): Promise<BuiltEntry> {
  return (await import(pathToFileURL(DIST_ENTRY).href)) as BuiltEntry;
}

/** Built review tool. `finalizeDeps` is the CV test-only seam (4th factory arg). */
function makeBuiltReviewTool(
  plugin: BuiltEntry,
  root: string,
  finalizeDeps?: { beforeAdmit?: () => void; afterAdmit?: () => void },
): BuiltExecuteTool {
  const createCtx = plugin['createRuntimeContext'] as (input: unknown) => RuntimeContext;
  const factory = plugin['createReviewTool'] as (
    context: RuntimeContext,
    handlers?: unknown,
    zodLoader?: unknown,
    deps?: unknown,
  ) => BuiltExecuteTool;
  return factory(createCtx(makeInput(root)), undefined, undefined, finalizeDeps);
}

function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
}

function readReceiptFiles(dir: string): any[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')));
}

function reviewReceipts(root: string): any[] {
  return readReceiptFiles(path.join(root, '.proofloop', 'receipts', 'review', STAGE_ID));
}

/** Recursively snapshot `.proofloop/receipts/**` + `.proofloop/runtime/**`. */
function snapshotProtected(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, base: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const content = readFileSync(abs);
        map.set(rel, createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'), '.proofloop/receipts');
  walk(path.join(root, '.proofloop', 'runtime'), '.proofloop/runtime');
  return map;
}

function expectProtectedIdentical(before: Map<string, string>, after: Map<string, string>): void {
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    expect(after.get(key) ?? null, `protected artifact changed: ${key}`).toBe(
      before.get(key) ?? null,
    );
  }
}

/** Create an outside-root scratch dir (for symlink-escape fixtures). */
function outsideScratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 's03d-outside-'));
  writeFileSync(path.join(dir, 'evil.md'), '# outside authority\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ============================================================
// Counterexample 1 — authority-ref fail-closed (recheck 1)
// ============================================================

describe('repair: authority-ref fail-closed (counterexample 1)', () => {
  it('PRD.md symlink-escape → built prepare fails closed HOST.PATH_OUTSIDE_PROJECT, no write', async () => {
    const fx = underReviewWithAuthority();
    const outside = outsideScratch();
    const plugin = await loadBuilt();
    try {
      const prd = path.join(fx.root, 'PRD.md');
      expect(existsSync(prd)).toBe(true);
      rmSync(prd, { force: true });
      symlinkSync(path.join(outside.dir, 'evil.md'), prd);
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    } finally {
      fx.cleanup();
      outside.cleanup();
    }
  });

  it('tech-spec file symlink-escape → built prepare fails closed, no write', async () => {
    const fx = underReviewWithAuthority();
    const outside = outsideScratch();
    const plugin = await loadBuilt();
    try {
      const techFile = path.join(fx.root, 'tech-spec', 'contract-state-matrix.md');
      expect(existsSync(techFile)).toBe(true);
      rmSync(techFile, { force: true });
      symlinkSync(path.join(outside.dir, 'evil.md'), techFile);
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    } finally {
      fx.cleanup();
      outside.cleanup();
    }
  });

  it('normal fixture: authority refs present with root-bound relative paths + content digests (regression)', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      const authorityRefs = data['authority_refs'] as Array<{ ref: string; digest: string }>;
      expect(authorityRefs.some((r) => r.ref === 'PRD.md')).toBe(true);
      expect(authorityRefs.some((r) => r.ref === 'tech-spec/contract-state-matrix.md')).toBe(true);
      for (const ref of authorityRefs) {
        expect(path.isAbsolute(ref.ref)).toBe(false);
        expect(ref.ref.split('/')).not.toContain('..');
        expect(ref.digest).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// Counterexample 2 — CV-ref path integrity (recheck 2)
// ============================================================

describe('repair: CV-ref path integrity (counterexample 2)', () => {
  it('a renamed-but-valid CV receipt produces a LOCATABLE ref pointing at the ACTUAL file', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      // Rename the persisted CV receipt file (valid content, different name).
      const cvDir = path.join(fx.root, '.proofloop', 'receipts', 'cv', STAGE_ID, SLICE_ID);
      const originalName = readdirSync(cvDir).find((f) => f.endsWith('.json'))!;
      expect(originalName).toBeDefined();
      fs.renameSync(path.join(cvDir, originalName), path.join(cvDir, 'renamed.json'));

      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      const cvRefs = data['cv_receipt_refs'] as Array<{ ref: string; digest: string }>;
      expect(cvRefs).toHaveLength(1);
      // The ref points at the ACTUAL persisted file (renamed), and is LOCATABLE.
      expect(cvRefs[0].ref).toContain('renamed.json');
      expect(existsSync(path.join(fx.root, cvRefs[0].ref))).toBe(true);
      expect(cvRefs[0].ref).not.toContain(originalName);
    } finally {
      fx.cleanup();
    }
  });

  it('an outside-root CV category symlink fails closed (no write)', async () => {
    const fx = underReviewWithAuthority();
    const outside = outsideScratch();
    const plugin = await loadBuilt();
    try {
      // Replace the CV category directory with a symlink to an outside dir.
      const cvDir = path.join(fx.root, '.proofloop', 'receipts', 'cv', STAGE_ID, SLICE_ID);
      rmSync(cvDir, { recursive: true, force: true });
      mkdirSync(path.dirname(cvDir), { recursive: true });
      symlinkSync(outside.dir, cvDir);
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      // The reader surfaces the escape as a broken chain (S2-F-003), so no CV
      // fact is derived and prepare fails closed.
      expect(envelope.output).toMatch(/RUNTIME\.RECEIPT_CHAIN_BROKEN|HOST\.PATH_OUTSIDE_PROJECT|HOST\.PROJECT_NOT_TRUSTED/);
    } finally {
      fx.cleanup();
      outside.cleanup();
    }
  });
});

// ============================================================
// Counterexample 3 — finalize post-write TOCTOU (recheck 3)
// ============================================================

describe('repair: finalize post-write TOCTOU atomicity (counterexample 3)', () => {
  it('manifest swap before the call → no write (pre-admission closure)', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      // Swap the manifest to an invalid document BEFORE the call: the
      // pre-admission content trust-root guard fails → no runtime call, no
      // receipt.
      writeFileSync(
        path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`),
        '{ not valid json',
        'utf-8',
      );
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(reviewReceipts(fx.root)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  it('manifest swap BETWEEN pre-admission verification and the call → no write (beforeAdmit seam)', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const manifestPath = path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root, {
        beforeAdmit: () => {
          // Swap to a schema-valid manifest whose stage_id does NOT match the
          // canonical stage — the runtime reconcile refuses (no write).
          const swapped = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
          swapped.stage_id = 'S99';
          writeFileSync(manifestPath, JSON.stringify(swapped, null, 2), 'utf-8');
        },
      });
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      // The pre-admission verification validated the ORIGINAL manifest; the
      // between-window swap makes the runtime refuse → no receipt is written.
      expect(reviewReceipts(fx.root)).toHaveLength(0);
      expect(existsSync(path.join(fx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      void envelope;
    } finally {
      fx.cleanup();
    }
  });

  it('manifest swap AFTER the write → DIAGNOSTIC-ONLY warn, receipt retained, never failure-with-persisted-receipt (afterAdmit seam)', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const manifestPath = path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
      const tool = makeBuiltReviewTool(plugin, fx.root, {
        afterAdmit: () => {
          const swapped = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
          swapped.stage_goal = 'SWAPPED after the runtime wrote the receipt';
          writeFileSync(manifestPath, JSON.stringify(swapped, null, 2), 'utf-8');
        },
      });
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      const data = parseData(envelope.output);
      // The admitted result is NEVER flipped; the receipt stays persisted.
      expect(data['accepted']).toBe(true);
      expect(data['receipt_ref']).not.toBeNull();
      expect(reviewReceipts(fx.root)).toHaveLength(1);
      expect(reviewReceipts(fx.root)[0].type).toBe('STAGE_REVIEW_PASS');
      // The manifest change is a warn diagnostic — never an error-level flip.
      const findings = data['findings'] as Array<{ code: string; severity: string }>;
      const warns = findings.filter((f) => f.severity === 'warn');
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(warns[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// Recheck 5 — concurrent duplicate-finalize
// ============================================================

describe('repair: concurrent duplicate-finalize (recheck 5)', () => {
  it('two parallel finalize ACCEPTED calls produce at most one STAGE_REVIEW_PASS receipt', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const results = await Promise.all([
        tool.execute(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
          makeToolContext(fx.root),
        ),
        tool.execute(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
          makeToolContext(fx.root),
        ),
      ]);
      const datas = results.map((r) => parseData(r.output));
      const accepted = datas.filter((d) => d['accepted'] === true);
      expect(accepted.length).toBe(1);
      const refused = datas.find((d) => d['accepted'] === false);
      expect(refused?.receipt_ref).toBeNull();
      // At most one STAGE_REVIEW_PASS receipt in the review category.
      const receipts = reviewReceipts(fx.root);
      expect(receipts.length).toBeLessThanOrEqual(1);
      expect(receipts.filter((r) => r.type === 'STAGE_REVIEW_PASS')).toHaveLength(1);
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// Diagnose recheck#1 — unreadable authority artifacts fail closed
// (error classification: ENOENT honest absence vs EACCES/ENOTDIR/EISDIR fail)
// ============================================================

describe('diagnose: unreadable authority artifacts fail closed (recheck#1)', () => {
  it('PRD.md unreadable (chmod 000 → EACCES on read) → prepare fails closed RUNTIME.SCHEMA_MISMATCH, no write', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const prd = path.join(fx.root, 'PRD.md');
      fs.chmodSync(prd, 0o000);
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    } finally {
      // Restore permissions so the recursive cleanup can traverse.
      try {
        fs.chmodSync(path.join(fx.root, 'PRD.md'), 0o644);
      } catch {
        /* best-effort */
      }
      fx.cleanup();
    }
  });

  it('PRD.md replaced by a DIRECTORY (EISDIR-on-file) → prepare fails closed, no write', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const prd = path.join(fx.root, 'PRD.md');
      rmSync(prd, { force: true });
      mkdirSync(prd, { recursive: true });
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    } finally {
      fx.cleanup();
    }
  });

  it('tech-spec directory unreadable (chmod 000 → EACCES on readdir) → prepare fails closed, no write', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const techDir = path.join(fx.root, 'tech-spec');
      fs.chmodSync(techDir, 0o000);
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    } finally {
      try {
        fs.chmodSync(path.join(fx.root, 'tech-spec'), 0o755);
      } catch {
        /* best-effort */
      }
      fx.cleanup();
    }
  });

  it('tech-spec replaced by a FILE (ENOTDIR on readdir) → prepare fails closed, no write', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const techDir = path.join(fx.root, 'tech-spec');
      rmSync(techDir, { recursive: true, force: true });
      writeFileSync(techDir, '# not a directory\n', 'utf-8');
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    } finally {
      fx.cleanup();
    }
  });

  it('PRD.md missing entirely (ENOENT) → honest absence; prepare succeeds with the remaining refs', async () => {
    const fx = underReviewWithAuthority();
    const plugin = await loadBuilt();
    try {
      const prd = path.join(fx.root, 'PRD.md');
      rmSync(prd, { force: true });
      const before = snapshotProtected(fx.root);
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      const authorityRefs = data['authority_refs'] as Array<{ ref: string; digest: string }>;
      // PRD.md honestly absent; the tech-spec ref remains.
      expect(authorityRefs.some((r) => r.ref === 'PRD.md')).toBe(false);
      expect(authorityRefs.some((r) => r.ref === 'tech-spec/contract-state-matrix.md')).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// Stage Review finding S3-REVIEW-001 — colon-form risk_facts normalization
// ============================================================

describe('repair: risk_level normalization for colon-form risk_facts (S3-REVIEW-001)', () => {
  it('normalizeRiskFact: colon-form true → bare key; false → absent; bare key → as-is; malformed → absent', () => {
    expect(normalizeRiskFact('irreversible_operation: true')).toBe('irreversible_operation');
    expect(normalizeRiskFact('irreversible_operation: false')).toBeNull();
    expect(normalizeRiskFact('irreversible_operation:  true')).toBe('irreversible_operation');
    expect(normalizeRiskFact('irreversible_operation')).toBe('irreversible_operation');
    expect(normalizeRiskFact('')).toBeNull();
    expect(normalizeRiskFact('irreversible_operation: maybe')).toBeNull();
    expect(normalizeRiskFact('migration: false')).toBeNull();
  });

  it('deriveStageRiskLevel: canonical colon-form facts → correct level (incl. critical combos)', () => {
    expect(deriveStageRiskLevel(['irreversible_operation: true', 'core_state_machine: true'])).toBe('critical');
    expect(deriveStageRiskLevel(['irreversible_operation: true', 'external_side_effect: true'])).toBe('critical');
    expect(deriveStageRiskLevel(['irreversible_operation: true'])).toBe('high');
    expect(deriveStageRiskLevel(['core_state_machine: true'])).toBe('high');
    expect(deriveStageRiskLevel(['external_side_effect: true'])).toBe('high');
    expect(deriveStageRiskLevel(['persistent_state: true'])).toBe('medium');
    expect(deriveStageRiskLevel(['authorization: true'])).toBe('medium');
    expect(deriveStageRiskLevel(['cross_process_behavior: true'])).toBe('medium');
    expect(deriveStageRiskLevel(['concurrency: true'])).toBe('medium');
    expect(deriveStageRiskLevel(['public_api_change: true'])).toBe('low');
    expect(deriveStageRiskLevel([])).toBe('low');
  });

  it('deriveStageRiskLevel: false-valued facts are excluded (a negative fact is NOT present)', () => {
    // The false irreversible fact must NOT combine into critical — only the
    // true core_state_machine fact remains → high.
    expect(
      deriveStageRiskLevel(['irreversible_operation: false', 'core_state_machine: true']),
    ).toBe('high');
    expect(
      deriveStageRiskLevel(['irreversible_operation: true', 'external_side_effect: false']),
    ).toBe('high');
    expect(deriveStageRiskLevel(['persistent_state: false'])).toBe('low');
  });

  it('deriveStageRiskLevel: bare keys still work (backward compatibility)', () => {
    expect(deriveStageRiskLevel(['irreversible_operation', 'core_state_machine'])).toBe('critical');
    expect(deriveStageRiskLevel(['core_state_machine'])).toBe('high');
    expect(deriveStageRiskLevel(['persistent_state', 'authorization'])).toBe('medium');
    expect(deriveStageRiskLevel(['public_api_change'])).toBe('low');
  });

  it('deriveStageRiskLevel: the REAL compiled S3 manifest risk_facts array → critical (finding closed on the actual contract shape)', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(process.cwd(), '.proofloop', 'manifests', 'S3.json'), 'utf-8'),
    ) as { risk_facts: string[] };
    // The compiled manifest uses colon forms and includes the true
    // irreversible_operation + core_state_machine + external_side_effect facts.
    expect(manifest.risk_facts).toContain('irreversible_operation: true');
    expect(manifest.risk_facts).toContain('core_state_machine: true');
    expect(manifest.risk_facts).toContain('external_side_effect: true');
    expect(deriveStageRiskLevel(manifest.risk_facts)).toBe('critical');
  });

  it('built-host prepare on an UNDER_REVIEW fixture with colon-form risk_facts → ReviewInput risk_level is critical', async () => {
    const fx = underReviewWithColonFacts();
    const plugin = await loadBuilt();
    try {
      const tool = makeBuiltReviewTool(plugin, fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);
      expect(data['risk_level']).toBe('critical');
      // The raw persisted risk_facts are carried through as-is (ref-only fact
      // projection), while the projected level is normalized.
      expect(data['risk_facts']).toEqual(['irreversible_operation: true', 'core_state_machine: true']);
    } finally {
      fx.cleanup();
    }
  });
});
