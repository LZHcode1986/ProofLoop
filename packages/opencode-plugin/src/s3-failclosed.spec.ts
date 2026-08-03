/**
 * @proofloop/opencode-plugin — S3 cross-tool fail-closed / no-write / abort /
 * chain / path battery + admission-pipeline-only guard + S2 read-only
 * regression (S03-E-T03, PO-S03-E-04 / PO-S03-E-05).
 *
 * PO-S03-E-04: every selected operation's invalid/schema/path/state/binding/
 * duplicate/broken-chain/unsupported/abort branch fails closed with NO
 * forbidden business artifact mutation (only `.proofloop/logs/**` may append)
 * and NO operation bypasses the runtime admission pipeline.
 *
 * PO-S03-E-05: S2 read-only operations remain parity/no-write after the S3
 * operation registry expansion; S3 does not expose S4/S5 capabilities (hooks,
 * role matrix, run_gate, proofloop_project).
 *
 * Seam: the BUILT plugin entry (`packages/opencode-plugin/dist/index.js`) is
 * loaded through a file URL and invoked on real temp ProofLoop fixtures; the
 * REGISTERED `Hooks.tool` tools are exercised through their real `execute`
 * host seam (never a source import for the battery). The runtime CLI
 * `admitRequest` is NOT needed here — the battery is fail-closed/no-write
 * proof, not a parity comparison (that is s3-parity.spec.ts).
 *
 * Battery structure:
 *   - every fail branch runs a BEFORE/AFTER snapshot of `.proofloop/receipts/**`
 *     + `.proofloop/runtime/**` and asserts byte-identical protected artifacts;
 *   - every unsupported operation (run_gate / gate / project / stage_plan /
 *     e2e / unknown) surfaces a canonical RUNTIME.SCHEMA_MISMATCH Finding and
 *     never dispatches a write branch;
 *   - every pre-aborted caller propagates AbortError (never a clean PASS);
 *   - a tampered receipt category fails closed with no new Receipt;
 *   - success-branch Receipt creation is EXCLUSIVELY through the runtime
 *     admit methods: a static source guard asserts the production plugin
 *     layers contain no `writeReceipt(` / `runAdmitPipeline(` call expression,
 *     no child_process / spawn / exec / dist-cli usage, and that the runtime
 *     `runAdmitPipeline` is the single writer path the plugin reaches through
 *     the in-process admit methods.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import { RUNTIME_LOCK_EXPECTATIONS } from './runtime-lock.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-A';
const TASKS: readonly string[] = ['S03-A-T01', 'S03-A-T02'];

const DIST_ENTRY = path.join(
  process.cwd(),
  'packages',
  'opencode-plugin',
  'dist',
  'index.js',
);

type BuiltEntry = {
  default?: unknown;
  server?: unknown;
  [key: string]: unknown;
};

type PluginInputShape = {
  client: { app: { log: () => void } };
  project: Record<string, unknown>;
  directory: string;
  worktree: string;
  experimental_workspace: { register: () => void };
  serverUrl: URL;
  $: Record<string, unknown>;
};

type ToolContextShape = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input?: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input?: unknown): Promise<void>;
};

type RegisteredTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContextShape,
  ) => Promise<{ output: string }>;
};

type RegisteredTools = {
  proofloop_doctor: RegisteredTool;
  proofloop_plan: RegisteredTool;
  proofloop_stage: RegisteredTool;
  proofloop_review: RegisteredTool;
};

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

// ============================================================
// Built plugin load + registered Hooks.tool seam
// ============================================================

async function loadBuilt(): Promise<BuiltEntry> {
  return (await import(pathToFileURL(DIST_ENTRY).href)) as BuiltEntry;
}

function pluginInput(root: string): PluginInputShape {
  return {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {},
  };
}

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContextShape {
  return {
    sessionID: 'sess-s03e-t03',
    messageID: 'msg-s03e-t03',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Load the built plugin on a fixture and return the REGISTERED tools. */
async function registeredTools(root: string): Promise<RegisteredTools> {
  const entry = await loadBuilt();
  const plugin = (entry.default ?? entry.server) as (
    input: PluginInputShape,
  ) => Promise<{ tool: Record<string, RegisteredTool> }>;
  const hooks = await plugin(pluginInput(root));
  expect(Object.keys(hooks)).toEqual(['tool']);
  const tool = hooks.tool as Record<string, RegisteredTool>;
  return tool as unknown as RegisteredTools;
}

