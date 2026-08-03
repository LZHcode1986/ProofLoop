/**
 * @proofloop/opencode-plugin — plan-s3-proof: full proof matrix on the BUILT
 * host seam (S03-A-T03).
 *
 * PO: PO-S03-A-01 (built `Hooks.tool.proofloop_plan` execute seam),
 * PO-S03-A-02 (compile parity: valid / marker-DAG-PO failure / output-mismatch
 * / outside-root output, isolated before/after snapshot + plugin/CLI
 * comparison), PO-S03-A-03 (initialize parity: empty/missing, non-empty,
 * symlink/outside, partial multi-slice, concurrent/exclusive-create —
 * created/skipped/errors + file bytes), PO-S03-A-04 (no-write/abort/validate
 * regression, full artifact snapshot).
 *
 * Seam: loads the BUILT plugin entry (`packages/opencode-plugin/dist/index.js`)
 * through a file URL — the same host-load seam the S2 integration specs
 * (`test/opencode-*.spec.ts`) use — and executes the REAL
 * `createPlanTool(...).execute(args, ToolContext)` host `{ output }` envelope
 * with a real RuntimeContext (from `createRuntimeContext`) and real
 * ToolContext shape. The CLI dist entries (`compile-manifest.js` /
 * `initialize-slice-evidence.js` / `validate-stage.js`) are used ONLY inside
 * this TEST process as parity oracles — the production plugin never spawns
 * them (static no-CLI guard lives in plan-s3-parity.spec.ts).
 *
 * Every matrix call is wrapped in a before/after full-artifact snapshot:
 * `.proofloop/receipts/**`, `.proofloop/runtime/**`, Manifest files, tasks.md
 * and the Evidence dir must be byte-identical EXCEPT the operation's own
 * intended write (compile publishes its output manifest; initialize publishes
 * its skeletons) and `.proofloop/logs/**` (diagnostics may append).
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
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalManifestDigest } from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import type { RuntimeContext } from '../host-context.js';
import type { PlanOperationHandlers, PlanToolArgsShape } from './plan.js';
import { runPlanInitialize } from './plan-initialize.js';

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
const DIST_VALIDATE_CLI = path.join(
  process.cwd(),
  'packages',
  'runtime',
  'dist',
  'cli',
  'validate-stage.js',
);

type BuiltEntry = {
  default?: unknown;
  server?: unknown;
  [key: string]: unknown;
};

type ToolContextShape = {
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
  abort: AbortSignal;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
  ask(input: {
    permission: string;
    patterns: string[];
    always: string[];
    metadata: Record<string, unknown>;
  }): Promise<void>;
};

type BuiltPlanTool = {
  description: string;
  args: PlanToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContextShape,
  ) => Promise<{ output: string }>;
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
  expect(existsSync(DIST_COMPILE_CLI)).toBe(true);
  expect(existsSync(DIST_INIT_CLI)).toBe(true);
  expect(existsSync(DIST_VALIDATE_CLI)).toBe(true);
});

function makeWorktree(prefix = 's03a-t03-proof-'): { root: string } {
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

async function loadBuilt(): Promise<BuiltEntry> {
  return (await import(pathToFileURL(DIST_ENTRY).href)) as BuiltEntry;
}

/** Real RuntimeContext from the BUILT host-context export. */
function makeContext(plugin: BuiltEntry, root: string): RuntimeContext {
  const createCtx = plugin['createRuntimeContext'] as (
    input: unknown,
  ) => RuntimeContext;
  const input = {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {},
  };
  return createCtx(input);
}

