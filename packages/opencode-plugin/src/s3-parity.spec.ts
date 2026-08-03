/**
 * @proofloop/opencode-plugin — S3 cross-tool parity harness (S03-E-T02,
 * PO-S03-E-02 / PO-S03-E-03).
 *
 * ONE cross-tool spec proving the plugin and the CLI/runtime oracle agree on
 * the selected S3 plan/stage/review operations at the canonical field level:
 * compile / initialize_evidence / the four stage admits / SPV admit / review
 * prepare + finalize ACCEPTED + REPAIR / plan-stage-review status.
 *
 * Seam (slice Public Seam): the BUILT plugin entry
 * (`packages/opencode-plugin/dist/index.js`) is loaded through a file URL and
 * invoked on real temp ProofLoop fixtures; the REGISTERED `Hooks.tool` tools
 * (`proofloop_plan` / `proofloop_stage` / `proofloop_review`) are exercised
 * through their real `execute` host seam. No plugin module is mocked; no
 * source import substitutes the built load for the registration/parity.
 *
 * CLI oracles (TEST-ONLY — the production plugin never shells the CLI):
 *   - `packages/runtime/dist/cli/compile-manifest.js` (spawned subprocess);
 *   - `packages/runtime/dist/cli/initialize-slice-evidence.js` (subprocess);
 *   - `admitRequest` from `@proofloop/runtime/dist/cli/admit.js` (in-process
 *     import of the CLI admit entry used as the admit oracle).
 *
 * Deterministic timestamp strategy:
 *   - admit operations freeze time (`vi.useFakeTimers` + fixed `FROZEN_NOW`)
 *     so the plugin (in-process) and the `admitRequest` oracle (in-process)
 *     produce IDENTICAL receipt timestamps → identical digests and identical
 *     receipt file bytes;
 *   - fixtures that bind git facts (review UNDER_REVIEW chain, SPV PLANNING)
 *     commit with fixed `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` so two
 *     byte-identical fixtures yield identical SHAs → identical receipts;
 *   - compile parity strips the volatile manifest fields (compiled_at /
 *     compiled_by / source_path) and compares the canonical content + digest.
 *
 * Chain / readback: after each admit the receiving category chain is verified
 * with the kernel `verifyReceiptChain` seam, the `previous_digest` link is
 * asserted where a category gains a second receipt (SPV_PASS → STAGE_PLAN),
 * and a fresh `reconcileStage` readback reflects the persisted facts.
 */

import { describe, expect, it, beforeAll, afterEach, beforeEach, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  admitSpvResult,
  admitStagePlan,
  admitWorkerResult,
  canonicalManifestDigest,
  manifestFileDigest,
  readReceiptCategory,
  reconcileStage,
} from '@proofloop/runtime';
import { verifyReceiptChain } from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import { RUNTIME_LOCK_EXPECTATIONS } from './runtime-lock.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-A';
const TASKS: readonly string[] = ['S03-A-T01', 'S03-A-T02'];
const FROZEN_NOW = new Date('2026-08-03T00:00:00.000Z');

const DIST_ENTRY = path.join(
  process.cwd(),
  'packages',
  'opencode-plugin',
  'dist',
  'index.js',
);
const DIST_COMPILE_CLI = path.join(
  process.cwd(),
  'packages',
  'runtime',
  'dist',
  'cli',
  'compile-manifest.js',
);
const DIST_INIT_CLI = path.join(
  process.cwd(),
  'packages',
  'runtime',
  'dist',
  'cli',
  'initialize-slice-evidence.js',
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
  vi.useRealTimers();
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
  expect(existsSync(DIST_COMPILE_CLI)).toBe(true);
  expect(existsSync(DIST_INIT_CLI)).toBe(true);
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

function makeToolContext(root: string): ToolContextShape {
  return {
    sessionID: 'sess-s03e-t02',
    messageID: 'msg-s03e-t02',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
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
// Shared parity helpers
// ============================================================

/** Extract the canonical `Data:` payload from the execute host output. */
function extractDataLine(output: string): Record<string, unknown> {
  const match = output.match(/^Data: (.+)$/m);
  expect(match, `expected a Data: line in:\n${output}`).toBeTruthy();
  return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
}

/** Extract the status summary block (between `Stage status:` and Data/Findings). */
function extractStatusBlock(output: string): string {
  const lines = output.split('\n');
  const labelIdx = lines.findIndex((l) => l === 'Stage status:');
  expect(labelIdx, `expected Stage status: in\n${output}`).toBeGreaterThanOrEqual(0);
  const block: string[] = [];
  for (let i = labelIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith('Data: ') || line.startsWith('Findings')) break;
    block.push(line);
  }
  return block.join('\n');
}

/** sha256 hex digest of a file's bytes. */
function fileDigest(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

/** sha256 hex digest of a buffer. */
function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Canonical manifest with volatile fields stripped (deterministic parity). */
function stableManifest(manifest: Manifest): Manifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as Manifest;
  const rec = copy as unknown as Record<string, unknown>;
  delete rec.compiled_at;
  delete rec.compiled_by;
  delete rec.source_path;
  return copy;
}

/** Same bounded new_state projection the plugin exposes (projectAdmitNewState). */
function projectCliNewState(state: unknown): unknown {
  if (state === null || state === undefined) return state;
  const s = state as Record<string, unknown>;
  const slices = (s.slices as Array<Record<string, unknown>>).map((sl) => ({
    slice_id: sl.slice_id,
    slice_state: sl.slice_state,
    cv_status: sl.cv_status,
    complete: sl.complete,
    integrated: sl.integrated,
    committed: sl.committed,
  }));
  return {
    stage_id: s.stage_id,
    stage_state: s.stage_state,
    project_state: s.project_state,
    receipt_chain_valid: s.receipt_chain_valid,
    slices,
  };
}

/** Recursively snapshot `.proofloop/receipts/**` (rel path → sha256). */
function snapshotReceipts(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, base: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const content = readFileSync(abs);
        map.set(rel, sha256Hex(content));
      }
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'), '.proofloop/receipts');
  return map;
}

/** Read every receipt JSON file in a category directory (sorted by name). */
function readCategoryReceipts(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as Record<string, unknown>);
}