// ============================================================
// Protected-artifact snapshot helpers (no-write proof)
// ============================================================

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

/** Count receipt JSON files under `.proofloop/receipts/**`. */
function receiptCount(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.json')) count += 1;
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'));
  return count;
}

/** Every surfaced fail-closed output must carry a canonical finding + Status. */
function expectFailClosed(output: string): void {
  expect(output).toContain('Status: failed');
  expect(output).toMatch(
    /(RUNTIME\.SCHEMA_MISMATCH|HOST\.PATH_OUTSIDE_PROJECT|HOST\.PROJECT_NOT_TRUSTED|DOMAIN\.INVALID_TRANSITION|DOMAIN\.STAGE_NOT_FOUND|RUNTIME\.RECEIPT_CHAIN_BROKEN)/,
  );
}

// ============================================================
// Fixture builder (active ProofLoop worktree with valid lock)
// ============================================================

interface Fx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(sliceId: string, taskIds: readonly string[]): void;
  writeTasksMd(sliceId: string, taskIds: readonly string[], checked: readonly string[]): void;
  writeEvidence(sliceId: string, taskIds: readonly string[], finalized: boolean): void;
  commitAll(message?: string): void;
  cleanup(): void;
}

function makeFx(prefix = 's03e-t03-'): Fx {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03e@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03E T03']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });

  const e = RUNTIME_LOCK_EXPECTATIONS;
  writeFileSync(
    path.join(root, '.proofloop', 'runtime.lock'),
    JSON.stringify(
      {
        runtime_version: e.runtimeVersion.ok ? e.runtimeVersion.version : '0.1.0',
        domain_schema_version: e.schemaVersion,
        risk_policy_version: 1,
        capability_policy_version: 1,
        host_adapter: e.hostAdapter,
        plugin_package: e.pluginPackage,
        plugin_version: e.pluginVersion.ok ? e.pluginVersion.version : '0.1.0',
      },
      null,
      2,
    ),
    'utf-8',
  );

  const fx: Fx = {
    root,
    write: (rel, content) => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (sliceId, taskIds) => {
      const sliceDef: ManifestSlice = {
        slice_id: sliceId,
        goal: 'S3 fail-closed battery fixture',
        observable_outcome: 'no-write on every fail branch',
        public_seam: 'Hooks.tool built host seam',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-E-04',
            behavior: 'every fail branch leaves protected artifacts unchanged',
            public_seam: 'built host execute',
            oracle_source: 'real fixture project',
            success_criteria: 'no-write + fail-closed finding',
            required_observation: 'fixture oracle',
            applicable_risk_facts: ['persistent_state', 'core_state_machine'],
          },
        ],
        tasks: [...taskIds],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sliceId}.md`,
        cv_minimum_level: 'enhanced',
      };
      const manifest: Manifest = {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 fail-closed battery',
        outcomes: ['no-write'],
        slices: [sliceDef],
        dependencies: [],
        risk_facts: [],
      };
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (sliceId, taskIds, checked) => {
      const lines = taskIds.map((t) => `- [${checked.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      fx.write(
        `delivery/stages/${STAGE_ID}/tasks.md`,
        `# Stage ${STAGE_ID} — S3 Fail-Closed\n\n## Slice ${sliceId}\n<!-- SLICE:${sliceId}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n<!-- SLICE:${sliceId}:END -->\n`,
      );
    },
    writeEvidence: (sliceId, taskIds, finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n## Task Evidence\n\n${taskIds.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-E-04 | s3-failclosed.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${STAGE_ID}/evidence/${sliceId}.md`, content);
    },
    commitAll: (message = 'baseline') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
    },
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Baseline stage fixture (checked tasks + finalized evidence). */
function seedBaseline(): Fx {
  const fx = makeFx('s03e-t03-base-');
  fx.writeManifest(SLICE_ID, TASKS);
  fx.writeTasksMd(SLICE_ID, TASKS, TASKS);
  fx.writeEvidence(SLICE_ID, TASKS, true);
  fx.commitAll('baseline');
  return fx;
}

/** Legal PLANNING stage (manifest + STAGE_PLAN fact). */
function seedPlanning(): { fx: Fx; manifestDigest: string } {
  const fx = makeFx('s03e-t03-plan-');
  fx.writeManifest(SLICE_ID, TASKS);
  fx.writeTasksMd(SLICE_ID, TASKS, []);
  fx.writeEvidence(SLICE_ID, TASKS, false);
  fx.commitAll('planning fixture');
  const digest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: digest },
    { projectRoot: fx.root },
  );
  expect(plan.accepted).toBe(true);
  return { fx, manifestDigest: digest };
}

