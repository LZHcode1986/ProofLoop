/**
 * @proofloop/opencode-plugin — proofloop_stage wiring spec (S02-A-T02).
 *
 * PO: PO-S02-A-02, PO-S02-A-03, PO-S02-A-04
 *
 * S02-A-T02 wires the two operation handlers into the T01 contract layer:
 *
 *   - `status` → runtime public seam `reconcileStage({projectRoot, stageId,
 *     manifestPath?, tasksMdPath?})` → a bounded status summary (≤ STATUS_BUDGET
 *     UTF-16 chars) carried by a unified ToolResult whose `data` is a compact
 *     facts projection (never the full reconcile object, never Receipt bodies).
 *   - `next` → runtime public seam `NextActionService.nextAction({projectRoot,
 *     stageId, manifestPath?, tasksPath?})` → the canonical 5-key
 *     NextActionOutput preserved verbatim (action / action_detail /
 *     responsible_role / receipt_chain_valid / findings), compact ≤
 *     NEXT_BUDGET UTF-16 chars, findings ≤ 20.
 *
 * The runtime is the ORACLE: each handler output is compared against a direct
 * call of the runtime public seam on the same real temp fixture. Fixtures are
 * REAL filesystem projects (temp dir + real git repo + canonical `.proofloop`
 * manifest layout + tasks.md + evidence), mirroring the runtime's own
 * integration fixtures. No mocks, no shell in production code (git is only used
 * by the test fixture builder).
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  NextActionService,
  defaultManifestPath,
  defaultTasksMdPath,
  reconcileStage,
} from '@proofloop/runtime';
import type { ReconcileStageResult, NextActionOutput } from '@proofloop/runtime';
import type { Manifest, ManifestSlice, NextAction } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import {
  createStageTool,
  stageStatusHandler,
  stageNextHandler,
} from './stage.js';
import type { StageOperationHandlers, StageResolvedArgs } from './stage.js';

// ============================================================
// Closed sets (kernel §5 — independent literals)
// ============================================================

const NEXT_ACTION_CLOSED_SET: readonly NextAction[] = [
  'DISPATCH_WORKER',
  'RUN_CV',
  'RUN_GATE',
  'ADMIT_WORKER_RESULT',
  'ADMIT_CV_RESULT',
  'ADMIT_SLICE_COMMIT',
  'ADMIT_INTEGRATION',
  'PREPARE_STAGE_REVIEW',
  'FINALIZE_STAGE_REVIEW',
  'COMPILE_ACCEPTANCE',
  'RUN_E2E',
  'INITIALIZE_EVIDENCE',
  'VALIDATE',
  'ADMIT_SPV_RESULT',
  'REPARTITION',
];

// ============================================================
// Fixture helpers (real temp dir + real git repo + real files)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

const STAGE = 'S2';
const SLICE = 'S02-A';
const TASKS = ['S02-A-T01', 'S02-A-T02'];

interface WiringFx {
  readonly root: string;
  readonly stageId: string;
  write(rel: string, content: string): void;
  writeManifest(overrides?: Partial<Manifest>): void;
  writeTasksMd(entries: readonly { id: string; checked: boolean }[]): void;
  writeEvidence(writtenTasks: readonly string[], finalized?: boolean): void;
  commitAll(): void;
  cleanup(): void;
}

function makeFx(stageId: string): WiringFx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's02a-t02-wiring-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'stage@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Stage Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const fx: WiringFx = {
    root,
    stageId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (overrides = {}) => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: 'd69204b7a2882ff8ac094e6deb4bb3b04c508462776d7e89d0e8d513f3388128',
        stage_goal: 'Stage S2 — read-only tools',
        outcomes: ['bounded status', 'single canonical next action'],
        slices: [makeSliceDef(stageId, SLICE, TASKS)],
        dependencies: [],
        risk_facts: [],
        ...overrides,
      };
      fx.write(
        `.proofloop/manifests/${stageId}.json`,
        JSON.stringify(manifest, null, 2),
      );
    },
    writeTasksMd: (entries) => {
      const out: string[] = [`# Stage ${stageId} — read-only tools`];
      out.push(`<!-- SLICE:${SLICE}:BEGIN -->`, `## Slice ${SLICE}`);
      for (const t of entries) {
        out.push(`- [${t.checked ? 'x' : ' '}] ${t.id}: task`);
      }
      out.push(`<!-- SLICE:${SLICE}:END -->`);
      fx.write(`delivery/stages/${stageId}/tasks.md`, out.join('\n'));
    },
    writeEvidence: (writtenTasks, finalized = false) => {
      const out: string[] = [`# Slice ${SLICE} Evidence`, '', '## Task Evidence', ''];
      for (const t of writtenTasks) {
        out.push(`### ${t}`, '', '- Task Goal: read-only tool', '- Status: COMPLETE', '');
      }
      out.push(
        '## Current Slice Evidence',
        '',
        '### Proof Obligation Coverage',
        '',
        '| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |',
        '|---|---|---|---|---|',
      );
      if (finalized) {
        out.push(`| PO-S02-A-01 | integration | r1 | g1 | PASS |`);
      } else {
        out.push(`| *None* | | | | |`);
      }
      out.push('', '## Current CV Status', '', '- Status: NOT_RUN', '');
      fx.write(`delivery/stages/${stageId}/evidence/${SLICE}.md`, out.join('\n'));
    },
    commitAll: () => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fixture']);
    },
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Schema-valid manifest slice (known-good literals). */
function makeSliceDef(
  stageId: string,
  sliceId: string,
  taskIds: readonly string[],
): ManifestSlice {
  return {
    slice_id: sliceId,
    goal: 'stage status/next wiring',
    observable_outcome: 'bounded status and single canonical next action',
    public_seam: 'reconcileStage + NextActionService',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S02-A-02',
        behavior: 'next preserves the canonical NextActionOutput payload',
        public_seam: 'NextActionService',
        oracle_source: 'real fixture project',
        success_criteria: 'payload deep-equal',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['core_state_machine'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sliceId}.md`,
    cv_minimum_level: 'enhanced',
  };
}

/** Consistent fixture: manifest + git + tasks (T01 checked) + T01 evidence. */
function consistentFixture(): WiringFx {
  const fx = makeFx(STAGE);
  fx.writeManifest();
  fx.writeTasksMd([
    { id: 'S02-A-T01', checked: true },
    { id: 'S02-A-T02', checked: false },
  ]);
  fx.writeEvidence(['S02-A-T01']);
  fx.commitAll();
  return fx;
}

/** Complete fixture: all tasks checked + evidence finalized (no receipts). */
function completeFixture(): WiringFx {
  const fx = makeFx(STAGE);
  fx.writeManifest();
  fx.writeTasksMd([
    { id: 'S02-A-T01', checked: true },
    { id: 'S02-A-T02', checked: true },
  ]);
  fx.writeEvidence(TASKS, true);
  fx.commitAll();
  return fx;
}

/** Broken fixture: no manifest, no git — reconcile fails closed. */
function brokenFixture(): WiringFx {
  const fx = makeFx(STAGE);
  return fx;
}

// ============================================================
// Real-shaped context / tool helpers
// ============================================================

function makeContext(root: string): RuntimeContext {
  const input = {
    client: { app: { log: () => undefined } },
    project: {},
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1:5178'),
    $: {} as PluginInput['$'],
  } as unknown as PluginInput;
  return createRuntimeContext(input);
}

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s02a-t02',
    messageID: 'msg-s02a-t02',
    agent: 'executor',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

function resolvedArgs(root: string, operation: 'status' | 'next'): StageResolvedArgs {
  return { operation, stageId: STAGE, projectRoot: root };
}

/**
 * Narrow execute return to the `{ output }` host envelope the tool always
 * produces (the host `ToolResult` type is a string | object union; every
 * proofloop_stage execution returns the object envelope).
 */
function makeTool(
  context: RuntimeContext,
  handlers?: StageOperationHandlers,
): {
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
} {
  return createStageTool(context, handlers) as {
    execute: (
      args: Record<string, unknown>,
      context: ToolContext,
    ) => Promise<{ output: string }>;
  };
}

/** Extract the compact status/next block from the host output. */
function extractBlock(output: string, marker: string): string {
  const idx = output.indexOf(`${marker}\n`);
  if (idx < 0) return '';
  const start = idx + marker.length + 1;
  const findingsIdx = output.indexOf('\nFindings', start);
  const end = findingsIdx < 0 ? output.length : findingsIdx;
  return output.slice(start, end);
}

describe('stage wiring: status → reconcileStage (PO-S02-A-03)', () => {
  it('derives the status from the real reconcile seam (oracle comparison)', () => {
    const fx = consistentFixture();
    const input = resolvedArgs(fx.root, 'status');
    const handler = stageStatusHandler(input);
    const reconciled = reconcileStage({
      projectRoot: fx.root,
      stageId: STAGE,
    });

    expect(handler.result.ok).toBe(true);
    expect(handler.result.findings).toEqual([]);
    expect(handler.result.data).toBeDefined();
    const data = handler.result.data as Record<string, unknown>;
    expect(data['stage_id']).toBe(reconciled.stage_id);
    expect(data['stage_state']).toBe(reconciled.stage_state);
    expect(data['project_state']).toBe(reconciled.project_state);
    expect(data['receipt_chain_valid']).toBe(reconciled.receipt_chain_valid);
    expect(data['slices']).toHaveLength(reconciled.slices.length);
  });

  it('keeps the status summary within the 1000-char budget through execute', async () => {
    const fx = consistentFixture();
    const tool = makeTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    expect(envelope.output).toContain('ProofLoop Stage');
    expect(envelope.output).toContain('Status: ok');
    const block = extractBlock(envelope.output, 'Stage status:');
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(1000);
    expect(block).toContain('Stage: S2');
  });

  it('does not leak receipt bodies or the full reconcile object into the status data', () => {
    const fx = completeFixture();
    const handler = stageStatusHandler(resolvedArgs(fx.root, 'status'));
    const data = handler.result.data as Record<string, unknown>;

    // No full reconcile fields: no digest chain, no per-slice receipt bodies.
    expect('receipt_chain' in data).toBe(false);
    expect('receipt_categories' in data).toBe(false);
    expect('latest_cv_receipt' in data).toBe(false);
    expect('latest_commit_receipt' in data).toBe(false);
    const slices = data['slices'] as Record<string, unknown>[];
    for (const slice of slices) {
      expect('latest_cv_receipt' in slice).toBe(false);
      expect('latest_commit_receipt' in slice).toBe(false);
    }
  });

  it('fails closed with a canonical finding when the manifest is missing', async () => {
    const fx = brokenFixture();
    const tool = makeTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    expect(envelope.output).toContain('ProofLoop Stage');
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
  });

  it('rejects an IN-ROOT symlink redirect of the canonical tasks path (DIAGNOSE-2 same-layer)', () => {
    // Same-layer semantic as plan-validate reverifyResolvedPaths (CV
    // S02-B-RECHECK-PO01-INROOT-SYMLINK-REDIRECT): the status handler must not
    // read a canonical path that was swapped to an alternate in-root file.
    const fx = completeFixture();
    const root = fx.root;
    // Canonical paths identical to what parseStageArgs would resolve.
    const tasksPath = defaultTasksMdPath(root, STAGE);
    const manifestPath = defaultManifestPath(root, STAGE);
    const args: StageResolvedArgs = {
      operation: 'status',
      stageId: STAGE,
      projectRoot: root,
      manifestPath,
      tasksPath,
    };
    // Build the alternate in-root file and swap the canonical tasks path.
    const alternatePath = path.join(root, 'alternate-tasks.md');
    fs.writeFileSync(alternatePath, '# alternate, not the canonical tasks\n', 'utf-8');
    fs.rmSync(tasksPath, { force: true });
    fs.symlinkSync('alternate-tasks.md', tasksPath);
    const handler = stageStatusHandler(args);
    expect(handler.result.ok).toBe(false);
    expect(
      handler.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
    ).toBe(true);
  });

  it('rejects an IN-ROOT symlink redirect of the DEFAULT tasks path when no explicit path is given (DIAGNOSE-3)', () => {
    // CV S02-B-RECHECK-3: reverifyStagePaths skips undefined paths. When the
    // caller omits manifest_path/tasks_path, the runtime uses the default
    // tasks.md (defaultTasksMdPath) — that default must also be identity
    // re-verified, else a swapped in-root alternate is silently read.
    const fx = completeFixture();
    const root = fx.root;
    const args: StageResolvedArgs = {
      operation: 'status',
      stageId: STAGE,
      projectRoot: root,
      // NO explicit manifest/tasks paths — runtime defaults apply.
    };
    const defaultTasks = defaultTasksMdPath(root, STAGE);
    expect(existsSync(defaultTasks)).toBe(true);
    // Build the alternate in-root file and swap the DEFAULT tasks path.
    const alternatePath = path.join(root, 'alternate-tasks.md');
    fs.writeFileSync(alternatePath, '# alternate, not the canonical tasks\n', 'utf-8');
    fs.rmSync(defaultTasks, { force: true });
    fs.symlinkSync('alternate-tasks.md', defaultTasks);
    const handler = stageStatusHandler(args);
    expect(handler.result.ok).toBe(false);
    expect(
      handler.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
    ).toBe(true);
  });

  it('rejects an IN-ROOT symlink redirect of the DEFAULT manifest path when no explicit path is given (DIAGNOSE-3)', () => {
    const fx = completeFixture();
    const root = fx.root;
    const args: StageResolvedArgs = {
      operation: 'next',
      stageId: STAGE,
      projectRoot: root,
    };
    const defaultManifest = defaultManifestPath(root, STAGE);
    expect(existsSync(defaultManifest)).toBe(true);
    const alternateManifest = path.join(root, 'alternate-manifest.json');
    fs.writeFileSync(alternateManifest, '{"not":"the manifest"}', 'utf-8');
    fs.rmSync(defaultManifest, { force: true });
    fs.symlinkSync('alternate-manifest.json', defaultManifest);
    const handler = stageNextHandler(args);
    expect(handler.result.ok).toBe(false);
    expect(
      handler.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
    ).toBe(true);
  });
});

describe('stage wiring: next → NextActionService (PO-S02-A-02)', () => {
  it('returns the full canonical 5-key payload identical to NextActionService', () => {
    const fx = consistentFixture();
    const handler = stageNextHandler(resolvedArgs(fx.root, 'next'));
    const output = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: STAGE,
    });

    expect(handler.result.ok).toBe(true);
    expect(handler.result.data).toEqual({
      action: output.action,
      action_detail: output.action_detail,
      responsible_role: output.responsible_role,
      receipt_chain_valid: output.receipt_chain_valid,
      findings: output.findings,
    });
  });

  it('preserves action_detail and responsible_role from the runtime (no reimplementation)', () => {
    const fx = consistentFixture();
    const handler = stageNextHandler(resolvedArgs(fx.root, 'next'));
    const output = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: STAGE,
    });
    const data = handler.result.data as Record<string, unknown>;

    expect(typeof data['action_detail']).toBe('string');
    expect((data['action_detail'] as string).length).toBeGreaterThan(0);
    expect(data['action_detail']).toBe(output.action_detail);
    expect(data['responsible_role']).toBe(output.responsible_role);
  });

  it('keeps the next compact within the 1500-char budget through execute', async () => {
    const fx = completeFixture();
    const tool = makeTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'next', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    expect(envelope.output).toContain('ProofLoop Stage');
    expect(envelope.output).toContain('Next action:');
    const block = extractBlock(envelope.output, 'Next action:');
    expect(block.length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(1500);
    expect(block).toContain('Action:');
  });

  it('returns a single 15-value action through the default wiring', async () => {
    const fx = completeFixture();
    const tool = makeTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'next', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    const actionMatch = envelope.output.match(/Action: ([A-Z_]+)/);
    expect(actionMatch).not.toBeNull();
    const action = actionMatch?.[1] as NextAction;
    expect(NEXT_ACTION_CLOSED_SET).toContain(action);
  });

  it('caps findings at the 20-entry tool budget in the host output', async () => {
    const fx = brokenFixture();
    const tool = makeTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'next', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    const findingsMatch = envelope.output.match(/Findings \((\d+)\):/);
    expect(findingsMatch).not.toBeNull();
    const count = Number(findingsMatch?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(20);
  });
});

describe('stage wiring: cancellation boundary (PO-S02-A-04)', () => {
  it('propagates caller abort through the default wiring as AbortError', async () => {
    const fx = consistentFixture();
    const controller = new AbortController();
    controller.abort();
    const tool = makeTool(makeContext(fx.root));

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'status', stage_id: STAGE },
        makeToolContext(fx.root, controller.signal),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe('AbortError');
  });

  it('rejects stage_id path traversal before any runtime read (canonical guard)', async () => {
    const fx = consistentFixture();
    const tool = makeTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'next', stage_id: '../../../../tmp/attacker' },
      makeToolContext(fx.root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).not.toContain('DOMAIN.STAGE_NOT_FOUND');
  });
});
