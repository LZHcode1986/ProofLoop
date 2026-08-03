/**
 * @proofloop/opencode-plugin — proofloop_stage S3 post-admission TOCTOU
 * fault-injection proof (CV repair
 * STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT; PO-S03-E-04).
 *
 * The CV counterexample: `runStageAdmit()` persisted the Receipt via
 * `dispatchAdmit()` BEFORE `reverifyManifestContentAfterRead()` /
 * `reverifyManifestPathIdentity()`; if the manifest or path changed after
 * admission, it returned a failed ToolResult while the Receipt remained
 * persisted — violating failure/no-write semantics.
 *
 * The repair applies the S03-C/S03-D-established closure to ALL FOUR stage
 * admit operations (admit_worker_result / admit_cv_result / admit_slice_commit
 * / admit_integration): ALL hard verification (reverifyStagePaths + manifest
 * path identity + manifest content trust-root baseline) runs BEFORE the
 * runtime admit; the post-admission manifest re-verify is DIAGNOSTIC-ONLY
 * (warn finding appended, NEVER flips an admitted result to a failure with a
 * persisted receipt — the admitted Receipt is the completed durable outcome,
 * snapshot-at-admission semantics).
 *
 * Fault-injection seam (S03-C `PlanSpvAdmitDeps` / S03-D `ReviewFinalizeDeps`
 * pattern): the REAL built `createStageTool(...)` factory accepts the
 * documented TEST-ONLY `StageAdmitDeps` (`beforeAdmit` / `afterAdmit`); the
 * CALL is the real built `execute` host envelope. Tests inject:
 *   1. a manifest swap BEFORE the runtime call (malicious / slice-drop content
 *      written before execute) → NO write, fail closed (pre-admission guard /
 *      runtime precheck refuses);
 *   2. a swap BETWEEN pre-admission verification and the runtime call via
 *      `beforeAdmit` → NO write (identity/digest closure — the runtime
 *      admission-time reconcile derives the state from the swapped manifest
 *      and refuses);
 *   3. a swap AFTER the runtime wrote via `afterAdmit` → DIAGNOSTIC-ONLY warn,
 *      receipt retained, NEVER a failure result accompanying a persisted
 *      Receipt (assert: when the ToolResult is accepted, the receipt IS
 *      persisted and the manifest change surfaces as a warn finding only).
 *
 * The production plugin never shells the CLI and never writes Receipts
 * directly — the runtime admit methods are the ONLY creation path (the
 * S03-E admission-pipeline static guard asserts this).
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  admitCVResult,
  admitIntegration,
  admitSliceCommit,
  admitWorkerResult,
  reconcileStage,
} from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import { RUNTIME_LOCK_EXPECTATIONS } from '../runtime-lock.js';

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

type BuiltExecuteTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: ToolContextShape,
  ) => Promise<{ output: string }>;
};

type StageAdmitDepsShape = { beforeAdmit?: () => void; afterAdmit?: () => void };

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
// Built plugin load + REAL built stage tool with deps seam
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

function makeToolContext(root: string): ToolContextShape {
  return {
    sessionID: 'sess-s03e-toctou',
    messageID: 'msg-s03e-toctou',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/**
 * Build the stage tool with the documented TEST-ONLY admit deps routed through
 * the REAL built `createStageTool` factory (CV test-seam compliance): the
 * fault-injection `beforeAdmit` / `afterAdmit` hooks flow into the BUILT
 * default admit handlers and the CALL is the real `execute` host envelope.
 */
function makeBuiltStageToolWithDeps(
  plugin: BuiltEntry,
  root: string,
  deps: StageAdmitDepsShape,
): BuiltExecuteTool {
  const createCtx = plugin['createRuntimeContext'] as (input: unknown) => unknown;
  const factory = plugin['createStageTool'] as (
    context: unknown,
    h?: unknown,
    z?: unknown,
    admitDeps?: StageAdmitDepsShape,
  ) => BuiltExecuteTool;
  return factory(createCtx(pluginInput(root)), undefined, undefined, deps);
}

// ============================================================
// Fixture builder (active ProofLoop worktree with valid lock)
// ============================================================

interface Fx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(manifestOverride?: (m: Manifest) => void): void;
  writeTasksMd(sliceId: string, taskIds: readonly string[], checked: readonly string[]): void;
  writeEvidence(sliceId: string, taskIds: readonly string[], finalized: boolean): void;
  commitAll(message?: string): void;
  cleanup(): void;
}

