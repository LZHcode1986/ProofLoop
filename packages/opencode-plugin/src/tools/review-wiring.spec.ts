/**
 * @proofloop/opencode-plugin — proofloop_review wiring spec (S02-C-T02).
 *
 * PO: PO-S02-C-02 (review stage_status ↔ stage status consistency),
 * PO-S02-C-03 (fail-closed / abort / default-path reverify boundary).
 *
 * S02-C-T02 wires the `stage_status` handler into the T01 contract layer:
 *
 *   - `reviewStageStatusHandler` delegates to the S02-A `stageStatusHandler` —
 *     the literal SAME handler `proofloop_stage(status)` wires — so the two
 *     host tools report IDENTICAL canonical data/summary/findings on the same
 *     fixture (PO-S02-C-02). The status is derived ONLY from the runtime
 *     public `reconcileStage` read seam; the plugin never re-derives state.
 *   - default wiring: `createReviewTool` injects the built-in handler by
 *     default (the handler seam remains injectable for tests/extension).
 *   - the default-path identity reverify (S02-A `reverifyStagePaths` inside
 *     `stageStatusHandler`) runs before every runtime read: an in-root symlink
 *     redirect of the canonical/default manifest or tasks path fails closed
 *     with HOST.PATH_OUTSIDE_PROJECT.
 *   - error-level reconcile findings (e.g. missing manifest →
 *     DOMAIN.STAGE_NOT_FOUND) fail closed (ok:false); caller abort propagates
 *     AbortError; the status summary stays ≤1000 UTF-16 chars and findings are
 *     capped at 20.
 *
 * The runtime is the ORACLE: handler outputs are compared against a direct
 * call of the runtime public seam (`reconcileStage`) AND against the sibling
 * `proofloop_stage(status)` output on the same real temp fixture (real
 * filesystem project + real git repo + canonical `.proofloop` manifest layout
 * + tasks.md + evidence). No mocks, no shell in production code (git is only
 * used by the test fixture builder).
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  defaultManifestPath,
  defaultTasksMdPath,
  reconcileStage,
} from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createStageTool, stageStatusHandler } from './stage.js';
import type { StageResolvedArgs } from './stage.js';
import { createReviewTool, reviewStageStatusHandler } from './review.js';
import type { ReviewResolvedArgs } from './review.js';

const STAGE = 'S2';
const SLICE = 'S02-A';
const TASKS = ['S02-A-T01', 'S02-A-T02'];

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's02c-t02-wiring-'));
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
    sessionID: 'sess-s02c-t02',
    messageID: 'msg-s02c-t02',
    agent: 'stage-reviewer',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

function reviewArgs(root: string): ReviewResolvedArgs {
  return { operation: 'stage_status', stageId: STAGE, projectRoot: root };
}

function stageArgs(root: string): StageResolvedArgs {
  return { operation: 'status', stageId: STAGE, projectRoot: root };
}

type ExecuteTool = {
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makeReviewTool(context: RuntimeContext): ExecuteTool {
  return createReviewTool(context) as ExecuteTool;
}

function makeStageTool(context: RuntimeContext): ExecuteTool {
  return createStageTool(context) as ExecuteTool;
}

/** Extract the compact status block from the host output. */
function extractBlock(output: string, marker: string): string {
  const idx = output.indexOf(`${marker}\n`);
  if (idx < 0) return '';
  const start = idx + marker.length + 1;
  const findingsIdx = output.indexOf('\nFindings', start);
  const end = findingsIdx < 0 ? output.length : findingsIdx;
  return output.slice(start, end);
}

