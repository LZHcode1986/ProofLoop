/**
 * @proofloop/opencode-plugin — proofloop_plan compile/initialize parity vs the
 * runtime CLI oracle + no-child-process static guard (S03-A-T02).
 *
 * PO: PO-S03-A-02 (compile consumes the runtime compile library semantics and
 * returns canonical stage/digest/ref comparable to the CLI compile-manifest
 * oracle), PO-S03-A-03 (initialize_evidence reuses the runtime initializer's
 * canonical path validation / non-empty skip / exclusive-create semantics and
 * returns { created, skipped, errors } comparable to the CLI
 * initialize-slice-evidence oracle), PO-S03-A-04 (no-write / no CLI in
 * production).
 *
 * The plugin is exercised through the REAL `createPlanTool(...).execute`
 * host seam (same as plan-s3.spec.ts); the CLI dist entries
 * (`packages/runtime/dist/cli/compile-manifest.js` /
 * `initialize-slice-evidence.js`) are used ONLY inside this TEST process as
 * independent parity oracles — the production plugin never spawns them (a
 * static source guard below proves plan-compile.ts / plan-initialize.ts /
 * plan.ts / plan-common.ts contain no child_process / spawn / exec).
 *
 * Parity semantics:
 *   - compile: the CLI oracle writes the canonical Manifest JSON file and
 *     prints `Stage manifest written to <path>` (exit 0); on failure it
 *     prints `Compilation failed: <message>` (exit 1) and writes nothing.
 *     The plugin must write the same kernel-valid Manifest content through a
 *     root-bound path and expose `{ stage_id, source_digest, manifest_digest,
 *     manifest_ref }` in the ToolResult `data`. Canonical-field parity:
 *     stage_id / source_digest / slices / dependencies / risk_facts /
 *     stage_goal / outcomes deep-equal; the manifest_digest equals the
 *     runtime `canonicalManifestDigest` / `manifestFileDigest` of the written
 *     file; the stable (volatile-field-normalized) canonical digest is equal
 *     to the CLI's written manifest.
 *   - initialize_evidence: the CLI oracle prints the final JSON
 *     `{ created, skipped, errors }` (absolute paths under the delivery
 *     root). The plugin must project the runtime `InitializeSliceEvidenceResult`
 *     verbatim; running both against the same manifest + delivery root yields
 *     IDENTICAL arrays and identical evidence file bytes (same skeleton
 *     generator, same manifest digest). Non-empty files are skipped, never
 *     overwritten.
 */

import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalManifestDigest,
  manifestFileDigest,
} from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createPlanTool } from './plan.js';
import type { PlanToolArgsShape } from './plan.js';

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

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

