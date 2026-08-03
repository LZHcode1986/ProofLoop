/**
 * S3 Active Registration Gate — exact four-tool / doctor-only matrix
 * (PO-S03-E-01, PO-S03-E-05).
 *
 * The S03-A/B/C/D operation definitions must be wired into the ACTIVE
 * registration gate of the BUILT plugin (`packages/opencode-plugin/dist/
 * index.js`, file-URL host-load seam — never a source import for the matrix).
 *
 * Required Success Behaviors (T01 proof matrix):
 *   1. active valid-lock fixture → `Hooks.tool` exact keys =
 *      `proofloop_doctor` | `proofloop_plan` | `proofloop_stage` |
 *      `proofloop_review` (NO other keys); each tool exposes a real
 *      `description`, a REAL vendored-zod `args` raw-shape whose `operation`
 *      field carries the S2+S3 canonical operation set, and a real executable
 *      `execute` that dispatches through the built host seam (representative
 *      ops: plan validate, stage status, review stage_status — the S3 write
 *      ops are proven deeply by T02/T03, but the definitions must be present).
 *   2. ordinary / missing-lock / bad-lock / version-incompatible fixtures →
 *      exact keys = ONLY `proofloop_doctor`.
 *   3. NO hooks (top-level Hooks = `{ tool }` only, no
 *      tool.before/tool.after/command/permission/event), NO `proofloop_project`
 *      tool, NO run_gate/gate/E2E operation anywhere in the definitions
 *      (the stage operation enum MUST NOT contain run_gate /
 *      admit_gate_result / admit_gate_interrupted), and NO role-policy /
 *      authorization matrix capability.
 *   4. Doctor always present in every project state (FR-006).
 *
 * The operation enums are asserted against the REGISTERED built `args`
 * (zod v4 enum `.options`) — not against source constants — so a fake args
 * schema or a registration drift (a registered tool whose enum differs from
 * the canonical contract) fails the matrix. The canonical closed sets are
 * asserted as known-good literals (independent source of truth), not
 * re-derived from the plugin modules.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUNTIME_LOCK_EXPECTATIONS } from './runtime-lock.js';
import * as srcEntry from './index.js';

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

type PluginInputShape = Parameters<NonNullable<typeof srcEntry.server>>[0];

type RegisteredTool = {
  description: string;
  args: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: {
      sessionID: string;
      messageID: string;
      agent: string;
      directory: string;
      worktree: string;
      abort: AbortSignal;
      metadata(): void;
      ask(): Promise<void>;
    },
  ) => Promise<{ output: string }>;
};

// Canonical tool keys (independent literals, not source-derived).
const DOCTOR_KEY = 'proofloop_doctor';
const PLAN_KEY = 'proofloop_plan';
const STAGE_KEY = 'proofloop_stage';
const REVIEW_KEY = 'proofloop_review';

/** Exact S3 active tool set (PO-S03-E-01). */
const ACTIVE_KEYS = [DOCTOR_KEY, PLAN_KEY, STAGE_KEY, REVIEW_KEY];

/** Exact inactive / non-ProofLoop tool set (PO-S03-E-01). */
const INACTIVE_KEYS = [DOCTOR_KEY];

/** Canonical S3 plan operation set (contract-state-matrix §1.1). */
const PLAN_OPS: readonly string[] = [
  'validate',
  'compile',
  'initialize_evidence',
  'status',
  'admit_spv_result',
];

/** Canonical S3 stage operation set (contract-state-matrix §1.2). */
const STAGE_OPS: readonly string[] = [
  'status',
  'next',
  'admit_worker_result',
  'admit_cv_result',
  'admit_slice_commit',
  'admit_integration',
];

/** Canonical S3 review operation set (contract-state-matrix §1.3). */
const REVIEW_OPS: readonly string[] = ['stage_status', 'prepare_stage_review', 'finalize_stage_review'];

/** S4/S5 operations that must NEVER appear in the registered enums. */
const FORBIDDEN_OPS = [
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
  'compile_acceptance',
  'run_e2e',
  'stage_plan',
  'admit_stage_plan',
  'prepare_project_review',
  'finalize_project_review',
  'project_status',
];

/** S5 / role-policy capability keys that must NEVER appear in Hooks.tool. */
const FORBIDDEN_TOOL_KEYS = [
  'proofloop_project',
  'run_gate',
  'gate',
  'authorization',
  'role_policy',
  'roles',
];