/** Real ToolContext-shaped fixture. */
function makeToolContext(
  root: string,
  agent: string,
  abort: AbortSignal = new AbortController().signal,
): ToolContextShape {
  return {
    sessionID: 'sess-s03a-t03-proof',
    messageID: 'msg-s03a-t03-proof',
    agent,
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Build the plan tool from the BUILT factory (optional handlers for abort). */
function makePlanTool(
  plugin: BuiltEntry,
  context: RuntimeContext,
  handlers?: PlanOperationHandlers,
): BuiltPlanTool {
  const factory = plugin['createPlanTool'] as (
    context: RuntimeContext,
    handlers?: PlanOperationHandlers,
  ) => BuiltPlanTool;
  return factory(context, handlers);
}

// ============================================================
// Fixtures
// ============================================================

/** Acyclic 2-slice S03 stage: A root; B deps [A]. */
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

/** Cyclic DAG tasks: A deps [B], B deps [A]. Compile does NOT enforce DAG. */
function cyclicTasksMd(): string {
  return validTasksMd().replace('- 无内部依赖。', '- S03-B');
}

/** Marker failure: S03-A END marker removed (extractSliceRegions throws). */
function unclosedTasksMd(): string {
  return validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
}

/** Kernel-invalid-result failure: unknown risk fact (computeCvMinimumLevel throws). */
function unknownRiskFactTasksMd(): string {
  return validTasksMd().replace('- core_state_machine: true', '- totally_unknown_fact: true');
}

/** Matching valid S03 manifest for validate parity. */
function compiledManifest(): Manifest {
  return {
    stage_id: 'S03',
    source_path: 'delivery/stages/S03/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'Test stage goal paragraph.',
    outcomes: ['OUT-01: first outcome'],
    slices: [
      {
        slice_id: 'S03-A',
        goal: 'Slice A goal.',
        observable_outcome: 'Slice A observable outcome.',
        public_seam: 'Seam A.',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-A-01',
            behavior: 'Slice A behavior.',
            public_seam: 'Seam A.',
            oracle_source: 'oracle A.',
            success_criteria: 'success when X; failure when Y.',
            required_observation: 'observe X.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S03-A-T01'],
        risk_facts: ['core_state_machine: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-A.md',
        cv_minimum_level: 'enhanced',
      },
      {
        slice_id: 'S03-B',
        goal: 'Slice B goal.',
        observable_outcome: 'Slice B observable outcome.',
        public_seam: 'Seam B.',
        dependencies: ['S03-A'],
        proof_obligations: [
          {
            po_id: 'PO-S03-B-01',
            behavior: 'Slice B behavior.',
            public_seam: 'Seam B.',
            oracle_source: 'oracle B.',
            success_criteria: 'success when Z.',
            required_observation: 'observe Z.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S03-B-T01', 'S03-B-T02'],
        risk_facts: ['persistent_state: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-B.md',
        cv_minimum_level: 'standard',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

/** Kernel-valid 3-slice manifest for partial multi-slice initialize parity. */
function threeSliceManifest(): Manifest {
  const base = compiledManifest();
  base.slices.push({
    slice_id: 'S03-C',
    goal: 'Slice C goal.',
    observable_outcome: 'Slice C observable outcome.',
    public_seam: 'Seam C.',
    dependencies: ['S03-B'],
    proof_obligations: [
      {
        po_id: 'PO-S03-C-01',
        behavior: 'Slice C behavior.',
        public_seam: 'Seam C.',
        oracle_source: 'oracle C.',
        success_criteria: 'success when W.',
        required_observation: 'observe W.',
        applicable_risk_facts: [],
      },
    ],
    tasks: ['S03-C-T01'],
    risk_facts: ['external_side_effect: true'],
    evidence_path: 'delivery/stages/S03/evidence/S03-C.md',
    cv_minimum_level: 'standard',
  });
  return base;
}

/** Write tasks at `<root>/tasks.md` and return the path. */
function writeTasks(root: string, content: string = validTasksMd()): string {
  const tasksPath = path.join(root, 'tasks.md');
  writeFileSync(tasksPath, content, 'utf-8');
  return tasksPath;
}

/** Write a manifest at `<root>/manifest.json` and return the path. */
function writeManifest(root: string, manifest: Manifest = compiledManifest()): string {
  const manifestPath = path.join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
}

/** Compile a manifest through the plugin owner write and return its path. */
async function compileManifestViaPlugin(
  plugin: BuiltEntry,
  root: string,
  tasksPath: string,
): Promise<string> {
  const outputPath = path.join(root, '.proofloop', 'manifests', 'S3.json');
  const tool = makePlanTool(plugin, makeContext(plugin, root));
  const envelope = await tool.execute(
    { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
    makeToolContext(root, 'planner'),
  );
  expect(envelope.output).toContain('Status: ok');
  expect(existsSync(outputPath)).toBe(true);
  return outputPath;
}

// ============================================================
// Snapshot helpers (full artifact battery, PO-S03-A-04)
// ============================================================

/** sha256 hex digest of a file's bytes. */
function fileDigest(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Digest map of every file in the tree (relative path → sha256). */
function snapshotTree(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        map.set(path.relative(root, abs), fileDigest(readFileSync(abs)));
      } else if (entry.isSymbolicLink()) {
        // Snapshot the LINK itself (its target string), never read through it —
        // a symlink may point at a directory (readFileSync would EISDIR) or
        // outside the tree; the boundary layer must not follow it either.
        map.set(path.relative(root, abs), `link:${fileDigest(Buffer.from(readlinkSync(abs)))}`);
      }
    }
  };
  walk(root);
  return map;
}

/**
 * Assert the tree is byte-identical to `before` except: (a) files under
 * `.proofloop/logs/**` may appear or append (diagnostics), and (b) the
 * operation's own intended writes (`allowedChangeRel`) may appear/change.
 * Every other business artifact (receipts/runtime/manifests/tasks/evidence)
 * must be byte-identical.
 */
function assertSnapshot(
  root: string,
  before: Map<string, string>,
  allowedChangeRel: readonly string[],
): void {
  const after = snapshotTree(root);
  for (const [rel, digest] of before) {
    if (allowedChangeRel.includes(rel) || rel.startsWith('.proofloop/logs/')) {
      continue;
    }
    expect(after.has(rel), `file deleted: ${rel}`).toBe(true);
    expect(after.get(rel), `file changed: ${rel}`).toBe(digest);
  }
  for (const rel of after.keys()) {
    if (before.has(rel)) continue;
    const allowed =
      rel.startsWith('.proofloop/logs/') || allowedChangeRel.includes(rel);
    expect(allowed, `new file outside allowed set: ${rel}`).toBe(true);
  }
  // Explicit protected-path checks: no Receipt/runtime artifact ever appears.
  expect(existsSync(path.join(root, '.proofloop', 'receipts'))).toBe(false);
  expect(existsSync(path.join(root, '.proofloop', 'runtime'))).toBe(false);
}

/** Extract the canonical `Data:` payload from the execute host output. */
function extractDataLine(output: string): Record<string, unknown> {
  const match = output.match(/^Data: (.+)$/m);
  expect(match).toBeTruthy();
  return JSON.parse(match?.[1] ?? '') as Record<string, unknown>;
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
function cliInitializeJson(stdout: string): {
  created: string[];
  skipped: string[];
  errors: string[];
} {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'))
    .pop();
  expect(line).toBeTruthy();
  return JSON.parse(line ?? '') as { created: string[]; skipped: string[]; errors: string[] };
}

// ============================================================
// Compile parity matrix (PO-S03-A-02)
// ============================================================

describe('compile parity matrix on the built host (PO-S03-A-02)', () => {
  it('valid fixture: plugin-written manifest deep-equals the CLI oracle and the Data payload exposes stage/digest/ref', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const pluginOut = path.join(root, '.proofloop', 'manifests', 'S3-plugin.json');
    const cliOut = path.join(root, '.proofloop', 'manifests', 'S3-cli.json');

    // CLI oracle (test-only).
    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    const cliManifest = JSON.parse(readFileSync(cliOut, 'utf-8')) as Manifest;

    // Plugin through the BUILT host execute seam, with full snapshot.
    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    const pluginManifest = JSON.parse(readFileSync(pluginOut, 'utf-8')) as Manifest;
    const data = extractDataLine(envelope.output);

    expect(pluginManifest.stage_id).toBe(cliManifest.stage_id);
    expect(pluginManifest.source_digest).toBe(cliManifest.source_digest);
    expect(pluginManifest.slices).toEqual(cliManifest.slices);
    expect(pluginManifest.dependencies).toEqual(cliManifest.dependencies);
    expect(pluginManifest.risk_facts).toEqual(cliManifest.risk_facts);
    expect(pluginManifest.stage_goal).toBe(cliManifest.stage_goal);
    expect(pluginManifest.outcomes).toEqual(cliManifest.outcomes);
    expect(canonicalManifestDigest(stableManifest(pluginManifest))).toBe(
      canonicalManifestDigest(stableManifest(cliManifest)),
    );
    expect(data.stage_id).toBe(cliManifest.stage_id);
    expect(data.source_digest).toBe(cliManifest.source_digest);
    expect(data.manifest_digest).toBe(canonicalManifestDigest(pluginManifest));
    expect(data.manifest_ref).toBe(path.relative(root, pluginOut));

    // Full artifact snapshot: only the compile output manifest may appear new.
    assertSnapshot(root, before, [path.relative(root, pluginOut)]);
  });

  it('marker failure: plugin ok:false with the same canonical error as the CLI, NO manifest published', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root, unclosedTasksMd());
    const cliOut = path.join(root, 'cli-fail.json');
    const pluginOut = path.join(root, 'plugin-fail.json');

    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(1);
    expect(existsSync(cliOut)).toBe(false);
    const canonicalError = 'Slice region "S03-B" opened';
    expect(cliRes.stderr).toContain(canonicalError);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain(canonicalError);
    expect(existsSync(pluginOut)).toBe(false);
    assertSnapshot(root, before, []);
  });

  it('kernel-invalid-result failure (unknown risk fact): plugin fails closed, NO manifest published, parity with CLI', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root, unknownRiskFactTasksMd());
    const cliOut = path.join(root, 'cli-fail.json');
    const pluginOut = path.join(root, 'plugin-fail.json');

    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(1);
    expect(cliRes.stderr).toContain('Unknown risk fact');
    expect(existsSync(cliOut)).toBe(false);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Unknown risk fact');
    expect(existsSync(pluginOut)).toBe(false);
    assertSnapshot(root, before, []);
  });

  it('DAG-cycle fixture: compile succeeds identically in plugin and CLI (DAG enforcement is validate-stage)', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root, cyclicTasksMd());
    const pluginOut = path.join(root, '.proofloop', 'manifests', 'S3-plugin.json');
    const cliOut = path.join(root, '.proofloop', 'manifests', 'S3-cli.json');

    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    const cliManifest = JSON.parse(readFileSync(cliOut, 'utf-8')) as Manifest;
    expect(cliManifest.slices[0].dependencies).toEqual(['S03-B']);
    expect(cliManifest.slices[1].dependencies).toEqual(['S03-A']);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginOut },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    const pluginManifest = JSON.parse(readFileSync(pluginOut, 'utf-8')) as Manifest;
    expect(pluginManifest.slices).toEqual(cliManifest.slices);
    expect(canonicalManifestDigest(stableManifest(pluginManifest))).toBe(
      canonicalManifestDigest(stableManifest(cliManifest)),
    );
    assertSnapshot(root, before, [path.relative(root, pluginOut)]);
  });

  it('manifest output mismatch (directory write target): plugin and CLI fail closed, no valid Manifest published', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const dirTarget = path.join(root, 'outdir');
    mkdirSync(dirTarget, { recursive: true });
    const cliOut = dirTarget;

    const cliRes = spawnSync(process.execPath, [DIST_COMPILE_CLI, tasksPath, cliOut], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(1);
    expect(cliRes.stderr).toMatch(/EISDIR|directory/i);

    // A SECOND directory target for the plugin (the CLI already failed on the
    // first); both fail with the same invalid-write-target semantics.
    const pluginTarget = path.join(root, 'outdir-plugin');
    mkdirSync(pluginTarget, { recursive: true });
    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'compile', tasks_path: tasksPath, manifest_path: pluginTarget },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toMatch(/EISDIR|directory/i);
    // The directory target stays a directory — no partial manifest file.
    expect(fs.statSync(pluginTarget).isDirectory()).toBe(true);
    expect(fs.readdirSync(pluginTarget)).toEqual([]);
    assertSnapshot(root, before, []);
  });

  it('outside-root output path: HOST.PATH_OUTSIDE_PROJECT, no write', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outside = path.join(tmpdir(), `s03a-t03-outside-${Date.now()}.json`);
    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    try {
      const envelope = await tool.execute(
        { operation: 'compile', tasks_path: tasksPath, manifest_path: outside },
        makeToolContext(root, 'planner'),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expect(existsSync(outside)).toBe(false);
      assertSnapshot(root, before, []);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

// ============================================================
// initialize_evidence parity matrix (PO-S03-A-03)
// ============================================================

describe('initialize_evidence parity matrix on the built host (PO-S03-A-03)', () => {
  it('empty evidence dir: all skeletons created, {created, skipped, errors} + file bytes match the CLI oracle', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    const pluginData = extractDataLine(envelope.output);
    const created = pluginData.created as string[];
    expect(created).toHaveLength(2);
    expect(pluginData.skipped).toEqual([]);
    expect(pluginData.errors).toEqual([]);
    const pluginBytes = new Map(created.map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));

    // Reset and run the CLI oracle on the SAME manifest + delivery root.
    rmSync(path.join(root, 'delivery'), { recursive: true, force: true });
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, manifestPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    const cliData = cliInitializeJson(cliRes.stdout);
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    for (const p of created) {
      expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(pluginBytes.get(p));
    }
    // Full artifact snapshot: only the created skeletons may appear new.
    assertSnapshot(root, before, created.map((p) => path.relative(root, p)));
  });

  it('non-empty evidence: skipped, bytes untouched, parity with the CLI oracle', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    const evidenceA = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');
    mkdirSync(path.dirname(evidenceA), { recursive: true });
    const original =
      '# Slice S03-A Evidence\n\n## Task Evidence\n\n### S03-A-T01\n\n- Status: COMPLETE\n';
    writeFileSync(evidenceA, original, 'utf-8');

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    const pluginData = extractDataLine(envelope.output);
    expect((pluginData.created as string[]).length).toBe(1);
    expect((pluginData.skipped as string[]).length).toBe(1);
    expect(pluginData.errors).toEqual([]);
    expect(readFileSync(evidenceA, 'utf-8')).toBe(original);

    // Reset the created B (keep non-empty A), run the CLI oracle.
    rmSync(path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md'), { force: true });
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, manifestPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    const cliData = cliInitializeJson(cliRes.stdout);
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    expect(readFileSync(evidenceA, 'utf-8')).toBe(original);
    assertSnapshot(root, before, [
      path.relative(root, evidenceA),
      path.relative(root, path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md')),
    ]);
  });

  it('symlink evidence file: explicit errors entry, symlink never overwritten, parity with the CLI oracle', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    const evidenceA = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');
    mkdirSync(path.dirname(evidenceA), { recursive: true });
    const linkTarget = path.join(root, 'real-evidence.md');
    writeFileSync(linkTarget, '# real evidence\n', 'utf-8');
    symlinkSync(linkTarget, evidenceA);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    const pluginData = extractDataLine(envelope.output);
    const pluginErrors = pluginData.errors as string[];
    expect(pluginErrors.length).toBe(1);
    expect(pluginErrors[0]).toContain('symlink');
    expect((pluginData.created as string[]).length).toBe(1);
    // The symlink was NOT overwritten.
    expect(fs.lstatSync(evidenceA).isSymbolicLink()).toBe(true);

    // Parity: run the CLI on the same state (delete the plugin-created B).
    rmSync(path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md'), { force: true });
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, manifestPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(1);
    const cliData = cliInitializeJson(cliRes.stdout);
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    expect(fs.lstatSync(evidenceA).isSymbolicLink()).toBe(true);
    assertSnapshot(root, before, [
      path.relative(root, evidenceA),
      path.relative(root, path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md')),
    ]);
  });

  it('traversal evidence_path in a kernel-valid manifest: explicit errors entry, NO write, parity with the CLI oracle', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const manifestPath = path.join(root, 'manifest.json');
    const manifest = compiledManifest();
    manifest.slices[0].evidence_path = 'delivery/stages/S03/evidence/../../evil.md';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    const pluginData = extractDataLine(envelope.output);
    const pluginErrors = pluginData.errors as string[];
    expect(pluginErrors.length).toBe(1);
    expect(pluginErrors[0]).toContain('does not match the canonical pattern');
    // The traversal slice was rejected BEFORE any write: the lexically-escaped
    // target does not exist and no `evil.md` was published anywhere. The valid
    // sibling slice (S03-B) IS created — that is the intended owner write.
    expect(existsSync(path.join(root, 'delivery', 'stages', 'S03', 'evil.md'))).toBe(false);
    const pluginCreated = pluginData.created as string[];
    expect(pluginCreated.length).toBe(1);
    expect(pluginCreated[0].endsWith('S03-B.md')).toBe(true);

    // Reset to the pre-write state, then run the CLI oracle on the SAME
    // manifest + delivery root (identical starting state → identical result).
    rmSync(path.join(root, 'delivery'), { recursive: true, force: true });
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, manifestPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(1);
    const cliData = cliInitializeJson(cliRes.stdout);
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    // Full artifact snapshot: only the intended S03-B skeleton may appear new;
    // the traversal target was never written.
    assertSnapshot(root, before, [path.relative(root, pluginCreated[0])]);
  });

  it('out-of-root manifest path: HOST.PATH_OUTSIDE_PROJECT, no write', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const outside = path.join(tmpdir(), `s03a-t03-outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify(compiledManifest(), null, 2), 'utf-8');
    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    try {
      const envelope = await tool.execute(
        { operation: 'initialize_evidence', manifest_path: outside },
        makeToolContext(root, 'planner'),
      );
      expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
      expect(envelope.output).toContain('Status: failed');
      expect(existsSync(path.join(root, 'delivery'))).toBe(false);
      assertSnapshot(root, before, []);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('partial multi-slice (3 slices, one evidence pre-exists): created + skipped mix, parity with the CLI oracle', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const manifestPath = path.join(root, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(threeSliceManifest(), null, 2), 'utf-8');
    const evidenceB = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md');
    mkdirSync(path.dirname(evidenceB), { recursive: true });
    writeFileSync(evidenceB, '# Slice S03-B Evidence (existing)\n', 'utf-8');

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    const pluginData = extractDataLine(envelope.output);
    const created = pluginData.created as string[];
    const skipped = pluginData.skipped as string[];
    expect(created).toHaveLength(2);
    expect(skipped).toHaveLength(1);
    expect(pluginData.errors).toEqual([]);
    expect(created.some((p) => p.endsWith('S03-A.md'))).toBe(true);
    expect(created.some((p) => p.endsWith('S03-C.md'))).toBe(true);
    expect(skipped[0].endsWith('S03-B.md')).toBe(true);

    // Reset the two created files (keep S03-B), run the CLI oracle.
    rmSync(path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md'), { force: true });
    rmSync(path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-C.md'), { force: true });
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, manifestPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    const cliData = cliInitializeJson(cliRes.stdout);
    expect(pluginData.created).toEqual(cliData.created);
    expect(pluginData.skipped).toEqual(cliData.skipped);
    expect(pluginData.errors).toEqual(cliData.errors);
    assertSnapshot(root, before, [
      ...created.map((p) => path.relative(root, p)),
      path.relative(root, evidenceB),
    ]);
  });

  it('concurrent/exclusive-create representative: a second initialize call skips everything and never overwrites (plugin + CLI)', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);

    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const first = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(first.output).toContain('Status: ok');
    const firstData = extractDataLine(first.output);
    const createdFirst = firstData.created as string[];
    expect(createdFirst).toHaveLength(2);
    const bytesFirst = new Map(
      createdFirst.map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]),
    );

    // Second call: exclusive-create/skip semantics — nothing is overwritten.
    const before = snapshotTree(root);
    const second = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(second.output).toContain('Status: ok');
    const secondData = extractDataLine(second.output);
    expect(secondData.created).toEqual([]);
    expect((secondData.skipped as string[]).length).toBe(2);
    expect(secondData.errors).toEqual([]);
    for (const p of createdFirst) {
      expect(createHash('sha256').update(readFileSync(p)).digest('hex')).toBe(bytesFirst.get(p));
    }
    assertSnapshot(root, before, []);

    // Parity: the CLI oracle's second call behaves identically on the SAME state.
    const cliRes = spawnSync(process.execPath, [DIST_INIT_CLI, manifestPath, root], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cliRes.status).toBe(0);
    const cliSecond = cliInitializeJson(cliRes.stdout);
    expect(cliSecond.created).toEqual([]);
    expect(cliSecond.skipped).toEqual(secondData.skipped);
    expect(cliSecond.errors).toEqual([]);
  });
});

// ============================================================
// initialize_evidence parent-symlink escape closure (PO-S03-A-03 repair)
// ============================================================

describe('initialize_evidence parent-symlink escape closure on the built host (PO-S03-A-03 repair)', () => {
  it('rejects a `delivery/stages/S03` symlink to an OUTSIDE dir: HOST.PATH_OUTSIDE_PROJECT, no write through the symlink', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-repair-outside-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // Compile the manifest (owner write), then replace the evidence PARENT
    // `delivery/stages/S03` with a symlink to the OUTSIDE dir (the CV
    // counterexample) BEFORE the initialize call.
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    mkdirSync(path.join(root, 'delivery', 'stages'), { recursive: true });
    symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // No file was written outside the trust root and nothing was created
    // through the symlinked parent (the initializer never ran).
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(outside, 'evidence'))).toBe(false);
    expect(existsSync(path.join(root, 'delivery', 'stages', 'S03', 'evidence'))).toBe(false);
    assertSnapshot(root, before, []);
  });

  it('rejects an `.../evidence` PARENT symlink to an OUTSIDE dir: no write, nothing outside', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-repair-outside-ev-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const plugin = await loadBuilt();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    // `delivery/stages/S03` is a real dir; its `evidence` child is the symlink.
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });
    symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03', 'evidence'));

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    expect(fs.readdirSync(outside)).toEqual([]);
    assertSnapshot(root, before, []);
  });

  it('rejects an in-root symlink redirect of the evidence parent (identity semantics), no write to the redirect target', async () => {
    const { root } = makeWorktree();
    const altTarget = path.join(root, 'alt-evidence-target');
    mkdirSync(altTarget, { recursive: true });
    const plugin = await loadBuilt();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    mkdirSync(path.join(root, 'delivery', 'stages'), { recursive: true });
    symlinkSync(altTarget, path.join(root, 'delivery', 'stages', 'S03'));

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // The redirect target was not written through the symlink.
    expect(fs.readdirSync(altTarget)).toEqual([]);
    assertSnapshot(root, before, []);
  });
});

// ============================================================
// diagnose: check-to-write parent-swap race closure (PO-S03-A-03)
// ============================================================

/**
 * Build a plan tool whose `initialize_evidence` handler injects the documented
 * test-only seams on `runPlanInitialize` (forwarded into the runtime
 * initializer), so the fault injection flows through the REAL
 * `createPlanTool(...).execute` host envelope (round-4/5 requirement — never
 * call `runPlanInitialize` directly for built-host fault injection).
 */
function makePlanToolWithInitializeSeam(
  plugin: BuiltEntry,
  context: RuntimeContext,
  beforeInitialize?: () => void,
  beforeDirOpen?: () => void,
  beforeFileOpen?: () => void,
): BuiltPlanTool {
  return makePlanTool(plugin, context, {
    initialize_evidence: (input) =>
      runPlanInitialize(input.projectRoot, input.rawArgs, {
        beforeInitialize,
        beforeDirOpen,
        beforeFileOpen,
      }),
  });
}

describe('diagnose: check-to-write parent-swap race closure via the REAL execute envelope (PO-S03-A-03 diagnose)', () => {
  /**
   * The static pre-check cannot close a TOCTOU RACE: a concurrent process may
   * swap a real/missing evidence parent for an outside symlink AFTER
   * `verifyEvidencePathsWithinRoot` and BEFORE the runtime initializer runs.
   * The swap is injected through the documented `beforeInitialize` seam via the
   * execute envelope; the hardened runtime (no-follow) fails closed and the
   * plugin post-write re-verify returns HOST.PATH_OUTSIDE_PROJECT.
   */
  it('injected OUTSIDE parent swap → fail closed, nothing outside', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-diagnose-outside-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const plugin = await loadBuilt();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const tool = makePlanToolWithInitializeSeam(plugin, makeContext(plugin, root), () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
    });
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(existsSync(path.join(outside, 'evidence'))).toBe(false);
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });

  it('injected IN-ROOT redirect swap → fail closed, redirect target untouched', async () => {
    const { root } = makeWorktree();
    const alt = path.join(root, 'alt-target');
    mkdirSync(alt, { recursive: true });
    const plugin = await loadBuilt();
    const tasksPath = writeTasks(root);
    const manifestPath = await compileManifestViaPlugin(plugin, root, tasksPath);
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const tool = makePlanToolWithInitializeSeam(plugin, makeContext(plugin, root), () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(alt, path.join(root, 'delivery', 'stages', 'S03'));
    });
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    const altEvidence = path.join(alt, 'evidence');
    if (existsSync(altEvidence)) {
      expect(fs.readdirSync(altEvidence)).toEqual([]);
    }
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });
});

// ============================================================
// diagnose round 3/4: evidence-parent TOCTOU counterexamples (PO-S03-A-03)
// via the REAL execute envelope
// ============================================================

describe('diagnose round 3/4: evidence-parent TOCTOU counterexamples via the REAL execute envelope (PO-S03-A-03)', () => {
  /** Compile a 2-slice manifest via the plugin owner write. */
  async function compileFor(root: string): Promise<string> {
    const plugin = await loadBuilt();
    const tasksPath = writeTasks(root);
    return compileManifestViaPlugin(plugin, root, tasksPath);
  }

  /** Execute initialize_evidence through the envelope with an injected swap. */
  async function executeWithSwap(
    root: string,
    manifestPath: string,
    swap: () => void,
  ): Promise<string> {
    const plugin = await loadBuilt();
    const tool = makePlanToolWithInitializeSeam(plugin, makeContext(plugin, root), swap);
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    return envelope.output;
  }

  it('(a) outside swap + pre-existing NON-EMPTY outside evidence files → fail closed, outside files NOT deleted, bytes untouched', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-cx-a-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = await compileFor(root);
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    const bytesA = '# pre-existing outside A\n';
    const bytesB = '# pre-existing outside B\n';
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), bytesA, 'utf-8');
    writeFileSync(path.join(outside, 'evidence', 'S03-B.md'), bytesB, 'utf-8');
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const output = await executeWithSwap(root, manifestPath, () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
    });
    // No false success; pre-existing outside files untouched (never read/skipped).
    expect(output).toContain('Status: failed');
    expect(output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe(bytesA);
    expect(readFileSync(path.join(outside, 'evidence', 'S03-B.md'), 'utf-8')).toBe(bytesB);
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });

  it('(b) outside swap + pre-existing EMPTY outside evidence file → fail closed, empty file SURVIVES (never consumed)', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-cx-b-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = await compileFor(root);
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), '', 'utf-8');
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const output = await executeWithSwap(root, manifestPath, () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
    });
    expect(output).toContain('Status: failed');
    expect(output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // The hardened runtime never touches the pre-existing empty file: it
    // SURVIVES (never unlinked, never replaced).
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('');
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });

  it('(c) pre-existing EMPTY evidence dir in the NORMAL path is NEVER removed by the run', async () => {
    const { root } = makeWorktree();
    const manifestPath = await compileFor(root);
    const evidenceDir = path.join(root, 'delivery', 'stages', 'S03', 'evidence');
    mkdirSync(evidenceDir, { recursive: true }); // pre-existing empty evidence dir

    const before = snapshotTree(root);
    const plugin = await loadBuilt();
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    expect(existsSync(evidenceDir)).toBe(true);
    expect(fs.readdirSync(evidenceDir).sort()).toEqual(['S03-A.md', 'S03-B.md']);
    assertSnapshot(root, before, [
      'delivery/stages/S03/evidence/S03-A.md',
      'delivery/stages/S03/evidence/S03-B.md',
    ]);
  });

  it('(c2) pre-existing empty LEXICAL evidence dir + injected escape → nothing created outside, redirect dir NOT removed', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-cx-c-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = await compileFor(root);
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03', 'evidence'), { recursive: true });

    const before = snapshotTree(root);
    const output = await executeWithSwap(root, manifestPath, () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
    });
    expect(output).toContain('Status: failed');
    expect(output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // The hardened runtime fails closed on the symlinked parent: the outside
    // evidence dir is never created or removed (nothing through the redirect).
    expect(fs.readdirSync(outside)).toEqual([]);
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });

  it('(round-4) PRE-EXISTING OUTSIDE evidence directory (with files) + parent swap → never removed, files untouched', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-cx-round4-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = await compileFor(root);
    // Pre-existing OUTSIDE evidence directory WITH pre-existing files: the
    // no-follow initializer never touches it, so no rollback can rmdir it.
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), '# outside A\n', 'utf-8');
    writeFileSync(path.join(outside, 'evidence', 'S03-B.md'), '# outside B\n', 'utf-8');
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const output = await executeWithSwap(root, manifestPath, () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
    });
    expect(output).toContain('Status: failed');
    expect(output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // The pre-existing outside evidence DIRECTORY survives with its files.
    expect(fs.readdirSync(path.join(outside, 'evidence')).sort()).toEqual(['S03-A.md', 'S03-B.md']);
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('# outside A\n');
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });

  it('(d) mutation-sensitive: a pre-existing EMPTY file in the redirect target SURVIVES under no-follow; removing the no-follow protection MUST fail this test', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-cx-d-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = await compileFor(root);
    // The redirect target contains a PRE-EXISTING EMPTY evidence file. With the
    // no-follow protection, the initializer fails closed on the symlinked
    // parent and never touches the file. If the no-follow chain were removed
    // (lexical mkdir + lexical empty-file unlink), the initializer would DELETE
    // this empty file — so this assertion is MUTATION-SENSITIVE: removing the
    // runtime protection must fail the test (verified by a real revert-run).
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), '', 'utf-8');
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const output = await executeWithSwap(root, manifestPath, () => {
      rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
    });
    expect(output).toContain('Status: failed');
    expect(output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // The pre-existing empty file in the redirect target SURVIVES (no-follow).
    expect(existsSync(path.join(outside, 'evidence', 'S03-A.md'))).toBe(true);
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('');
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });
});

// ============================================================
// diagnose round 5: directory-handle root fix (PO-S03-A-03)
// ============================================================

describe('diagnose round 5: dirfd root fix via the REAL execute envelope (PO-S03-A-03)', () => {
  /** Compile a 2-slice manifest via the plugin owner write. */
  async function compileFor(root: string): Promise<string> {
    const plugin = await loadBuilt();
    const tasksPath = writeTasks(root);
    return compileManifestViaPlugin(plugin, root, tasksPath);
  }

  it('injected race BETWEEN parent-chain verification and dirfd open (swap to outside + pre-existing outside files) → dev/ino mismatch fails closed, outside untouched', async () => {
    const { root } = makeWorktree();
    const outside = mkdtempSync(path.join(tmpdir(), 's03a-cx-r5-'));
    cleanups.push(() => {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    const manifestPath = await compileFor(root);
    // Pre-existing OUTSIDE evidence directory WITH files: the race swaps the
    // parent after the no-follow chain verification but BEFORE the dirfd open.
    mkdirSync(path.join(outside, 'evidence'), { recursive: true });
    writeFileSync(path.join(outside, 'evidence', 'S03-A.md'), '# outside A\n', 'utf-8');
    writeFileSync(path.join(outside, 'evidence', 'S03-B.md'), '# outside B\n', 'utf-8');
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });

    const before = snapshotTree(root);
    const plugin = await loadBuilt();
    const tool = makePlanToolWithInitializeSeam(
      plugin,
      makeContext(plugin, root),
      undefined,
      // beforeDirOpen: swap the parent AFTER the chain verify, BEFORE the open.
      () => {
        rmSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true, force: true });
        symlinkSync(outside, path.join(root, 'delivery', 'stages', 'S03'));
      },
    );
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('HOST.PATH_OUTSIDE_PROJECT');
    // The outside evidence files were never read/written; the dev/ino
    // cross-check rejected the swapped dirfd before any file op.
    expect(readFileSync(path.join(outside, 'evidence', 'S03-A.md'), 'utf-8')).toBe('# outside A\n');
    expect(readFileSync(path.join(outside, 'evidence', 'S03-B.md'), 'utf-8')).toBe('# outside B\n');
    assertSnapshot(root, before, ['delivery/stages/S03']);
  });

  it('O_EXCL mutation-sensitive: a concurrent file created between lstat and the exclusive open is SKIPPED (bytes preserved)', async () => {
    const { root } = makeWorktree();
    const manifestPath = await compileFor(root);
    mkdirSync(path.join(root, 'delivery', 'stages', 'S03'), { recursive: true });
    const concurrentPath = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-A.md');

    const before = snapshotTree(root);
    const plugin = await loadBuilt();
    const tool = makePlanToolWithInitializeSeam(
      plugin,
      makeContext(plugin, root),
      undefined,
      undefined,
      // beforeFileOpen: a concurrent writer creates the file after the ENOENT
      // lstat, right before the O_EXCL open. O_EXCL must fail (EEXIST → skip),
      // never truncate the concurrent file.
      () => {
        mkdirSync(path.dirname(concurrentPath), { recursive: true });
        writeFileSync(concurrentPath, 'concurrent writer\n', 'utf-8');
      },
    );
    const envelope = await tool.execute(
      { operation: 'initialize_evidence', manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    // The concurrent file SURVIVES (skipped, never truncated by the run).
    expect(readFileSync(concurrentPath, 'utf-8')).toBe('concurrent writer\n');
    // S03-B was created normally (the hook only pre-created S03-A).
    const evidenceB = path.join(root, 'delivery', 'stages', 'S03', 'evidence', 'S03-B.md');
    expect(existsSync(evidenceB)).toBe(true);
    expect(readFileSync(evidenceB, 'utf-8')).toContain('# Slice S03-B Evidence');
    assertSnapshot(root, before, [
      'delivery/stages/S03/evidence/S03-A.md',
      'delivery/stages/S03/evidence/S03-B.md',
    ]);
  });
});

// ============================================================
// validate S2 regression parity on the built host (PO-S03-A-01/04)
// ============================================================

describe('validate S2 regression parity on the built host (PO-S03-A-01/04)', () => {
  it('valid fixture: plugin validate Data deep-equals the CLI validate JSON', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const manifestPath = writeManifest(root);

    const cli = spawnSync(process.execPath, [DIST_VALIDATE_CLI, tasksPath, manifestPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(cli.status).toBe(0);
    const cliJson = JSON.parse(cli.stdout) as { valid: boolean; stage_id: string; errors: unknown[] };

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: ok');
    expect(extractDataLine(envelope.output)).toEqual(cliJson);
    // validate is read-only: full artifact snapshot allows only logs.
    assertSnapshot(root, before, []);
  });

  it('invalid fixture: plugin validate Data deep-equals the CLI validate JSON', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root, unclosedTasksMd());
    const manifestPath = writeManifest(root);

    const cli = spawnSync(process.execPath, [DIST_VALIDATE_CLI, tasksPath, manifestPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    // validate-stage prints the JSON to stdout even for invalid fixtures and
    // exits non-zero when `valid:false` (the JSON is the canonical payload).
    expect(cli.status).toBe(1);
    const cliJson = JSON.parse(cli.stdout) as { valid: boolean; stage_id: string; errors: unknown[] };
    expect(cliJson.valid).toBe(false);

    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));
    const envelope = await tool.execute(
      { operation: 'validate', tasks_path: tasksPath, manifest_path: manifestPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('Status: failed');
    expect(extractDataLine(envelope.output)).toEqual(cliJson);
    assertSnapshot(root, before, []);
  });
});

// ============================================================
// Abort battery + unsupported no-write (PO-S03-A-04)
// ============================================================

describe('abort battery and unsupported no-write on the built host (PO-S03-A-04)', () => {
  it('pre-aborted caller: AbortError propagates and NOTHING is written', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = path.join(root, '.proofloop', 'manifests', 'S3.json');
    const controller = new AbortController();
    controller.abort();
    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'compile', tasks_path: tasksPath, manifest_path: outputPath },
        makeToolContext(root, 'planner', controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
    expect(existsSync(outputPath)).toBe(false);
    assertSnapshot(root, before, []);
  });

  it('abort after completion: AbortError propagates, never a clean PASS, never a write', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const controller = new AbortController();
    const tool = makePlanTool(plugin, makeContext(plugin, root), {
      validate: () => {
        controller.abort();
        return {
          ok: true,
          data: { valid: true, stage_id: 'S03', errors: [] },
          findings: [],
          refs: [],
          runtime: { runtimeVersion: '', pluginVersion: '', schemaVersion: 0 },
        };
      },
    });

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'validate', tasks_path: 'tasks.md', manifest_path: 'manifest.json' },
        makeToolContext(root, 'planner', controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
  });

  it('unsupported operation: canonical Finding, no dispatch, NO write anywhere', async () => {
    const plugin = await loadBuilt();
    const { root } = makeWorktree();
    const tasksPath = writeTasks(root);
    const outputPath = path.join(root, '.proofloop', 'manifests', 'S3.json');
    const before = snapshotTree(root);
    const tool = makePlanTool(plugin, makeContext(plugin, root));

    const envelope = await tool.execute(
      { operation: 'run_gate', tasks_path: tasksPath, manifest_path: outputPath },
      makeToolContext(root, 'planner'),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(path.join(root, 'delivery'))).toBe(false);
    assertSnapshot(root, before, []);
  });
});