/** Deterministic git commit environment (fixed dates → identical SHAs). */
function gitCommitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z',
  };
}

// ============================================================
// Fixture builder (active ProofLoop worktree with valid lock)
// ============================================================

interface Fx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(sliceId: string, taskIds: readonly string[], riskFacts?: readonly string[]): void;
  writeTasksMd(sliceId: string, taskIds: readonly string[], checked: readonly string[]): void;
  writeEvidence(sliceId: string, taskIds: readonly string[], finalized: boolean): void;
  writeAuthorityDocs(): void;
  commitAll(message?: string): void;
  cleanup(): void;
}

function makeFx(prefix = 's03e-t02-'): Fx {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03e@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03E T02']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });

  // Valid runtime.lock → the BUILT plugin registers the active tools.
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
    writeManifest: (sliceId, taskIds, riskFacts = ['persistent_state']) => {
      const sliceDef: ManifestSlice = {
        slice_id: sliceId,
        goal: 'Executor 受理 Slice 结果并写入 Receipt',
        observable_outcome: 'deterministic admits with chain-verified receipts',
        public_seam: 'Hooks.tool built host seam',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-E-02',
            behavior: 'plugin and CLI/runtime oracle agree on canonical admit fields',
            public_seam: 'built stage tool execute',
            oracle_source: 'real fixture project',
            success_criteria: 'receipt chain valid + reconcile readback',
            required_observation: 'fixture oracle',
            applicable_risk_facts: ['persistent_state', 'core_state_machine'],
          },
        ],
        tasks: [...taskIds],
        risk_facts: [...riskFacts],
        evidence_path: `delivery/stages/${STAGE_ID}/evidence/${sliceId}.md`,
        cv_minimum_level: 'enhanced',
      };
      const manifest: Manifest = {
        stage_id: STAGE_ID,
        source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 cross-tool parity host boundary',
        outcomes: ['selected plan/stage/review parity'],
        slices: [sliceDef],
        dependencies: [],
        risk_facts: [...riskFacts],
      };
      fx.write(`.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (sliceId, taskIds, checked) => {
      const lines = taskIds.map((t) => `- [${checked.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      fx.write(
        `delivery/stages/${STAGE_ID}/tasks.md`,
        `# Stage ${STAGE_ID} — S3 Parity\n\n## Slice ${sliceId}\n<!-- SLICE:${sliceId}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n<!-- SLICE:${sliceId}:END -->\n`,
      );
    },
    writeEvidence: (sliceId, taskIds, finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n## Task Evidence\n\n${taskIds.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-E-02 | s3-parity.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${STAGE_ID}/evidence/${sliceId}.md`, content);
    },
    writeAuthorityDocs: () => {
      fx.write('PRD.md', '# PRD — ProofLoop\n\nGoal-first proof for S3.\n');
      fx.write('tech-spec/contract-state-matrix.md', '# Contract State Matrix\n\nStage review operations §1.3.\n');
    },
    commitAll: (message = 'baseline') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message], {
        env: gitCommitEnv(),
      });
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

/** Baseline stage fixture (checked tasks + finalized evidence → finalize-slice). */
function seedBaseline(): Fx {
  const fx = makeFx('s03e-t02-base-');
  fx.writeManifest(SLICE_ID, TASKS);
  fx.writeTasksMd(SLICE_ID, TASKS, TASKS);
  fx.writeEvidence(SLICE_ID, TASKS, true);
  fx.commitAll('baseline');
  return fx;
}

/** Legal PLANNING stage (manifest + tasks + evidence + STAGE_PLAN fact). */
function seedPlanning(): { fx: Fx; manifestDigest: string } {
  const fx = makeFx('s03e-t02-plan-');
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

/** UNDER_REVIEW stage from a fresh fixture (deterministic full chain). */
function seedUnderReview(): { fx: Fx; head: string; manifestDigest: string } {
  const fx = makeFx('s03e-t02-review-');
  fx.writeManifest(SLICE_ID, TASKS);
  fx.writeTasksMd(SLICE_ID, TASKS, TASKS);
  fx.writeEvidence(SLICE_ID, TASKS, true);
  fx.commitAll('baseline');
  const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
  const manifestDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
  const deps = { projectRoot: fx.root };

  const plan = admitStagePlan(
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest },
    deps,
  );
  expect(plan.accepted).toBe(true);
  const spv = admitSpvResult(
    { type: 'spv_result', stageId: STAGE_ID, manifestDigest, summary: 'spv ok' },
    deps,
  );
  expect(spv.accepted).toBe(true);
  const worker = admitWorkerResult(
    {
      type: 'worker_result',
      envelope: {
        schemaVersion: 1,
        actionToken: 'tok-s03e-t02',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
        taskId: TASKS[0],
        mode: 'finalize-slice',
        outcome: 'completed',
        evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
        changedFiles: ['packages/opencode-plugin/src/s3-parity.spec.ts'],
        verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
        summary: 's03e worker',
      } as never,
    },
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
  return { fx, head, manifestDigest };
}

/** Fixed worker envelope for the built host seam / CLI oracle. */
function makeEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: 'tok-s03e-t02',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: TASKS[0],
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/s3-parity.spec.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 's03e worker',
  };
}