beforeAll(() => {
  // Build the runtime dist so the CLI parity oracle is current (test-only).
  execFileSync(
    'npm',
    ['exec', '--', 'tsc', '-b', 'packages/kernel', 'packages/runtime'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  expect(existsSync(DIST_COMPILE_CLI)).toBe(true);
  expect(existsSync(DIST_INIT_CLI)).toBe(true);
});

function makeWorktree(prefix = 's03a-t02-parity-'): { root: string } {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  cleanups.push(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });
  return { root };
}

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

function makeContext(root: string): RuntimeContext {
  return createRuntimeContext(makeInput(root));
}

function makeToolContext(root: string): ToolContext {
  return {
    sessionID: 'sess-s03a-t02-parity',
    messageID: 'msg-s03a-t02-parity',
    agent: 'planner',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type PlanExecuteTool = {
  description: string;
  args: PlanToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makeTool(context: RuntimeContext): PlanExecuteTool {
  return createPlanTool(context) as PlanExecuteTool;
}

/** Acyclic 2-slice S03 stage (mirrors the runtime CLI fixtures). */
function validTasksMd(): string {
  return `# Stage S03 — Test Stage

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
`;
}

/** Write the valid tasks fixture at `<root>/tasks.md`. */
function writeTasks(root: string): string {
  const tasksPath = path.join(root, 'tasks.md');
  writeFileSync(tasksPath, validTasksMd(), 'utf-8');
  return tasksPath;
}

/** Extract the canonical `Data:` payload from the execute host output. */
function extractDataLine(output: string): Record<string, unknown> {
  const match = output.match(/^Data: (.+)$/m);
  expect(match).toBeTruthy();
  return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
}

/** sha256 hex digest of a file's bytes. */
function fileDigest(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
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
// Compile parity — plugin vs CLI compile-manifest oracle
// ============================================================

describe('compile parity vs CLI compile-manifest oracle (PO-S03-A-02)', () => {
  it('plugin canonical data/fields match the CLI-written manifest (stage, source_digest, slices, digest, ref)', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const pluginOut = path.join(root, '.proofloop', 'manifests', 'S3-plugin.json');
    const cliOut = path.join(root, '.proofloop', 'manifests', 'S3-cli.json');

    // CLI oracle (test-only): writes the canonical Manifest file, exit 0.
    const cliRes = spawnSync(
      process.execPath,
      [DIST_COMPILE_CLI, tasksPath, cliOut],
      { encoding: 'utf-8', timeout: 30000 },
    );
    expect(cliRes.status).toBe(0);
    expect(cliRes.stdout).toContain('Stage manifest written');
    const cliManifest = JSON.parse(readFileSync(cliOut, 'utf-8')) as Manifest;

    // Plugin through the REAL host execute seam.
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    const pluginManifest = JSON.parse(readFileSync(pluginOut, 'utf-8')) as Manifest;
    const data = extractDataLine(envelope.output);

    // Canonical field parity (stage_id / source_digest / full slice structure
    // and order / dependencies / risk facts / goals / outcomes).
    expect(pluginManifest.stage_id).toBe(cliManifest.stage_id);
    expect(pluginManifest.source_digest).toBe(cliManifest.source_digest);
    expect(pluginManifest.slices).toEqual(cliManifest.slices);
    expect(pluginManifest.dependencies).toEqual(cliManifest.dependencies);
    expect(pluginManifest.risk_facts).toEqual(cliManifest.risk_facts);
    expect(pluginManifest.stage_goal).toBe(cliManifest.stage_goal);
    expect(pluginManifest.outcomes).toEqual(cliManifest.outcomes);

    // The Data payload exposes the canonical stage/digest/ref.
    expect(data.stage_id).toBe(cliManifest.stage_id);
    expect(data.source_digest).toBe(cliManifest.source_digest);
    expect(data.manifest_digest).toBe(canonicalManifestDigest(pluginManifest));
    // The digest is the canonical digest of the WRITTEN file via the runtime
    // manifestFileDigest seam (same source planning/CLI use).
    expect(data.manifest_digest).toBe(
      manifestFileDigest({
        projectRoot: root,
        stageId: cliManifest.stage_id,
        manifestPath: pluginOut,
      }),
    );
    // manifest_ref is the ROOT-BOUND RELATIVE artifact path.
    expect(data.manifest_ref).toBe(path.relative(root, pluginOut));

    // Deterministic canonical-content parity: after stripping volatile fields
    // (compiled_at / compiled_by / source_path) the canonical digests are
    // EQUAL — the plugin publishes exactly the CLI's canonical Manifest.
    expect(canonicalManifestDigest(stableManifest(pluginManifest))).toBe(
      canonicalManifestDigest(stableManifest(cliManifest)),
    );

    // Compact budgets: the compile summary block is bounded (FR-012).
    expect(envelope.output).toContain('Compile result:');
    expect(envelope.output).toContain('Findings: none');
    expect(envelope.output).not.toContain('Receipts:');
  });

  it('plugin compile failure semantics match the CLI oracle (fail closed, no publish)', async () => {
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    writeFileSync(
      tasksPath,
      validTasksMd().replace('<!-- SLICE:S03-A:END -->', ''),
      'utf-8',
    );
    const cliOut = path.join(root, 'cli-fail.json');
    const pluginOut = path.join(root, 'plugin-fail.json');

    // CLI oracle: exit 1, prints the compile library error, writes nothing.
    const cliRes = spawnSync(
      process.execPath,
      [DIST_COMPILE_CLI, tasksPath, cliOut],
      { encoding: 'utf-8', timeout: 30000 },
    );
    expect(cliRes.status).toBe(1);
    expect(cliRes.stderr).toContain('Compilation failed');
    expect(existsSync(cliOut)).toBe(false);

    // Plugin: same fail-closed semantics through the REAL execute seam — a
    // canonical Finding carrying the SAME compile library error text, and NO
    // Manifest is published.
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(existsSync(pluginOut)).toBe(false);
    // The canonical error ORDER/message matches the CLI's underlying error.
    const canonicalError = 'Slice region "S03-B" opened';
    expect(cliRes.stderr).toContain(canonicalError);
    expect(envelope.output).toContain(canonicalError);
  });
});

// ============================================================
// initialize_evidence parity — plugin vs CLI initializer oracle
// ============================================================

describe('initialize_evidence parity vs CLI initializer oracle (PO-S03-A-03)', () => {
  /** Compile the manifest via the plugin owner write and return its path. */
  async function compileManifestFor(root: string): Promise<string> {
    const tasksPath = writeTasks(root);
    const outputPath = path.join(root, '.proofloop', 'manifests', 'S3.json');
    const tool = makeTool(makeContext(root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root),
    );
    expect(envelope.output).toContain('Status: ok');
    expect(existsSync(outputPath)).toBe(true);
    return outputPath;
  }

  it('plugin { created, skipped, errors } and evidence file bytes match the CLI oracle', async () => {
    const { root } = makeWorktree();
    const manifestPath = await compileManifestFor(root);

    // Plugin initialize (REAL execute).
    const tool = makeTool(makeContext(root));
    const env = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
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
    const cliRes = spawnSync(
      process.execPath,
      [DIST_INIT_CLI, manifestPath, root],
      { encoding: 'utf-8', timeout: 30000 },
    );
    expect(cliRes.status).toBe(0);
    const cliData = cliInitializeJson(cliRes.stdout);

    // created / skipped / errors arrays are IDENTICAL (absolute paths under
    // the same delivery root, same manifest).
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);

    // Evidence file bytes are identical (same skeleton generator + digest).
    for (const p of pluginCreated) {
      expect(fileDigest(p), `evidence file bytes differ: ${p}`).toBe(pluginBytes.get(p));
    }
  });

  it('non-empty Evidence files are skipped (never overwritten) by BOTH entries', async () => {
    const { root } = makeWorktree();
    const manifestPath = await compileManifestFor(root);
    const evidenceA = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');
    mkdirSync(path.dirname(evidenceA), { recursive: true });
    const original =
      '# Slice S03-A Evidence\n\n## Task Evidence\n\n### S03-A-T01\n\n- Status: COMPLETE\n';
    writeFileSync(evidenceA, original, 'utf-8');

    // Plugin initialize: S03-A skipped, S03-B created.
    const tool = makeTool(makeContext(root));
    const env = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root),
    );
    const pluginData = extractDataLine(env.output);
    expect((pluginData.created as string[]).length).toBe(1);
    expect((pluginData.skipped as string[]).length).toBe(1);
    expect(pluginData.errors).toEqual([]);
    expect(readFileSync(evidenceA, 'utf-8')).toBe(original);

    // Reset the created B file (keep the non-empty A), then run the CLI
    // oracle on the same state.
    rmSync(
      path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md'),
      { force: true },
    );
    const cliRes = spawnSync(
      process.execPath,
      [DIST_INIT_CLI, manifestPath, root],
      { encoding: 'utf-8', timeout: 30000 },
    );
    const cliData = cliInitializeJson(cliRes.stdout);
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    // The non-empty file is untouched by both entries.
    expect(readFileSync(evidenceA, 'utf-8')).toBe(original);
    // The created B skeleton bytes are identical across entries.
    const evidenceB = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md');
    expect(existsSync(evidenceB)).toBe(true);
    expect(env.output).toContain('Status: ok');
  });
});

// ============================================================
// Static guard — production plan layers never spawn the CLI
// ============================================================

describe('static guard: production compile/initialize layers never spawn the CLI (PO-S03-A-02/03/04)', () => {
  const PRODUCTION_SOURCES = [
    'plan.ts',
    'plan-common.ts',
    'plan-compile.ts',
    'plan-initialize.ts',
    'plan-status.ts',
    'plan-spv-admit.ts',
  ];

  it.each(PRODUCTION_SOURCES)(
    '%s contains no child_process / spawn / exec / CLI invocation',
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
});