function makeFx(prefix = 's03e-toctou-'): Fx {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03e@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03E TOCTOU']);
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
    writeManifest: (override) => {
      const sliceDef: ManifestSlice = {
        slice_id: SLICE_ID,
        goal: 'S3 post-admission TOCTOU battery',
        observable_outcome: 'no failure result accompanies a persisted Receipt',
        public_seam: 'Hooks.tool built host seam',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-E-04',
            behavior: 'post-admission TOCTOU is diagnostic-only',
            public_seam: 'built stage tool execute',
            oracle_source: 'real fixture project',
            success_criteria: 'receipt retained + warn finding, never a failure flip',
            required_observation: 'fixture oracle',
            applicable_risk_facts: ['persistent_state', 'core_state_machine'],
          },
        ],
        tasks: [...TASKS],
        risk_facts: ['persistent_state'],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
        cv_minimum_level: 'enhanced',
      };
      const manifest: Manifest = {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 post-admission TOCTOU battery',
        outcomes: ['no failure flip'],
        slices: [sliceDef],
        dependencies: [],
        risk_facts: [],
      };
      if (override) override(manifest);
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (sliceId, taskIds, checked) => {
      const lines = taskIds.map((t) => `- [${checked.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      fx.write(
        `delivery/stages/${STAGE_ID}/tasks.md`,
        `# Stage ${STAGE_ID} — S3 TOCTOU\n\n## Slice ${sliceId}\n<!-- SLICE:${sliceId}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n<!-- SLICE:${sliceId}:END -->\n`,
      );
    },
    writeEvidence: (sliceId, taskIds, finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n## Task Evidence\n\n${taskIds.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-E-04 | stage-admit-toctou.spec.ts | yes | yes | pass |\n\n` +
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

/** Baseline stage fixture (checked tasks + finalized evidence → IN_PROGRESS). */
function seedBaseline(): Fx {
  const fx = makeFx('s03e-toctou-base-');
  fx.writeManifest();
  fx.writeTasksMd(SLICE_ID, TASKS, TASKS);
  fx.writeEvidence(SLICE_ID, TASKS, true);
  fx.commitAll('baseline');
  return fx;
}

/** READY_FOR_CV fixture: baseline + worker finalize-slice (for cv_result). */
function seedWorker(): Fx {
  const fx = seedBaseline();
  const w = admitWorkerResult(
    { type: 'worker_result', envelope: makeEnvelope() as never },
    { projectRoot: fx.root },
  );
  expect(w.accepted).toBe(true);
  return fx;
}

/** CV_PASSED fixture: baseline + worker + CV PASS (for slice_commit). */
function seedCv(): { fx: Fx; cvDigest: string } {
  const fx = seedWorker();
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
  return { fx, cvDigest: cv.receipt_ref as string };
}

/** COMMITTED fixture: baseline + worker + CV + SLICE_COMMIT (for integration). */
function seedCommitted(): Fx {
  const { fx, cvDigest } = seedCv();
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
  return fx;
}

/** Fixed worker envelope for fixture seeding / the built host seam. */
function makeEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: 'tok-s03e-toctou',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: TASKS[0],
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/stage-admit-toctou.spec.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 's03e worker',
  };
}

/** The manifest file path for a fixture. */
function manifestPathOf(root: string): string {
  return path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
}

/** Read the current manifest JSON from the fixture. */
function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(manifestPathOf(root), 'utf-8')) as Manifest;
}

/** Write a malicious manifest (non-canonical slice_id / outside-root evidence). */
function writeMaliciousManifest(root: string): void {
  const m = readManifest(root);
  m.slices[0].evidence_path = '../../outside-evidence.md';
  writeFileSync(manifestPathOf(root), JSON.stringify(m, null, 2), 'utf-8');
}

/** Write a manifest whose slice set is EMPTY (runtime reconcile refuses). */
function writeSliceDropManifest(root: string): void {
  const m = readManifest(root);
  m.slices = [];
  writeFileSync(manifestPathOf(root), JSON.stringify(m, null, 2), 'utf-8');
}

/** Write a manifest whose content changed but remains schema-valid. */
function writeContentSwapManifest(root: string): void {
  const m = readManifest(root);
  m.stage_goal = 'SWAPPED after admission (post-admission diagnostic)';
  writeFileSync(manifestPathOf(root), JSON.stringify(m, null, 2), 'utf-8');
}

/** Extract the canonical `Data:` payload from the execute host output. */
function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
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

// ============================================================
// Fault-injection matrix (PO-S03-E-04)
// ============================================================

interface OperationCase {
  readonly operation: string;
  /** Build the operation-specific wire args from the seeded fixture. */
  readonly buildExtra: (fx: Fx) => Record<string, unknown>;
  readonly seed: () => Fx;
  readonly label: string;
}

const OPERATIONS: readonly OperationCase[] = [
  {
    operation: 'admit_worker_result',
    buildExtra: () => ({ envelope: makeEnvelope() }),
    seed: () => seedBaseline(),
    label: 'worker_result',
  },
  {
    operation: 'admit_cv_result',
    buildExtra: () => ({ verdict: 'PASS', snapshot_digest: 'c'.repeat(64), summary: 'cv pass' }),
    seed: () => seedWorker(),
    label: 'cv_result',
  },
  {
    operation: 'admit_slice_commit',
    // The CV receipt digest binding must match the fixture's REAL CV_PASS
    // receipt (seedCv() already persisted it), so the admit succeeds.
    buildExtra: (fx) => ({
      commit_sha: 'a'.repeat(40),
      cv_receipt_digest: seedCvDigestOf(fx),
    }),
    seed: () => seedCv().fx,
    label: 'slice_commit',
  },
  {
    operation: 'admit_integration',
    buildExtra: () => ({ commit_sha: 'a'.repeat(40) }),
    seed: () => seedCommitted(),
    label: 'integration',
  },
];