// ============================================================
// CLI oracles
// ============================================================

/** Last stdout line starting with `{` — the CLI initializer's JSON result. */
function cliInitializeJson(stdout: string): { created: string[]; skipped: string[]; errors: string[] } {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .pop();
  expect(line).toBeTruthy();
  return JSON.parse(line ?? '') as { created: string[]; skipped: string[]; errors: string[] };
}

// ============================================================
// 1. Compile parity (PO-S03-E-02)
// ============================================================

describe('compile parity vs CLI compile-manifest oracle (PO-S03-E-02)', () => {
  /** Acyclic 2-slice S03 tasks fixture (mirrors the runtime CLI fixtures). */
  function writeCompileTasks(root: string): string {
    const tasksPath = path.join(root, 'tasks.md');
    writeFileSync(
      tasksPath,
      `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Slice S03-A — Slice A

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

- core_state_machine: true

### Proof Obligations

- PO-S03-A-01
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.

### Tasks

- [ ] S03-A-T01: task one

<!-- SLICE:S03-A:END -->

## Slice S03-B — Slice B

<!-- SLICE:S03-B:BEGIN -->

### Goal

Slice B goal.

### Observable Outcome

Slice B observable outcome.

### Public Seam

Seam B.

### Dependencies

- S03-A

### Risk Facts

- persistent_state: true

### Proof Obligations

- PO-S03-B-01
  - Behavior: Slice B behavior.
  - Public Seam: Seam B.
  - Oracle Source: oracle B.
  - Success / Failure: success when Z.
  - Required Observation: observe Z.

### Tasks

- [ ] S03-B-T01: task one
- [x] S03-B-T02: task two

<!-- SLICE:S03-B:END -->
`,
      'utf-8',
    );
    return tasksPath;
  }

  it('plugin compile data + canonical manifest fields/digest equal the CLI oracle', async () => {
    const { root } = makeFx('s03e-t02-comp-');
    const tasksPath = writeCompileTasks(root);
    const pluginOut = path.join(root, '.proofloop', 'manifests', 'S3-plugin.json');
    const cliOut = path.join(root, '.proofloop', 'manifests', 'S3-cli.json');

    // CLI oracle (test-only): writes the canonical Manifest file, exit 0.
    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    expect(cliRes.stdout).toContain('Stage manifest written');
    const cliManifest = JSON.parse(readFileSync(cliOut, 'utf-8')) as Manifest;

    // Plugin through the REGISTERED built tool execute seam.
    const tools = await registeredTools(root);
    const envelope = await tools.proofloop_plan.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    const pluginManifest = JSON.parse(readFileSync(pluginOut, 'utf-8')) as Manifest;
    const data = extractDataLine(envelope.output);

    // Canonical field parity (stage_id / source_digest / slices / deps /
    // risk_facts / goal / outcomes).
    expect(pluginManifest.stage_id).toBe(cliManifest.stage_id);
    expect(pluginManifest.source_digest).toBe(cliManifest.source_digest);
    expect(pluginManifest.slices).toEqual(cliManifest.slices);
    expect(pluginManifest.dependencies).toEqual(cliManifest.dependencies);
    expect(pluginManifest.risk_facts).toEqual(cliManifest.risk_facts);
    expect(pluginManifest.stage_goal).toBe(cliManifest.stage_goal);
    expect(pluginManifest.outcomes).toEqual(cliManifest.outcomes);

    // Data payload exposes the canonical stage/digest/ref.
    expect(data.stage_id).toBe(cliManifest.stage_id);
    expect(data.source_digest).toBe(cliManifest.source_digest);
    expect(data.manifest_digest).toBe(canonicalManifestDigest(pluginManifest));
    expect(data.manifest_ref).toBe(path.relative(root, pluginOut));

    // Deterministic canonical-content parity: stripping volatile fields
    // (compiled_at / compiled_by / source_path) yields EQUAL canonical digests.
    expect(canonicalManifestDigest(stableManifest(pluginManifest))).toBe(
      canonicalManifestDigest(stableManifest(cliManifest)),
    );
    expect(envelope.output).not.toContain('Receipts:');
  });

  it('plugin compile failure semantics match the CLI oracle (fail closed, no publish)', async () => {
    const { root } = makeFx('s03e-t02-compfail-');
    const tasksPath = writeCompileTasks(root);
    writeFileSync(
      tasksPath,
      readFileSync(tasksPath, 'utf-8').replace('<!-- SLICE:S03-A:END -->', ''),
      'utf-8',
    );
    const cliOut = path.join(root, 'cli-fail.json');
    const pluginOut = path.join(root, 'plugin-fail.json');

    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(1);
    expect(existsSync(cliOut)).toBe(false);

    const tools = await registeredTools(root);
    const envelope = await tools.proofloop_plan.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(existsSync(pluginOut)).toBe(false);
  });
});