/** READY_FOR_CV stage: baseline + worker finalize-slice. */
function seedReadyForCv(): Fx {
  const fx = seedBaseline();
  const worker = admitWorkerResult(
    {
      type: 'worker_result',
      envelope: makeEnvelope() as never,
    },
    { projectRoot: fx.root },
  );
  expect(worker.accepted).toBe(true);
  return fx;
}

/** CV_PASSED + committed: baseline + worker + CV PASS + SLICE_COMMIT. */
function seedCommitted(): { fx: Fx; cvDigest: string } {
  const fx = seedReadyForCv();
  const cv = admitCVResult(
    {
      type: 'cv_result',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      verdict: 'PASS',
      snapshotDigest: 'c'.repeat(64),
      summary: 'cv pass',
    },
    { projectRoot: fx.root },
  );
  expect(cv.accepted).toBe(true);
  const cvDigest = cv.receipt_ref as string;
  const commit = admitSliceCommit(
    {
      type: 'slice_commit',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      commitSha: 'a'.repeat(40),
      cvReceiptDigest: cvDigest,
    },
    { projectRoot: fx.root },
  );
  expect(commit.accepted).toBe(true);
  return { fx, cvDigest };
}

/** UNDER_REVIEW stage from a fresh fixture (deterministic full chain). */
function seedUnderReview(): { fx: Fx; head: string } {
  const fx = makeFx('s03e-t03-review-');
  fx.writeManifest(SLICE_ID, TASKS);
  fx.writeTasksMd(SLICE_ID, TASKS, TASKS);
  fx.writeEvidence(SLICE_ID, TASKS, true);
  fx.commitAll('baseline');
  const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
  const manifestDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
  const deps = { projectRoot: fx.root };

  const plan = admitStagePlan({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest }, deps);
  expect(plan.accepted).toBe(true);
  const spv = admitSpvResult(
    { type: 'spv_result', stageId: STAGE_ID, manifestDigest, summary: 'spv ok' },
    deps,
  );
  expect(spv.accepted).toBe(true);
  const worker = admitWorkerResult(
    { type: 'worker_result', envelope: makeEnvelope() as never },
    deps,
  );
  expect(worker.accepted).toBe(true);
  const cv = admitCVResult(
    {
      type: 'cv_result',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      verdict: 'PASS',
      snapshotDigest: head,
      summary: 'cv pass',
    },
    deps,
  );
  expect(cv.accepted).toBe(true);
  const cvDigest = cv.receipt_ref as string;
  const commit = admitSliceCommit(
    {
      type: 'slice_commit',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      commitSha: head,
      cvReceiptDigest: cvDigest,
    },
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
  return { fx, head };
}

/** Fixed worker envelope for the built host seam / fixture seeding. */
function makeEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: 'tok-s03e-t03',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: TASKS[0],
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/s3-failclosed.spec.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 's03e worker',
  };
}

/** Tamper the first receipt in a category dir (relative to receipts/) so its chain breaks. */
function tamperCategory(root: string, categoryRel: string): void {
  const dir = path.join(root, '.proofloop', 'receipts', categoryRel);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  expect(files.length).toBeGreaterThan(0);
  const firstPath = path.join(dir, files[0]);
  const receipt = JSON.parse(readFileSync(firstPath, 'utf-8')) as Record<string, unknown>;
  receipt.payload = { ...(receipt.payload as Record<string, unknown>), tampered: true };
  writeFileSync(firstPath, JSON.stringify(receipt, null, 2), 'utf-8');
}

// ============================================================
// Cross-tool fail-closed battery (PO-S03-E-04)
// ============================================================