/** Read the CV_PASS receipt digest from a fixture that has one. */
function seedCvDigestOf(fx: Fx): string {
  const dir = path.join(fx.root, '.proofloop', 'receipts', 'cv', STAGE_ID, SLICE_ID);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const receipt = JSON.parse(readFileSync(path.join(dir, files[0]), 'utf-8')) as {
    digest: string;
    type: string;
  };
  expect(receipt.type).toBe('CV_PASS');
  return receipt.digest;
}

describe('stage admit post-admission TOCTOU fault injection (PO-S03-E-04)', () => {
  it.each(OPERATIONS)(
    '$label: manifest swap BEFORE the runtime call (malicious content) → NO write, fail closed',
    async ({ operation, buildExtra, seed }) => {
      const fx = seed();
      // Write a MALICIOUS manifest (outside-root evidence_path) BEFORE the
      // built host execute: the plugin's pre-admission manifest content guard
      // (S2-F-001) must fail closed BEFORE any runtime write.
      writeMaliciousManifest(fx.root);
      const before = receiptCount(fx.root);
      const plugin = await loadBuilt();
      const tool = makeBuiltStageToolWithDeps(plugin, fx.root, {});
      const envelope = await tool.execute(
        { operation, stage_id: STAGE_ID, slice_id: SLICE_ID, ...buildExtra(fx) },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(receiptCount(fx.root)).toBe(before);
    },
  );

  it.each(OPERATIONS)(
    '$label: swap between pre-admission verification and the runtime call (beforeAdmit) → NO write (identity/digest closure)',
    async ({ operation, buildExtra, seed }) => {
      const fx = seed();
      const plugin = await loadBuilt();
      // The `beforeAdmit` test-only seam swaps the manifest AFTER the plugin's
      // pre-admission verification passed and IMMEDIATELY BEFORE the runtime
      // dispatch. The runtime admission-time reconcile derives the state from
      // the swapped (slice-drop) manifest → STAGE_NOT_FOUND → refuses, NO write.
      const tool = makeBuiltStageToolWithDeps(plugin, fx.root, {
        beforeAdmit: () => {
          writeSliceDropManifest(fx.root);
        },
      });
      const before = receiptCount(fx.root);
      const envelope = await tool.execute(
        { operation, stage_id: STAGE_ID, slice_id: SLICE_ID, ...buildExtra(fx) },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
      expect(receiptCount(fx.root)).toBe(before);
    },
  );

  it.each(OPERATIONS)(
    '$label: swap AFTER the runtime wrote (afterAdmit) → diagnostic-only warn, receipt retained, NEVER a failure flip',
    async ({ operation, buildExtra, seed }) => {
      const fx = seed();
      const plugin = await loadBuilt();
      // The `afterAdmit` test-only seam swaps the manifest AFTER the runtime
      // admit persisted the Receipt and BEFORE the post-admission diagnostic
      // re-verify. The admitted result must NOT flip to a failure while the
      // Receipt is persisted — the manifest change surfaces as a warn finding.
      const tool = makeBuiltStageToolWithDeps(plugin, fx.root, {
        afterAdmit: () => {
          writeContentSwapManifest(fx.root);
        },
      });
      const before = receiptCount(fx.root);
      const envelope = await tool.execute(
        { operation, stage_id: STAGE_ID, slice_id: SLICE_ID, ...buildExtra(fx) },
        makeToolContext(fx.root),
      );
      const data = parseData(envelope.output);
      // The admitted result stays ok/accepted with a persisted receipt.
      expect(data.accepted).toBe(true);
      expect((data.receipt_ref as { digest?: string } | null)?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(receiptCount(fx.root)).toBe(before + 1);
      // The manifest change is a warn diagnostic — never an error-level flip.
      const findings = data.findings as Array<{ severity: string; code: string }>;
      const warns = findings.filter((f) => f.severity === 'warn');
      expect(warns.length).toBeGreaterThanOrEqual(1);
      expect(warns[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(findings.filter((f) => f.severity === 'error')).toHaveLength(0);
      // The host envelope reports ok (a warn is recoverable, never a failure).
      expect(envelope.output).toContain('Status: ok');
      expect(envelope.output).toContain('post-admission diagnostic');
      // Fresh reconcile still sees the persisted receipt (chain intact).
      const reconciled = reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID });
      expect(reconciled.receipt_chain_valid).toBe(true);
    },
  );

  it('no operation bypasses the runtime admission pipeline (static re-assert for the four admits)', async () => {
    const { readFileSync: read } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = read(path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage-admit.ts'), 'utf8');
    expect(src).not.toMatch(/writeReceipt\s*\(/);
    expect(src).not.toMatch(/runAdmitPipeline\s*\(/);
    expect(src).not.toMatch(/node:child_process/);
  });
});