// ============================================================
// 2. initialize_evidence parity (PO-S03-E-02)
// ============================================================

describe('initialize_evidence parity vs CLI initializer oracle (PO-S03-E-02)', () => {
  it('plugin { created, skipped, errors } + evidence bytes equal the CLI oracle', async () => {
    const { root } = makeFx('s03e-t02-init-');
    const tasksPath = path.join(root, 'tasks.md');
    writeFileSync(
      tasksPath,
      `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Slice S03-A — Slice A

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

- core_state_machine: true

### Proof Obligations

- PO-S03-A-01
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.

### Tasks

- [ ] S03-A-T01: task one

<!-- SLICE:S03-A:END -->

## Slice S03-B — Slice B

<!-- SLICE:S03-B:BEGIN -->

### Goal

Slice B goal.

### Observable Outcome

Slice B observable outcome.

### Public Seam

Seam B.

### Dependencies

- S03-A

### Risk Facts

- persistent_state: true

### Proof Obligations

- PO-S03-B-01
  - Behavior: Slice B behavior.
  - Public Seam: Seam B.
  - Oracle Source: oracle B.
  - Success / Failure: success when Z.
  - Required Observation: observe Z.

### Tasks

- [ ] S03-B-T01: task one
- [x] S03-B-T02: task two

<!-- SLICE:S03-B:END -->
`,
      'utf-8',
    );
    const outputPath = path.join(root, '.proofloop', 'manifests', 'S3.json');
    const tools = await registeredTools(root);
    const comp = await tools.proofloop_plan.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(comp.output).toContain('Status: ok');
    expect(existsSync(outputPath)).toBe(true);

    // Plugin initialize (REGISTERED built tool).
    const env = await tools.proofloop_plan.execute(
      { operation: 'initialize_evidence', manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(env.output).toContain('Status: ok');
    const pluginData = extractDataLine(env.output);
    const pluginCreated = pluginData.created as string[];
    expect(pluginCreated).toHaveLength(2);
    expect(pluginData.skipped).toEqual([]);
    expect(pluginData.errors).toEqual([]);
    const pluginBytes = new Map(pluginCreated.map((p) => [p, fileDigest(p)]));

    // Reset the evidence dir, then run the CLI oracle on the SAME manifest +
    // delivery root (identical starting state).
    rmSync(path.join(root, 'delivery'), { recursive: true, force: true });
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, outputPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    const cliData = cliInitializeJson(cliRes.stdout);

    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    for (const p of pluginCreated) {
      expect(fileDigest(p), `evidence file bytes differ: ${p}`).toBe(pluginBytes.get(p));
    }
  });
});

// ============================================================
// 3. Four stage admits parity — full chain + readback (PO-S03-E-02)
// ============================================================

describe('four stage admits parity vs CLI admitRequest oracle (PO-S03-E-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  async function pluginAdmit(
    root: string,
    operation: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tools = await registeredTools(root);
    const envelope = await tools.proofloop_stage.execute(
      { operation, stage_id: STAGE_ID, slice_id: SLICE_ID, ...extra },
      makeToolContext(root),
    );
    return extractDataLine(envelope.output);
  }

  it('full chain worker → CV PASS → SLICE_COMMIT → INTEGRATION_PASS matches the CLI oracle step-by-step with chain + fresh readback', async () => {
    const cliFx = seedBaseline();
    const pluginFx = seedBaseline();
    try {
      // ── Step 1: admit_worker_result (finalize-slice) ──
      const cliWorker = admitRequest(
        { type: 'worker_result', envelope: makeEnvelope() as never },
        cliFx.root,
      );
      const pluginWorker = await pluginAdmit(pluginFx.root, 'admit_worker_result', {
        envelope: makeEnvelope(),
      });
      expect(cliWorker.accepted).toBe(true);
      expect(pluginWorker.accepted).toBe(true);
      const cliWDigest = cliWorker.receipt_ref as string;
      expect((pluginWorker.receipt_ref as { digest: string }).digest).toBe(cliWDigest);
      expect((pluginWorker.receipt_ref as { ref: string }).ref).toBe(
        `.proofloop/receipts/tasks/${STAGE_ID}/${SLICE_ID}/${cliWDigest}.json`,
      );
      expect(pluginWorker.new_state).toEqual(projectCliNewState(cliWorker.new_state));
      expect(pluginWorker.findings).toEqual(cliWorker.findings);
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      const tasksDir = path.join(cliFx.root, '.proofloop', 'receipts', 'tasks', STAGE_ID, SLICE_ID);
      expect(verifyReceiptChain(tasksDir).valid).toBe(true);
      const workerReceipts = readCategoryReceipts(tasksDir);
      expect(workerReceipts).toHaveLength(1);
      // finalize-slice worker mode produces the canonical TASK_COMPLETE type.
      expect(workerReceipts[0].type).toBe('TASK_COMPLETE');
      expect(workerReceipts[0].previous_digest).toBeUndefined();
      // Fresh readback: slice READY_FOR_CV on both.
      const r1Cli = reconcileStage({ projectRoot: cliFx.root, stageId: STAGE_ID });
      const r1Plugin = reconcileStage({ projectRoot: pluginFx.root, stageId: STAGE_ID });
      expect(r1Cli.receipt_chain_valid).toBe(true);
      expect(r1Plugin.receipt_chain_valid).toBe(true);
      expect(r1Cli.slices[0].slice_state).toBe('READY_FOR_CV');
      expect(r1Plugin.slices[0].slice_state).toBe(r1Cli.slices[0].slice_state);

      // ── Step 2: admit_cv_result (PASS) ──
      const cliCv = admitRequest(
        {
          type: 'cv_result',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          verdict: 'PASS',
          snapshotDigest: 'c'.repeat(64),
          summary: 'cv pass',
        },
        cliFx.root,
      );
      const pluginCv = await pluginAdmit(pluginFx.root, 'admit_cv_result', {
        verdict: 'PASS',
        snapshot_digest: 'c'.repeat(64),
        summary: 'cv pass',
      });
      expect(cliCv.accepted).toBe(true);
      expect(pluginCv.accepted).toBe(true);
      const cliCvDigest = cliCv.receipt_ref as string;
      expect((pluginCv.receipt_ref as { digest: string }).digest).toBe(cliCvDigest);
      expect(pluginCv.new_state).toEqual(projectCliNewState(cliCv.new_state));
      expect(pluginCv.findings).toEqual(cliCv.findings);
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      const cvDir = path.join(cliFx.root, '.proofloop', 'receipts', 'cv', STAGE_ID, SLICE_ID);
      expect(verifyReceiptChain(cvDir).valid).toBe(true);
      const cvReceipts = readCategoryReceipts(cvDir);
      expect(cvReceipts).toHaveLength(1);
      expect(cvReceipts[0].type).toBe('CV_PASS');
      expect(cvReceipts[0].previous_digest).toBeUndefined();

      // ── Step 3: admit_slice_commit ──
      const cliCommit = admitRequest(
        {
          type: 'slice_commit',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          commitSha: 'a'.repeat(40),
          cvReceiptDigest: cliCvDigest,
        },
        cliFx.root,
      );
      const pluginCommit = await pluginAdmit(pluginFx.root, 'admit_slice_commit', {
        commit_sha: 'a'.repeat(40),
        cv_receipt_digest: cliCvDigest,
      });
      expect(cliCommit.accepted).toBe(true);
      expect(pluginCommit.accepted).toBe(true);
      const cliCommitDigest = cliCommit.receipt_ref as string;
      expect((pluginCommit.receipt_ref as { digest: string }).digest).toBe(cliCommitDigest);
      expect(pluginCommit.new_state).toEqual(projectCliNewState(cliCommit.new_state));
      expect(pluginCommit.findings).toEqual(cliCommit.findings);
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      const committerDir = path.join(
        cliFx.root,
        '.proofloop',
        'receipts',
        'committer',
        STAGE_ID,
        SLICE_ID,
      );
      expect(verifyReceiptChain(committerDir).valid).toBe(true);
      const commitReceipts = readCategoryReceipts(committerDir);
      expect(commitReceipts).toHaveLength(1);
      expect(commitReceipts[0].type).toBe('SLICE_COMMIT');
      expect(commitReceipts[0].previous_digest).toBeUndefined();

      // ── Step 4: admit_integration ──
      const cliIntegration = admitRequest(
        { type: 'integration', stageId: STAGE_ID, sliceId: SLICE_ID, commitSha: 'a'.repeat(40) },
        cliFx.root,
      );
      const pluginIntegration = await pluginAdmit(pluginFx.root, 'admit_integration', {
        commit_sha: 'a'.repeat(40),
      });
      expect(cliIntegration.accepted).toBe(true);
      expect(pluginIntegration.accepted).toBe(true);
      const cliIntDigest = cliIntegration.receipt_ref as string;
      expect((pluginIntegration.receipt_ref as { digest: string }).digest).toBe(cliIntDigest);
      expect(pluginIntegration.new_state).toEqual(projectCliNewState(cliIntegration.new_state));
      expect(pluginIntegration.findings).toEqual(cliIntegration.findings);
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      const integrationDir = path.join(
        cliFx.root,
        '.proofloop',
        'receipts',
        'integration',
        STAGE_ID,
        SLICE_ID,
      );
      expect(verifyReceiptChain(integrationDir).valid).toBe(true);
      const integrationReceipts = readCategoryReceipts(integrationDir);
      expect(integrationReceipts).toHaveLength(1);
      expect(integrationReceipts[0].type).toBe('INTEGRATION_PASS');
      expect(integrationReceipts[0].previous_digest).toBeUndefined();

      // Final fresh reconcile readback — identical on both sides.
      const rFinalCli = reconcileStage({ projectRoot: cliFx.root, stageId: STAGE_ID });
      const rFinalPlugin = reconcileStage({ projectRoot: pluginFx.root, stageId: STAGE_ID });
      expect(rFinalCli.receipt_chain_valid).toBe(true);
      expect(rFinalPlugin.receipt_chain_valid).toBe(true);
      expect(rFinalPlugin.stage_state).toBe(rFinalCli.stage_state);
      expect(rFinalPlugin.slices[0].integrated).toBe(true);
      expect(rFinalCli.slices[0].integrated).toBe(true);
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });

  it('refused CV on a wrong state: accepted:false / null ref / findings deep-equal, zero receipts', async () => {
    const cliFx = seedBaseline(); // slice IN_PROGRESS — not READY_FOR_CV
    const pluginFx = seedBaseline();
    try {
      const cli = admitRequest(
        {
          type: 'cv_result',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          verdict: 'PASS',
          snapshotDigest: 'c'.repeat(64),
          summary: 'cv pass',
        },
        cliFx.root,
      );
      const plugin = await pluginAdmit(pluginFx.root, 'admit_cv_result', {
        verdict: 'PASS',
        snapshot_digest: 'c'.repeat(64),
        summary: 'cv pass',
      });

      expect(cli.accepted).toBe(false);
      expect(plugin.accepted).toBe(false);
      expect(cli.receipt_ref).toBeNull();
      expect(plugin.receipt_ref).toBeNull();
      const pluginFindings = plugin.findings as Array<{ code: string }>;
      expect(cli.findings.map((f) => f.code)).toEqual(pluginFindings.map((f) => f.code));
      expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
      expect(snapshotReceipts(pluginFx.root).size).toBe(0);
      expect(snapshotReceipts(cliFx.root).size).toBe(0);
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });
});

// ============================================================
// 4. SPV admit parity (PO-S03-E-02)
// ============================================================

describe('SPV admit parity vs CLI admitRequest spv-result oracle (PO-S03-E-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });

  it('valid PLANNING: SPV_PASS receipt bytes identical to the CLI oracle, previous_digest → STAGE_PLAN, fresh reconcile EXECUTING', async () => {
    const cliSeed = seedPlanning();
    const pluginSeed = seedPlanning();
    const cliFx = cliSeed.fx;
    const pluginFx = pluginSeed.fx;
    try {
      const summary = 'stage plan approved';
      const cli = admitRequest(
        { type: 'spv_result', stageId: STAGE_ID, manifestDigest: cliSeed.manifestDigest, summary },
        cliFx.root,
      );
      const tools = await registeredTools(pluginFx.root);
      const envelope = await tools.proofloop_plan.execute(
        {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: pluginSeed.manifestDigest,
          verdict: 'SPV_PASS',
          summary,
        },
        makeToolContext(pluginFx.root),
      );
      const plugin = extractDataLine(envelope.output);

      expect(cli.accepted).toBe(true);
      expect(plugin.accepted).toBe(true);
      const cliDigest = cli.receipt_ref as string;
      expect(cliDigest).toMatch(/^[0-9a-f]{64}$/);
      expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
      expect((plugin.receipt_ref as { ref: string }).ref).toBe(
        `.proofloop/receipts/plan/${STAGE_ID}/${cliDigest}.json`,
      );
      expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
      expect(plugin.findings).toEqual(cli.findings);
      // Receipt file bytes IDENTICAL (same runtime, same frozen timestamp).
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      // previous_digest chain: SPV_PASS links to the STAGE_PLAN receipt.
      const planDir = path.join(cliFx.root, '.proofloop', 'receipts', 'plan', STAGE_ID);
      const planReceipts = readCategoryReceipts(planDir);
      expect(planReceipts).toHaveLength(2);
      expect(planReceipts[0].type).toBe('STAGE_PLAN');
      expect(planReceipts[1].type).toBe('SPV_PASS');
      expect(planReceipts[1].previous_digest).toBe(planReceipts[0].digest);
      expect(verifyReceiptChain(planDir).valid).toBe(true);
      // Fresh reconcile readback: EXECUTING on both.
      const rCli = reconcileStage({ projectRoot: cliFx.root, stageId: STAGE_ID });
      const rPlugin = reconcileStage({ projectRoot: pluginFx.root, stageId: STAGE_ID });
      expect(rCli.stage_state).toBe('EXECUTING');
      expect(rPlugin.stage_state).toBe(rCli.stage_state);
      expect(rCli.receipt_chain_valid).toBe(true);
      expect(rPlugin.receipt_chain_valid).toBe(true);
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });

  it('wrong manifest_digest: refusal accepted:false / null ref / findings code parity, zero NEW receipts', async () => {
    const cliSeed = seedPlanning();
    const pluginSeed = seedPlanning();
    const cliFx = cliSeed.fx;
    const pluginFx = pluginSeed.fx;
    try {
      const wrongDigest = 'b'.repeat(64);
      const cli = admitRequest(
        { type: 'spv_result', stageId: STAGE_ID, manifestDigest: wrongDigest, summary: 'approve' },
        cliFx.root,
      );
      const tools = await registeredTools(pluginFx.root);
      const envelope = await tools.proofloop_plan.execute(
        {
          operation: 'admit_spv_result',
          stage_id: STAGE_ID,
          manifest_digest: wrongDigest,
          verdict: 'SPV_PASS',
          summary: 'approve',
        },
        makeToolContext(pluginFx.root),
      );
      const plugin = extractDataLine(envelope.output);

      expect(cli.accepted).toBe(false);
      expect(plugin.accepted).toBe(false);
      expect(cli.receipt_ref).toBeNull();
      expect(plugin.receipt_ref).toBeNull();
      const pluginFindings = plugin.findings as Array<{ code: string }>;
      expect(cli.findings.map((f) => f.code)).toEqual(pluginFindings.map((f) => f.code));
      expect(cli.findings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
      // Zero NEW receipts — only the STAGE_PLAN fixture fact remains on both.
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      const planDir = path.join(cliFx.root, '.proofloop', 'receipts', 'plan', STAGE_ID);
      expect(readCategoryReceipts(planDir)).toHaveLength(1);
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });
});

// ============================================================
// 5. Review parity (PO-S03-E-03)
// ============================================================

describe('review prepare/finalize parity (PO-S03-E-03)', () => {
  it('prepare: ReviewInput fields match the independent persisted-facts oracle; ref-only; no verdict/body', async () => {
    const { fx } = seedUnderReview();
    fx.writeAuthorityDocs();
    fx.commitAll('authority docs');
    const head = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    try {
      const tools = await registeredTools(fx.root);
      const envelope = await tools.proofloop_review.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const data = extractDataLine(envelope.output);

      // review_scope fixed (S3 supports only stage).
      expect(data['review_scope']).toBe('stage');

      // Manifest-sourced facts vs the independent manifest read.
      const manifestRaw = JSON.parse(
        readFileSync(path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`), 'utf-8'),
      ) as Record<string, unknown>;
      expect(data['stage_id']).toBe(STAGE_ID);
      expect(data['stage_goal']).toBe(manifestRaw['stage_goal']);
      expect(data['stage_outcomes']).toEqual(manifestRaw['outcomes']);
      expect(data['risk_facts']).toEqual(manifestRaw['risk_facts']);
      expect(data['manifest_digest']).toBe(
        manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID }),
      );

      // Root-bound relative paths.
      expect(data['tasks_path']).toBe(`delivery/stages/${STAGE_ID}/tasks.md`);
      expect(data['manifest_path']).toBe(`.proofloop/manifests/${STAGE_ID}.json`);

      // Git facts vs independent git reads.
      expect(data['branch']).toBe(
        execFileSync('git', ['-C', fx.root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
          encoding: 'utf-8',
        }).trim(),
      );
      expect(data['snapshot']).toBe(head);

      // Authority refs vs independent file reads (root-bound + content digests).
      const authorityRefs = data['authority_refs'] as Array<{ ref: string; digest: string }>;
      const prdRef = authorityRefs.find((r) => r.ref === 'PRD.md');
      expect(prdRef).toEqual({ ref: 'PRD.md', digest: fileDigest(path.join(fx.root, 'PRD.md')) });
      const techRef = authorityRefs.find((r) => r.ref === 'tech-spec/contract-state-matrix.md');
      expect(techRef).toEqual({
        ref: 'tech-spec/contract-state-matrix.md',
        digest: fileDigest(path.join(fx.root, 'tech-spec', 'contract-state-matrix.md')),
      });

      // Per-slice CV receipt ref vs the independent cv category read.
      const cv = readReceiptCategory({
        projectRoot: fx.root,
        category: 'cv',
        stageId: STAGE_ID,
        sliceId: SLICE_ID,
      });
      expect(cv.chainValid).toBe(true);
      const cvRefs = data['cv_receipt_refs'] as Array<{ ref: string; digest: string }>;
      expect(cvRefs).toHaveLength(1);
      expect(cvRefs[0].digest).toBe(cv.latest?.receipt.digest);
      expect(cvRefs[0].ref).toBe(
        `.proofloop/receipts/cv/${STAGE_ID}/${SLICE_ID}/${cv.latest?.receipt.digest}.json`,
      );

      // Deterministic risk/clean-room projections from persisted facts.
      expect(data['risk_level']).toBe('medium'); // persistent_state risk fact
      expect(data['clean_room']).toBe(true); // chain valid + evidence finalized

      // No verdict, no Receipt body — every ref is exactly { ref, digest }.
      expect('verdict' in data).toBe(false);
      const serialized = JSON.stringify(data);
      expect(serialized).not.toContain('"payload"');
      expect(serialized).not.toContain('"timestamp"');
      expect(serialized).not.toContain('"signature"');
      expect(serialized).not.toContain('previous_digest');
      const refGroups: unknown[] = [
        ...authorityRefs,
        ...cvRefs,
      ];
      const gateRef = data['stage_gate_receipt_ref'] as { ref: string; digest: string } | null;
      // No gate seeded → honest null.
      expect(gateRef).toBeNull();
      expect(refGroups.length).toBeGreaterThan(0);
      for (const ref of refGroups) {
        expect(Object.keys(ref as Record<string, unknown>).sort()).toEqual(['digest', 'ref']);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('finalize ACCEPTED: plugin projection + STAGE_REVIEW_PASS receipt bytes equal the CLI stage_review oracle; fresh reconcile COMPLETED', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    const cliSeed = seedUnderReview();
    const pluginSeed = seedUnderReview();
    const cliFx = cliSeed.fx;
    const pluginFx = pluginSeed.fx;
    try {
      const cli = admitRequest(
        { type: 'stage_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        cliFx.root,
      );
      const tools = await registeredTools(pluginFx.root);
      const envelope = await tools.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(pluginFx.root),
      );
      const plugin = extractDataLine(envelope.output);

      expect(cli.accepted).toBe(true);
      expect(plugin.accepted).toBe(true);
      const cliDigest = cli.receipt_ref as string;
      expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
      expect((plugin.receipt_ref as { ref: string }).ref).toBe(
        `.proofloop/receipts/review/${STAGE_ID}/${cliDigest}.json`,
      );
      expect(plugin.new_state).toEqual(projectCliNewState(cli.new_state));
      expect(plugin.findings).toEqual(cli.findings);
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
      const reviewDir = path.join(cliFx.root, '.proofloop', 'receipts', 'review', STAGE_ID);
      expect(verifyReceiptChain(reviewDir).valid).toBe(true);
      const reviewReceipts = readCategoryReceipts(reviewDir);
      expect(reviewReceipts).toHaveLength(1);
      expect(reviewReceipts[0].type).toBe('STAGE_REVIEW_PASS');
      expect(reviewReceipts[0].previous_digest).toBeUndefined();
      // Fresh reconcile readback: COMPLETED.
      expect(reconcileStage({ projectRoot: cliFx.root, stageId: STAGE_ID }).stage_state).toBe(
        'COMPLETED',
      );
      expect(reconcileStage({ projectRoot: pluginFx.root, stageId: STAGE_ID }).stage_state).toBe(
        'COMPLETED',
      );
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });

  it('finalize REPAIR: legal accepted null-ref no-Receipt branch matches the CLI oracle; review category NOT created', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    const cliSeed = seedUnderReview();
    const pluginSeed = seedUnderReview();
    const cliFx = cliSeed.fx;
    const pluginFx = pluginSeed.fx;
    try {
      const cli = admitRequest(
        { type: 'stage_review', stageId: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        cliFx.root,
      );
      const tools = await registeredTools(pluginFx.root);
      const envelope = await tools.proofloop_review.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        makeToolContext(pluginFx.root),
      );
      const plugin = extractDataLine(envelope.output);

      expect(cli.accepted).toBe(true);
      expect(plugin.accepted).toBe(true);
      expect(cli.receipt_ref).toBeNull();
      expect(plugin.receipt_ref).toBeNull();
      const cliFindings = cli.findings as unknown as Array<{ code: string; severity: string }>;
      const pluginFindings = plugin.findings as unknown as Array<{ code: string; severity: string }>;
      expect(cliFindings.map((f) => f.code)).toEqual(pluginFindings.map((f) => f.code));
      expect(cliFindings.map((f) => f.code)).toEqual(['DOMAIN.INVALID_TRANSITION']);
      expect(cliFindings.every((f) => f.severity === 'warn')).toBe(true);
      // In-memory new_state reflects the reopen target (EXECUTING).
      expect((plugin.new_state as { stage_state?: string } | null)?.stage_state).toBe(
        'EXECUTING',
      );
      expect((cli.new_state as { stage_state?: string }).stage_state).toBe('EXECUTING');
      // No Receipt written; the review category is NOT created on either side.
      expect(existsSync(path.join(cliFx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      expect(existsSync(path.join(pluginFx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      // Fresh reconcile stays on persisted facts (UNDER_REVIEW).
      expect(reconcileStage({ projectRoot: cliFx.root, stageId: STAGE_ID }).stage_state).toBe(
        'UNDER_REVIEW',
      );
      expect(reconcileStage({ projectRoot: pluginFx.root, stageId: STAGE_ID }).stage_state).toBe(
        'UNDER_REVIEW',
      );
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });
});

// ============================================================
// 6. Status parity — plan/stage/review deep-equal + budgets (PO-S03-E-03)
// ============================================================

describe('plan/stage/review status parity (PO-S03-E-03)', () => {
  it('plan status / stage status / review stage_status deep-equal on the same fixture; summaries ≤1000; findings ≤20; no Receipt body leak', async () => {
    const seed = seedUnderReview();
    const fx = seed.fx;
    try {
      const tools = await registeredTools(fx.root);
      const plan = await tools.proofloop_plan.execute(
        { operation: 'status', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      const stage = await tools.proofloop_stage.execute(
        { operation: 'status', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      const review = await tools.proofloop_review.execute(
        { operation: 'stage_status', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );

      const planData = extractDataLine(plan.output);
      const stageData = extractDataLine(stage.output);
      const reviewData = extractDataLine(review.output);

      expect(planData.stage_id).toBe(STAGE_ID);
      expect(planData.stage_state).toBe('UNDER_REVIEW');
      expect(planData.receipt_chain_valid).toBe(true);
      // Canonical projection deep-equal across the three status seams.
      expect(planData).toEqual(stageData);
      expect(planData).toEqual(reviewData);
      // Bounded summary deep-equal.
      const planBlock = extractStatusBlock(plan.output);
      const stageBlock = extractStatusBlock(stage.output);
      const reviewBlock = extractStatusBlock(review.output);
      expect(planBlock).toBe(stageBlock);
      expect(planBlock).toBe(reviewBlock);
      // Summary is bounded ≤1000 UTF-16 chars and no Receipt body/ref leak.
      expect(planBlock.length).toBeLessThanOrEqual(1000);
      expect(plan.output).not.toContain('"payload"');
      expect(plan.output).not.toMatch(/receipts\/(tasks|cv|committer|integration|plan|review)/);
      // Findings ≤20.
      for (const out of [plan.output, stage.output, review.output]) {
        const m = out.match(/^Findings \((\d+)\):/m);
        if (m) expect(Number(m[1])).toBeLessThanOrEqual(20);
      }
    } finally {
      fx.cleanup();
    }
  });
});