/** Canonical host `args` field names per registered S3 tool. */
const EXPECTED_ARGS_FIELDS: Record<string, string[]> = {
  [DOCTOR_KEY]: [],
  [PLAN_KEY]: [
    'operation',
    'tasks_path',
    'manifest_path',
    'project_root',
    'evidence_dir',
    'stage_id',
    'manifest_digest',
    'summary',
    'verdict',
  ],
  [STAGE_KEY]: [
    'operation',
    'stage_id',
    'slice_id',
    'project_root',
    'manifest_path',
    'tasks_path',
    'envelope',
    'verdict',
    'snapshot_digest',
    'commit_sha',
    'cv_receipt_digest',
    'integration_ref',
    'summary',
  ],
  [REVIEW_KEY]: ['operation', 'stage_id', 'project_root', 'scope', 'verdict', 'summary'],
};

interface ProjectFixture {
  root: string;
  cleanup: () => void;
}

function makeDir(): ProjectFixture {
  const root = mkdtempSync(path.join(tmpdir(), 's03e-reg-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeMissingLock(): ProjectFixture {
  const root = mkdtempSync(path.join(tmpdir(), 's03e-reg-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeBadLock(): ProjectFixture {
  const root = mkdtempSync(path.join(tmpdir(), 's03e-reg-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  writeFileSync(path.join(root, '.proofloop', 'runtime.lock'), '{ not valid json');
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Lock passes schema/normalization but is VERSION-INCOMPATIBLE → inactive. */
function makeIncompatibleLock(): ProjectFixture {
  const e = RUNTIME_LOCK_EXPECTATIONS;
  const lock = {
    runtime_version: '999.0.0',
    domain_schema_version: e.schemaVersion,
    risk_policy_version: 1,
    capability_policy_version: 1,
    host_adapter: e.hostAdapter,
    plugin_package: e.pluginPackage,
    plugin_version: e.pluginVersion.ok ? e.pluginVersion.version : '0.1.0',
  };
  const root = mkdtempSync(path.join(tmpdir(), 's03e-reg-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  writeFileSync(
    path.join(root, '.proofloop', 'runtime.lock'),
    JSON.stringify(lock, null, 2),
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function makeActiveValidLock(): ProjectFixture {
  const e = RUNTIME_LOCK_EXPECTATIONS;
  const lock = {
    runtime_version: e.runtimeVersion.ok ? e.runtimeVersion.version : '0.1.0',
    domain_schema_version: e.schemaVersion,
    risk_policy_version: 1,
    capability_policy_version: 1,
    host_adapter: e.hostAdapter,
    plugin_package: e.pluginPackage,
    plugin_version: e.pluginVersion.ok ? e.pluginVersion.version : '0.1.0',
  };
  const root = mkdtempSync(path.join(tmpdir(), 's03e-reg-'));
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  writeFileSync(
    path.join(root, '.proofloop', 'runtime.lock'),
    JSON.stringify(lock, null, 2),
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.proofloop/runtime.lock'], { cwd: root });
  execFileSync(
    'git',
    ['-c', 'user.name=ProofLoop Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init'],
    { cwd: root },
  );
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

beforeAll(() => {
  execFileSync(
    'npm',
    ['exec', '--', 'tsc', '-b', 'packages/kernel', 'packages/runtime', 'packages/opencode-plugin'],
    { cwd: process.cwd(), stdio: 'pipe' },
  );
  expect(existsSync(DIST_ENTRY)).toBe(true);
});

const cleanups: Array<() => void> = [];

afterAll(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

async function loadBuilt(): Promise<BuiltEntry> {
  const distUrl = pathToFileURL(DIST_ENTRY);
  return (await import(distUrl.href)) as BuiltEntry;
}

function pluginInput(root: string): PluginInputShape {
  return {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {} as PluginInputShape['$'],
  } as unknown as PluginInputShape;
}

function toolContext(root: string) {
  return {
    sessionID: 'sess-s03e-t01',
    messageID: 'msg-s03e-t01',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

/** Load the built plugin on a fixture and return the Hooks object. */
async function builtHooks(root: string): Promise<Record<string, unknown>> {
  const entry = await loadBuilt();
  const plugin = (entry.default ?? entry.server) as (
    input: PluginInputShape,
  ) => Promise<Record<string, unknown>>;
  return plugin(pluginInput(root));
}

/** Minimal valid call args per registered tool (real host seam dispatch). */
function minimalCallArgs(key: string): Record<string, unknown> {
  switch (key) {
    case DOCTOR_KEY:
      return {};
    case PLAN_KEY:
      return {
        operation: 'validate',
        tasks_path: 'tasks.md',
        manifest_path: '.proofloop/manifests/S1.json',
      };
    case STAGE_KEY:
      return { operation: 'status', stage_id: 'S1' };
    case REVIEW_KEY:
      return { operation: 'stage_status', stage_id: 'S1' };
    default:
      return {};
  }
}

/** Assert the real host `tool({ description, args, execute })` shape. */
function assertToolShape(
  key: string,
  def: { description?: unknown; args?: unknown; execute?: unknown },
): void {
  expect(typeof def.description, `${key}.description must be a string`).toBe('string');
  expect((def.description as string).length, `${key}.description non-empty`).toBeGreaterThan(0);
  expect(def.args, `${key}.args must be present`).toBeDefined();
  expect(typeof def.args, `${key}.args must be an object`).toBe('object');
  expect(typeof def.execute, `${key}.execute must be a function`).toBe('function');

  const args = def.args as Record<string, unknown>;
  const expected = EXPECTED_ARGS_FIELDS[key] ?? [];
  expect(Object.keys(args).sort(), `${key}.args canonical field names`).toEqual([
    ...expected,
  ].sort());
}

/** Assert the tool dispatches through the real built host execute seam. */
async function assertExecutable(key: string, def: RegisteredTool, root: string): Promise<void> {
  const envelope = await def.execute(minimalCallArgs(key), toolContext(root));
  expect(envelope, `${key} execute must return an envelope`).toBeDefined();
  expect(typeof envelope.output, `${key} execute must return { output }`).toBe('string');
  expect(envelope.output.length, `${key} execute output non-empty`).toBeGreaterThan(0);
}

describe('S3 active registration gate (PO-S03-E-01 / PO-S03-E-05)', () => {
  it.each([
    ['ordinary non-ProofLoop directory', makeDir, INACTIVE_KEYS],
    ['missing runtime.lock', makeMissingLock, INACTIVE_KEYS],
    ['invalid (bad JSON) runtime.lock', makeBadLock, INACTIVE_KEYS],
    ['version-incompatible runtime.lock', makeIncompatibleLock, INACTIVE_KEYS],
    ['active valid-lock ProofLoop project', makeActiveValidLock, ACTIVE_KEYS],
  ] as Array<[string, () => ProjectFixture, string[]]>)(
    '%s → exact tool key set, no hooks/project/gate/role-policy leakage, real host shape, executable',
    async (_name, make, expectedKeys) => {
      const fixture = make();
      cleanups.push(fixture.cleanup);
      try {
        const hooks = await builtHooks(fixture.root);

        // COMPLETE top-level Hooks key set: ONLY the `tool` registry key.
        // No tool.before/tool.after/command/permission/event hooks (S4 absent),
        // no other capability key.
        expect(Object.keys(hooks)).toEqual(['tool']);

        const tool = hooks['tool'] as Record<string, unknown> | undefined;
        expect(tool, 'tool registry must be present').toBeDefined();
        const keys = Object.keys(tool as Record<string, unknown>);

        // Exact tool key set per project state.
        expect([...keys].sort(), 'exact tool key set').toEqual([...expectedKeys].sort());

        // Doctor always present (FR-006) in every project state.
        expect(keys, 'doctor must always register (FR-006)').toContain(DOCTOR_KEY);

        // No S4/S5 capability key anywhere in the tool registry.
        for (const forbidden of FORBIDDEN_TOOL_KEYS) {
          expect(keys, `${forbidden} must never register`).not.toContain(forbidden);
        }

        // Every registered tool satisfies the host tool shape and executes.
        for (const key of keys) {
          const def = (tool as Record<string, unknown>)[key] as RegisteredTool;
          assertToolShape(key, def);
          await assertExecutable(key, def, fixture.root);
        }
      } finally {
        fixture.cleanup();
      }
    },
  );

  it('active fixture registers the S3-expanded operation enums in the BUILT args shape', async () => {
    const fixture = makeActiveValidLock();
    cleanups.push(fixture.cleanup);
    try {
      const hooks = await builtHooks(fixture.root);
      const tool = hooks['tool'] as Record<string, RegisteredTool>;

      const planOp = tool[PLAN_KEY].args.operation as { options?: readonly string[] };
      const stageOp = tool[STAGE_KEY].args.operation as { options?: readonly string[] };
      const reviewOp = tool[REVIEW_KEY].args.operation as { options?: readonly string[] };

      // Exact S3 operation sets (independent literals) — proves the S03-A/B/C/D
      // definitions are wired into the ACTIVE registration, not a stale S2 set.
      expect(planOp.options).toEqual(PLAN_OPS);
      expect(stageOp.options).toEqual(STAGE_OPS);
      expect(reviewOp.options).toEqual(REVIEW_OPS);
    } finally {
      fixture.cleanup();
    }
  });

  it('no S4/S5 operation smuggles into any registered enum (run_gate / gate / project / e2e)', async () => {
    const fixture = makeActiveValidLock();
    cleanups.push(fixture.cleanup);
    try {
      const hooks = await builtHooks(fixture.root);
      const tool = hooks['tool'] as Record<string, RegisteredTool>;

      const enumValues: readonly (readonly string[])[] = [
        (tool[PLAN_KEY].args.operation as { options?: readonly string[] }).options ?? [],
        (tool[STAGE_KEY].args.operation as { options?: readonly string[] }).options ?? [],
        (tool[REVIEW_KEY].args.operation as { options?: readonly string[] }).options ?? [],
      ];

      for (const forbidden of FORBIDDEN_OPS) {
        for (const values of enumValues) {
          expect(values, `${forbidden} must never be a registered operation`).not.toContain(
            forbidden,
          );
        }
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('plan tool is closed to validate|compile|initialize_evidence|status|admit_spv_result only', async () => {
    const fixture = makeActiveValidLock();
    cleanups.push(fixture.cleanup);
    try {
      const hooks = await builtHooks(fixture.root);
      const tool = hooks['tool'] as Record<string, RegisteredTool>;
      const op = tool[PLAN_KEY].args.operation as { options?: readonly string[] };
      // The stage-plan / gate / project / e2e ops belong to OTHER tools or
      // later stages; they must NOT be reachable through proofloop_plan.
      for (const opName of [
        'stage_plan',
        'admit_stage_plan',
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
        'compile_acceptance',
        'run_e2e',
        'prepare_project_review',
        'finalize_project_review',
      ]) {
        expect(op.options, `${opName} must never be a plan operation`).not.toContain(opName);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('stage tool is closed to status|next|the four admits only (no run_gate / gate ops)', async () => {
    const fixture = makeActiveValidLock();
    cleanups.push(fixture.cleanup);
    try {
      const hooks = await builtHooks(fixture.root);
      const tool = hooks['tool'] as Record<string, RegisteredTool>;
      const op = tool[STAGE_KEY].args.operation as { options?: readonly string[] };
      for (const opName of [
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
        'stage_plan',
        'admit_stage_plan',
        'compile_acceptance',
        'run_e2e',
        'prepare_project_review',
        'finalize_project_review',
      ]) {
        expect(op.options, `${opName} must never be a stage operation`).not.toContain(opName);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('review tool is closed to stage_status|prepare_stage_review|finalize_stage_review only (no project ops)', async () => {
    const fixture = makeActiveValidLock();
    cleanups.push(fixture.cleanup);
    try {
      const hooks = await builtHooks(fixture.root);
      const tool = hooks['tool'] as Record<string, RegisteredTool>;
      const op = tool[REVIEW_KEY].args.operation as { options?: readonly string[] };
      for (const opName of [
        'prepare_project_review',
        'finalize_project_review',
        'project_status',
        'run_gate',
        'admit_gate_result',
        'admit_gate_interrupted',
      ]) {
        expect(op.options, `${opName} must never be a review operation`).not.toContain(opName);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('inactive fixtures register exactly doctor with no S3 definitions and no leakage', async () => {
    const fixtures = [
      ['ordinary', makeDir],
      ['missing-lock', makeMissingLock],
      ['bad-lock', makeBadLock],
      ['version-incompatible', makeIncompatibleLock],
    ] as Array<[string, () => ProjectFixture]>;
    for (const [label, make] of fixtures) {
      const fixture = make();
      cleanups.push(fixture.cleanup);
      try {
        const hooks = await builtHooks(fixture.root);
        expect(Object.keys(hooks)).toEqual(['tool']);
        const tool = hooks['tool'] as Record<string, unknown>;
        expect(Object.keys(tool).sort(), `${label} exact key set`).toEqual([DOCTOR_KEY]);
        for (const forbidden of FORBIDDEN_TOOL_KEYS) {
          expect(Object.keys(tool), `${label}: ${forbidden}`).not.toContain(forbidden);
        }
        const doctor = tool[DOCTOR_KEY] as RegisteredTool;
        assertToolShape(DOCTOR_KEY, doctor);
        const envelope = await doctor.execute({}, toolContext(fixture.root));
        expect(typeof envelope.output).toBe('string');
        expect(envelope.output.length).toBeGreaterThan(0);
      } finally {
        fixture.cleanup();
      }
    }
  });
});