describe('review wiring: stage_status → reconcileStage shared projection (PO-S02-C-02)', () => {
  it('derives the status from the same reconcile seam as proofloop_stage (handler parity)', () => {
    const fx = consistentFixture();
    const review = reviewStageStatusHandler(reviewArgs(fx.root));
    const stage = stageStatusHandler(stageArgs(fx.root));
    const reconciled = reconcileStage({
      projectRoot: fx.root,
      stageId: STAGE,
    });

    // Literally the SAME handler: ok / data / findings / statusText identical.
    expect(review.result.ok).toBe(stage.result.ok);
    expect(review.result.data).toEqual(stage.result.data);
    expect(review.result.findings).toEqual(stage.result.findings);
    expect(review.statusText).toBe(stage.statusText);
    // And the review projection still matches the runtime oracle facts.
    expect(review.result.ok).toBe(true);
    const data = review.result.data as Record<string, unknown>;
    expect(data['stage_id']).toBe(reconciled.stage_id);
    expect(data['stage_state']).toBe(reconciled.stage_state);
    expect(data['project_state']).toBe(reconciled.project_state);
    expect(data['receipt_chain_valid']).toBe(reconciled.receipt_chain_valid);
    expect(data['slices']).toHaveLength(reconciled.slices.length);
  });

  it('host execute: review stage_status block is character-identical to stage status and ≤1000', async () => {
    const fx = consistentFixture();
    const reviewTool = makeReviewTool(makeContext(fx.root));
    const stageTool = makeStageTool(makeContext(fx.root));
    const reviewEnvelope = await reviewTool.execute(
      { operation: 'stage_status', stage_id: STAGE },
      makeToolContext(fx.root),
    );
    const stageEnvelope = await stageTool.execute(
      { operation: 'status', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    const reviewBlock = extractBlock(reviewEnvelope.output, 'Stage status:');
    const stageBlock = extractBlock(stageEnvelope.output, 'Stage status:');
    expect(reviewBlock).toBe(stageBlock);
    expect(reviewBlock.length).toBeGreaterThan(0);
    expect(reviewBlock.length).toBeLessThanOrEqual(1000);
    expect(reviewBlock).toContain('Stage: S2');
  });

  it('host execute: review output carries the canonical envelope on a valid fixture', async () => {
    const fx = consistentFixture();
    const tool = makeReviewTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'stage_status', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    expect(envelope.output).toContain('ProofLoop Review');
    expect(envelope.output).toContain('Operation: stage_status');
    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('Stage status:');
    expect(envelope.output).toContain('Findings: none');
  });

  it('does not leak receipt bodies or the full reconcile object into the review status data', () => {
    const fx = completeFixture();
    const handler = reviewStageStatusHandler(reviewArgs(fx.root));
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

  it('fails closed with a canonical finding when the manifest is missing (default wiring)', async () => {
    const fx = brokenFixture();
    const tool = makeReviewTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'stage_status', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    expect(envelope.output).toContain('ProofLoop Review');
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
  });

  it('caps findings at the 20-entry tool budget in the host output', async () => {
    const fx = brokenFixture();
    const tool = makeReviewTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'stage_status', stage_id: STAGE },
      makeToolContext(fx.root),
    );

    const findingsMatch = envelope.output.match(/Findings \((\d+)\):/);
    expect(findingsMatch).not.toBeNull();
    const count = Number(findingsMatch?.[1] ?? 0);
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(20);
  });

  it('rejects an IN-ROOT symlink redirect of the DEFAULT tasks path (reverify semantics)', () => {
    // Same-layer semantic as S02-A CV S02-B-RECHECK-3 / DIAGNOSE-3: the
    // review handler must not read a canonical path that was swapped to an
    // alternate in-root file — the default-path identity reverify runs inside
    // the shared stageStatusHandler before every runtime read.
    const fx = completeFixture();
    const root = fx.root;
    const defaultTasks = defaultTasksMdPath(root, STAGE);
    expect(existsSync(defaultTasks)).toBe(true);
    const alternatePath = path.join(root, 'alternate-tasks.md');
    fs.writeFileSync(alternatePath, '# alternate, not the canonical tasks\n', 'utf-8');
    fs.rmSync(defaultTasks, { force: true });
    fs.symlinkSync('alternate-tasks.md', defaultTasks);
    const handler = reviewStageStatusHandler(reviewArgs(root));
    expect(handler.result.ok).toBe(false);
    expect(
      handler.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
    ).toBe(true);
  });

  it('rejects an IN-ROOT symlink redirect of the DEFAULT manifest path (reverify semantics)', () => {
    const fx = completeFixture();
    const root = fx.root;
    const defaultManifest = defaultManifestPath(root, STAGE);
    expect(existsSync(defaultManifest)).toBe(true);
    const alternateManifest = path.join(root, 'alternate-manifest.json');
    fs.writeFileSync(alternateManifest, '{"not":"the manifest"}', 'utf-8');
    fs.rmSync(defaultManifest, { force: true });
    fs.symlinkSync('alternate-manifest.json', defaultManifest);
    const handler = reviewStageStatusHandler(reviewArgs(root));
    expect(handler.result.ok).toBe(false);
    expect(
      handler.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
    ).toBe(true);
  });
});

describe('review wiring: cancellation boundary (PO-S02-C-03)', () => {
  it('propagates caller abort through the default wiring as AbortError', async () => {
    const fx = consistentFixture();
    const controller = new AbortController();
    controller.abort();
    const tool = makeReviewTool(makeContext(fx.root));

    let thrown: unknown;
    try {
      await tool.execute(
        { operation: 'stage_status', stage_id: STAGE },
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
    const tool = makeReviewTool(makeContext(fx.root));
    const envelope = await tool.execute(
      { operation: 'stage_status', stage_id: '../../../../tmp/attacker' },
      makeToolContext(fx.root),
    );
    expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).not.toContain('DOMAIN.STAGE_NOT_FOUND');
  });
});