describe('cross-tool fail-closed / no-write / abort battery (PO-S03-E-04)', () => {
  // ── plan tool ────────────────────────────────────────────
  describe('proofloop_plan fail-closed', () => {
    it('unsupported operations (run_gate / stage_plan / gate / e2e / project / unknown) never dispatch; no write', async () => {
      const { fx } = seedPlanning();
      const before = snapshotProtected(fx.root);
      const tools = await registeredTools(fx.root);
      for (const operation of [
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
        'stage_plan',
        'admit_stage_plan',
        'compile_acceptance',
        'run_e2e',
        'prepare_project_review',
        'finalize_project_review',
        'unknown_op',
      ]) {
        const envelope = await tools.proofloop_plan.execute(
          { operation, stage_id: STAGE_ID, manifest_digest: 'a'.repeat(64), summary: 'x' },
          makeToolContext(fx.root),
        );
        expectFailClosed(envelope.output);
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      }
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(receiptCount(fx.root)).toBe(1); // only the STAGE_PLAN fixture fact
    });

    it('invalid schema (compile bad tasks → no publish; initialize missing manifest → no write)', async () => {
      const fx = seedBaseline();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);

      const badTasks = path.join(fx.root, 'bad-tasks.md');
      writeFileSync(badTasks, '# Stage S03\n\n<!-- SLICE:S03-A:BEGIN -->\n', 'utf-8');
      const manifestOut = path.join(fx.root, '.proofloop', 'manifests', 'S3-bad.json');
      const comp = await tools.proofloop_plan.execute(
        { operation: 'compile', tasks_path: badTasks, manifest_path: manifestOut },
        makeToolContext(fx.root),
      );
      expectFailClosed(comp.output);
      expect(existsSync(manifestOut)).toBe(false);

      const init = await tools.proofloop_plan.execute(
        { operation: 'initialize_evidence', manifest_path: path.join(fx.root, 'missing.json') },
        makeToolContext(fx.root),
      );
      expectFailClosed(init.output);

      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(receiptCount(fx.root)).toBe(0);
    });

    it('path violations (outside-root manifest_path, project_root mismatch, symlink escape) fail closed; no write', async () => {
      const { fx } = seedPlanning();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      const outside = path.join(fx.root, '..', `escape-${Date.now()}.json`);

      const out1 = await tools.proofloop_plan.execute(
        { operation: 'compile', tasks_path: path.join(fx.root, 'delivery', 'stages', STAGE_ID, 'tasks.md'), manifest_path: outside },
        makeToolContext(fx.root),
      );
      expectFailClosed(out1.output);
      expect(out1.output).toContain('HOST.PATH_OUTSIDE_PROJECT');

      const out2 = await tools.proofloop_plan.execute(
        { operation: 'admit_spv_result', stage_id: STAGE_ID, manifest_digest: 'a'.repeat(64), verdict: 'SPV_PASS', summary: 'x', project_root: '/tmp/not-the-root' },
        makeToolContext(fx.root),
      );
      expectFailClosed(out2.output);
      expect(out2.output).toContain('HOST.PROJECT_NOT_TRUSTED');

      // Symlink escape: a symlinked manifest path pointing outside the root.
      const outsideTarget = path.join(tmpdir(), `s03e-t03-outside-${Date.now()}.json`);
      writeFileSync(outsideTarget, '{}', 'utf-8');
      const link = path.join(fx.root, 'link-manifest.json');
      symlinkSync(outsideTarget, link);
      const out3 = await tools.proofloop_plan.execute(
        { operation: 'compile', tasks_path: path.join(fx.root, 'delivery', 'stages', STAGE_ID, 'tasks.md'), manifest_path: link },
        makeToolContext(fx.root),
      );
      expectFailClosed(out3.output);
      expect(out3.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      rmSync(outsideTarget, { force: true });

      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(receiptCount(fx.root)).toBe(1);
    });

    it('SPV refusals (wrong digest / wrong state / duplicate) write zero NEW receipts; broken plan chain fails closed', async () => {
      // Wrong digest on a PLANNING fixture.
      const a = seedPlanning();
      const toolsA = await registeredTools(a.fx.root);
      const beforeA = snapshotProtected(a.fx.root);
      const outA = await toolsA.proofloop_plan.execute(
        { operation: 'admit_spv_result', stage_id: STAGE_ID, manifest_digest: 'b'.repeat(64), verdict: 'SPV_PASS', summary: 'x' },
        makeToolContext(a.fx.root),
      );
      expectFailClosed(outA.output);
      expect(outA.output).toContain('DOMAIN.INVALID_TRANSITION');
      expectProtectedIdentical(beforeA, snapshotProtected(a.fx.root));
      expect(receiptCount(a.fx.root)).toBe(1);

      // Duplicate: stage already SPV-admitted via the runtime → tool refusal.
      const b = seedPlanning();
      const spv = admitSpvResult(
        { type: 'spv_result', stageId: STAGE_ID, manifestDigest: b.manifestDigest, summary: 'first' },
        { projectRoot: b.fx.root },
      );
      expect(spv.accepted).toBe(true);
      const toolsB = await registeredTools(b.fx.root);
      const beforeB = snapshotProtected(b.fx.root);
      const outB = await toolsB.proofloop_plan.execute(
        { operation: 'admit_spv_result', stage_id: STAGE_ID, manifest_digest: b.manifestDigest, verdict: 'SPV_PASS', summary: 'duplicate' },
        makeToolContext(b.fx.root),
      );
      expectFailClosed(outB.output);
      expectProtectedIdentical(beforeB, snapshotProtected(b.fx.root));
      expect(receiptCount(b.fx.root)).toBe(2); // STAGE_PLAN + first SPV_PASS, no new

      // Broken plan chain → admit fails closed (no write). Tampering the
      // STAGE_PLAN payload breaks the category chain, so reconcile no longer
      // derives the legal PLANNING fact → the SPV precheck refuses with
      // DOMAIN.INVALID_TRANSITION (the chain-broken state surfaces via
      // receipt_chain_valid:false in new_state). Either canonical refusal
      // code proves the fail-closed no-write branch.
      const c = seedPlanning();
      tamperCategory(c.fx.root, path.join('plan', STAGE_ID));
      const toolsC = await registeredTools(c.fx.root);
      const beforeC = snapshotProtected(c.fx.root);
      const outC = await toolsC.proofloop_plan.execute(
        { operation: 'admit_spv_result', stage_id: STAGE_ID, manifest_digest: c.manifestDigest, verdict: 'SPV_PASS', summary: 'x' },
        makeToolContext(c.fx.root),
      );
      expectFailClosed(outC.output);
      expect(outC.output).toMatch(
        /DOMAIN\.INVALID_TRANSITION|RUNTIME\.RECEIPT_CHAIN_BROKEN/,
      );
      expect(outC.output).toContain('Receipt: none');
      expect(outC.output).toContain('"receipt_chain_valid":false');
      expectProtectedIdentical(beforeC, snapshotProtected(c.fx.root));
      expect(receiptCount(c.fx.root)).toBe(1);
    });

    it('plan abort: pre-aborted caller propagates AbortError, no write', async () => {
      const { fx } = seedPlanning();
      const controller = new AbortController();
      controller.abort();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      await expect(
        tools.proofloop_plan.execute(
          { operation: 'status', stage_id: STAGE_ID },
          makeToolContext(fx.root, controller.signal),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    });
  });

  // ── stage tool ───────────────────────────────────────────
  describe('proofloop_stage fail-closed', () => {
    it('unsupported operations (run_gate / gate / project / stage_plan / e2e / unknown) never dispatch; no write', async () => {
      const fx = seedBaseline();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      for (const operation of [
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
        'stage_plan',
        'admit_stage_plan',
        'compile_acceptance',
        'run_e2e',
        'prepare_project_review',
        'finalize_project_review',
        'unknown_op',
      ]) {
        const envelope = await tools.proofloop_stage.execute(
          { operation, stage_id: STAGE_ID, slice_id: SLICE_ID },
          makeToolContext(fx.root),
        );
        expectFailClosed(envelope.output);
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      }
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(receiptCount(fx.root)).toBe(0);
    });

    it('invalid envelope / wrong-state / binding / missing-prerequisite refusals write zero NEW receipts', async () => {
      // Invalid envelope (missing required fields) on a baseline fixture.
      const a = seedBaseline();
      const toolsA = await registeredTools(a.root);
      const beforeA = snapshotProtected(a.root);
      const outA = await toolsA.proofloop_stage.execute(
        { operation: 'admit_worker_result', stage_id: STAGE_ID, slice_id: SLICE_ID, envelope: { schemaVersion: 1 } },
        makeToolContext(a.root),
      );
      expectFailClosed(outA.output);
      expectProtectedIdentical(beforeA, snapshotProtected(a.root));
      expect(receiptCount(a.root)).toBe(0);

      // Wrong state: CV on an IN_PROGRESS slice.
      const b = seedBaseline();
      const toolsB = await registeredTools(b.root);
      const beforeB = snapshotProtected(b.root);
      const outB = await toolsB.proofloop_stage.execute(
        { operation: 'admit_cv_result', stage_id: STAGE_ID, slice_id: SLICE_ID, verdict: 'PASS', snapshot_digest: 'c'.repeat(64), summary: 'cv' },
        makeToolContext(b.root),
      );
      expectFailClosed(outB.output);
      expect(outB.output).toContain('DOMAIN.INVALID_TRANSITION');
      expectProtectedIdentical(beforeB, snapshotProtected(b.root));
      expect(receiptCount(b.root)).toBe(0);

      // Wrong binding: SLICE_COMMIT with a wrong CV digest on a READY_FOR_CV slice.
      const c = seedReadyForCv();
      const toolsC = await registeredTools(c.root);
      const beforeC = snapshotProtected(c.root);
      const outC = await toolsC.proofloop_stage.execute(
        { operation: 'admit_slice_commit', stage_id: STAGE_ID, slice_id: SLICE_ID, commit_sha: 'a'.repeat(40), cv_receipt_digest: 'f'.repeat(64) },
        makeToolContext(c.root),
      );
      expectFailClosed(outC.output);
      expectProtectedIdentical(beforeC, snapshotProtected(c.root));
      expect(receiptCount(c.root)).toBe(1); // worker only

      // Missing prerequisite: INTEGRATION without a SLICE_COMMIT.
      const d = seedReadyForCv();
      const cv = admitCVResult(
        { type: 'cv_result', stageId: STAGE_ID, sliceId: SLICE_ID, verdict: 'PASS', snapshotDigest: 'c'.repeat(64), summary: 'cv' },
        { projectRoot: d.root },
      );
      expect(cv.accepted).toBe(true);
      const toolsD = await registeredTools(d.root);
      const beforeD = snapshotProtected(d.root);
      const outD = await toolsD.proofloop_stage.execute(
        { operation: 'admit_integration', stage_id: STAGE_ID, slice_id: SLICE_ID, commit_sha: 'a'.repeat(40) },
        makeToolContext(d.root),
      );
      expectFailClosed(outD.output);
      expectProtectedIdentical(beforeD, snapshotProtected(d.root));
      expect(receiptCount(d.root)).toBe(2); // worker + cv, no new
    });

    it('path violations (outside-root evidenceRef / manifest_path) fail closed; no write', async () => {
      const fx = seedBaseline();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      const out = await tools.proofloop_stage.execute(
        {
          operation: 'admit_worker_result',
          stage_id: STAGE_ID,
          slice_id: SLICE_ID,
          envelope: { ...makeEnvelope(), evidenceRef: '/etc/passwd' },
        },
        makeToolContext(fx.root),
      );
      expectFailClosed(out.output);
      expect(out.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(receiptCount(fx.root)).toBe(0);
    });

    it('stage abort: pre-aborted caller propagates AbortError, no write', async () => {
      const fx = seedBaseline();
      const controller = new AbortController();
      controller.abort();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      await expect(
        tools.proofloop_stage.execute(
          { operation: 'status', stage_id: STAGE_ID },
          makeToolContext(fx.root, controller.signal),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    });
  });

  // ── review tool ──────────────────────────────────────────
  describe('proofloop_review fail-closed', () => {
    it('unsupported operations (project / gate / stage_plan / e2e / unknown) never dispatch; no write', async () => {
      const fx = seedBaseline();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      for (const operation of [
        'prepare_project_review',
        'finalize_project_review',
        'project_status',
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
        'stage_plan',
        'admit_stage_plan',
        'compile_acceptance',
        'run_e2e',
        'unknown_op',
      ]) {
        const envelope = await tools.proofloop_review.execute(
          { operation, stage_id: STAGE_ID },
          makeToolContext(fx.root),
        );
        expectFailClosed(envelope.output);
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      }
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(receiptCount(fx.root)).toBe(0);
    });

    it('finalize refusals (wrong state / empty summary / duplicate after ACCEPTED) write no NEW receipt', async () => {
      // Wrong state: finalize ACCEPTED on a PLANNING fixture.
      const a = seedPlanning();
      const toolsA = await registeredTools(a.fx.root);
      const beforeA = snapshotProtected(a.fx.root);
      const outA = await toolsA.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(a.fx.root),
      );
      expectFailClosed(outA.output);
      expectProtectedIdentical(beforeA, snapshotProtected(a.fx.root));
      expect(receiptCount(a.fx.root)).toBe(1); // STAGE_PLAN only

      // Empty summary on UNDER_REVIEW.
      const b = seedUnderReview();
      const toolsB = await registeredTools(b.fx.root);
      const beforeB = snapshotProtected(b.fx.root);
      const outB = await toolsB.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: '' },
        makeToolContext(b.fx.root),
      );
      expectFailClosed(outB.output);
      expect(outB.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expectProtectedIdentical(beforeB, snapshotProtected(b.fx.root));

      // Duplicate finalize after ACCEPTED → no second receipt.
      const c = seedUnderReview();
      const toolsC = await registeredTools(c.fx.root);
      const first = await toolsC.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(c.fx.root),
      );
      expect(first.output).toContain('Status: ok');
      const beforeC = snapshotProtected(c.fx.root);
      const second = await toolsC.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(c.fx.root),
      );
      expectFailClosed(second.output);
      expectProtectedIdentical(beforeC, snapshotProtected(c.fx.root));
      // 6 chain facts (STAGE_PLAN/SPV_PASS/TASK_COMPLETE/CV_PASS/
      // SLICE_COMMIT/INTEGRATION_PASS) + 1 STAGE_REVIEW_PASS; the duplicate
      // wrote NO second review receipt.
      expect(receiptCount(c.fx.root)).toBe(7);
    });

    it('prepare fails closed on a tampered CV chain with no write', async () => {
      const { fx } = seedUnderReview();
      tamperCategory(fx.root, path.join('cv', STAGE_ID, SLICE_ID));
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      const out = await tools.proofloop_review.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
        makeToolContext(fx.root),
      );
      expectFailClosed(out.output);
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    });

    it('finalize REPAIR is the legal no-Receipt branch: accepted, null ref, warn finding, no write', async () => {
      const { fx } = seedUnderReview();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      const out = await tools.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        makeToolContext(fx.root),
      );
      expect(out.output).toContain('Status: ok');
      expect(out.output).toContain('DOMAIN.INVALID_TRANSITION');
      expect(out.output).toContain('Receipt: none');
      expectProtectedIdentical(before, snapshotProtected(fx.root));
      expect(existsSync(path.join(fx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
    });

    it('review abort: pre-aborted caller propagates AbortError, no write', async () => {
      const fx = seedBaseline();
      const controller = new AbortController();
      controller.abort();
      const tools = await registeredTools(fx.root);
      const before = snapshotProtected(fx.root);
      await expect(
        tools.proofloop_review.execute(
          { operation: 'stage_status', stage_id: STAGE_ID },
          makeToolContext(fx.root, controller.signal),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expectProtectedIdentical(before, snapshotProtected(fx.root));
    });
  });
});

// ============================================================
// Admission-pipeline-only static guard (PO-S03-E-04)
// ============================================================

describe('admission-pipeline-only static guard (PO-S03-E-04)', () => {
  const PRODUCTION_SOURCES = [
    'index.ts',
    'tools/plan.ts',
    'tools/plan-common.ts',
    'tools/plan-compile.ts',
    'tools/plan-initialize.ts',
    'tools/plan-status.ts',
    'tools/plan-spv-admit.ts',
    'tools/stage.ts',
    'tools/stage-admit-common.ts',
    'tools/stage-admit.ts',
    'tools/review.ts',
    'tools/review-prepare.ts',
    'tools/review-finalize.ts',
    'tools/review-common.ts',
  ];

  it.each(PRODUCTION_SOURCES)(
    'production plugin module %s contains no child_process / spawn / exec / CLI invocation',
    (file) => {
      const src = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), file),
        'utf8',
      );
      expect(src).not.toMatch(/node:child_process/);
      expect(src).not.toMatch(/\bchild_process\b/);
      expect(src).not.toMatch(/\bspawn\s*\(/);
      expect(src).not.toMatch(/\bexec(File|FileSync|Sync)?\s*\(/);
      expect(src).not.toMatch(/process\.execPath/);
      expect(src).not.toMatch(/dist\/cli/);
      expect(src).not.toMatch(/\bshell\s*:/);
    },
  );

  it.each(PRODUCTION_SOURCES)(
    'production plugin module %s never calls writeReceipt / runAdmitPipeline directly',
    (file) => {
      const src = readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), file),
        'utf8',
      );
      // The ONLY Receipt creation path is the runtime admit methods the plugin
      // calls IN-PROCESS; the kernel ReceiptWriter / runAdmitPipeline are never
      // invoked from the plugin layers.
      expect(src).not.toMatch(/writeReceipt\s*\(/);
      expect(src).not.toMatch(/runAdmitPipeline\s*\(/);
    },
  );

  it('runtime runAdmitPipeline is the single writer path and the plugin reaches it only through the admit methods', () => {
    const runtimeAdmit = readFileSync(
      path.join(process.cwd(), 'packages', 'runtime', 'src', 'admit-pipeline.ts'),
      'utf8',
    );
    const runtimeAdmission = readFileSync(
      path.join(process.cwd(), 'packages', 'runtime', 'src', 'admission.ts'),
      'utf8',
    );
    // runAdmitPipeline is defined in the runtime pipeline module.
    expect(runtimeAdmit).toMatch(/export function runAdmitPipeline/);
    // The S2/S3 admit methods dispatch through runAdmitPipeline (the writer).
    expect(runtimeAdmit).toMatch(/runAdmitPipeline\(/);
    // admission.ts reaches the pipeline via the runtime admit methods (import).
    expect(runtimeAdmission).toMatch(/import .*runAdmitPipeline/);
    // The plugin layers only reach the runtime admit methods (never the
    // kernel ReceiptWriter): the plugin must not CALL writeReceipt directly.
    // (Doc comments legitimately mention the forbidden name; a CALL
    // expression `writeReceipt(` is the forbidden bypass — same pattern as
    // the S03-B static guard.)
    const stageSrc = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'stage.ts'),
      'utf8',
    );
    expect(stageSrc).not.toMatch(/writeReceipt\s*\(/);
    expect(stageSrc).not.toMatch(/new ReceiptWriter/);
  });
});

// ============================================================
// S2 read-only regression (PO-S03-E-05)
// ============================================================

describe('S2 read-only regression after S3 registry expansion (PO-S03-E-05)', () => {
  it('built plan validate / stage status+next / review stage_status remain read-only: no receipts/runtime mutation', async () => {
    const { fx } = seedUnderReview();
    // Overwrite the minimal fixture tasks.md with a canonical single-slice
    // tasks.md (the validate op requires the canonical stage/slice sections).
    fx.write(
      `delivery/stages/${STAGE_ID}/tasks.md`,
      `# Stage S03 — S3 Fail-Closed

## Stage Goal

Fail-closed battery stage.

## Observable Outcomes

- OUT-01: no write on fail branches

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Slice S03-A

<!-- SLICE:S03-A:BEGIN -->

### Goal

Slice A goal.

### Observable Outcome

Slice A observable outcome.

### Public Seam

Seam A.

### Dependencies

- 无内部依赖。

### Risk Facts

- persistent_state: true

### Proof Obligations

- PO-S03-A-01
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X.
  - Required Observation: observe X.

### Tasks

- [x] S03-A-T01: task one
- [x] S03-A-T02: task two

<!-- SLICE:S03-A:END -->
`,
    );
    const before = snapshotProtected(fx.root);
    const tools = await registeredTools(fx.root);

    const validate = await tools.proofloop_plan.execute(
      { operation: 'validate', tasks_path: path.join(fx.root, 'delivery', 'stages', STAGE_ID, 'tasks.md'), manifest_path: path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`) },
      makeToolContext(fx.root),
    );
    expect(validate.output).toContain('Status: ok');
    const stageStatus = await tools.proofloop_stage.execute(
      { operation: 'status', stage_id: STAGE_ID },
      makeToolContext(fx.root),
    );
    expect(stageStatus.output).toContain('Status: ok');
    const next = await tools.proofloop_stage.execute(
      { operation: 'next', stage_id: STAGE_ID },
      makeToolContext(fx.root),
    );
    expect(next.output).toContain('Status: ok');
    const reviewStatus = await tools.proofloop_review.execute(
      { operation: 'stage_status', stage_id: STAGE_ID },
      makeToolContext(fx.root),
    );
    expect(reviewStatus.output).toContain('Status: ok');

    expectProtectedIdentical(before, snapshotProtected(fx.root));
    // Read-only outputs never fabricate Receipt refs or leak bodies.
    for (const out of [validate.output, stageStatus.output, next.output, reviewStatus.output]) {
      expect(out).not.toContain('receipt_ref');
      expect(out).not.toContain('"payload"');
    }
  });

  it('built load exposes NO S4/S5 capability keys (hooks / proofloop_project / run_gate / role matrix)', async () => {
    const { fx } = seedPlanning();
    const entry = await loadBuilt();
    const plugin = (entry.default ?? entry.server) as (
      input: PluginInputShape,
    ) => Promise<{ tool: Record<string, unknown> }>;
    const hooks = await plugin(pluginInput(fx.root));
    expect(Object.keys(hooks)).toEqual(['tool']);
    const keys = Object.keys(hooks.tool);
    expect([...keys].sort()).toEqual(['proofloop_doctor', 'proofloop_plan', 'proofloop_review', 'proofloop_stage']);
    for (const forbidden of [
      'proofloop_project',
      'run_gate',
      'gate',
      'authorization',
      'role_policy',
      'roles',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
