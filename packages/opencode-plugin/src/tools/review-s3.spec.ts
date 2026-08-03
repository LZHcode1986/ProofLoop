/**
 * @proofloop/opencode-plugin — proofloop_review S3 contract spec (S03-D-T01).
 *
 * PO: PO-S03-D-01 (primary — real host seam operation/args contract,
 * project/gate/unknown rejection, closed validation), PO-S03-D-05
 * (no-write/abort partial: invalid/unsupported/abort fail closed with no
 * protected-artifact change; S2 stage_status consistency preserved).
 *
 * S03-D-T01 extends the review tool contract:
 *
 *   - operation set: S2 `stage_status` PLUS `prepare_stage_review` |
 *     `finalize_stage_review` — all three accepted through the REAL built
 *     `createReviewTool(...).execute` host seam (no only-helper passes);
 *   - project-review / gate / plan-stage / unknown operations are rejected at
 *     the execute boundary with a canonical RUNTIME.SCHEMA_MISMATCH Finding,
 *     never dispatched, never a write;
 *   - operation-dependent requiredness (`scope` for prepare = 'stage' only;
 *     `verdict` ∈ closed {ACCEPTED, REPAIR} + non-empty `summary` for
 *     finalize) enforced in execute's fail-closed second validation;
 *   - cancellation (pre-aborted and abort-after-completion) propagates
 *     AbortError, never a clean PASS;
 *   - no-write: rejections / unsupported operations / abort leave
 *     `.proofloop/receipts/**` + `.proofloop/runtime/**` byte-identical;
 *     `prepare_stage_review` NEVER writes; `finalize_stage_review` ACCEPTED
 *     writes exactly one STAGE_REVIEW_PASS receipt through the runtime
 *     pipeline on an UNDER_REVIEW fixture and REPAIR writes NO receipt (legal
 *     no-Receipt branch, warn finding).
 *
 * Fixture setup MAY use the runtime admit methods in the TEST process to
 * create prerequisite receipts (the stage-plan / SPV / worker / CV / commit /
 * integration / gate chain) — production code never writes receipts outside
 * the runtime pipeline.
 */

import { describe, expect, it, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  admitCVResult,
  admitGateResult,
  admitIntegration,
  admitSliceCommit,
  admitSpvResult,
  admitStagePlan,
  admitWorkerResult,
  manifestFileDigest,
  reconcileStage,
} from '@proofloop/runtime';
import type { AdmissionDeps, SpvGateAdmissionDeps } from '@proofloop/runtime';
import { validateFinding } from '@proofloop/runtime';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { successResult } from '../tool-result.js';
import { createReviewTool, parseReviewArgs, REJECTED_REVIEW_OPERATIONS } from './review.js';
import type { ReviewOperationHandlers, ReviewResolvedArgs, ReviewToolArgsShape } from './review.js';
import { guardReviewPathRef, makeReviewRefEntry } from './review-common.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-D';
const TASKS: readonly string[] = ['S03-D-T01', 'S03-D-T02', 'S03-D-T03'];

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

// ============================================================
// Fixture (real temp git worktree + canonical layout)
// ============================================================

interface S3Fx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(message?: string): string;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): S3Fx {
  const root = mkdtempSync(path.join(tmpdir(), 's03d-t01-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03d@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03D Review']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'Reviewer 准备并受理 Stage Review',
    observable_outcome: 'prepare/finalize through the real review host seam',
    public_seam: 'Hooks.tool.proofloop_review',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-D-01',
        behavior: 'review operations accepted with closed validation',
        public_seam: 'built review tool execute',
        oracle_source: 'real fixture project',
        success_criteria: 'structured result + no write on reject',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: S3Fx = {
    root,
    stageId,
    sliceId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: () => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'S3 stage review via the real review tool seam',
        outcomes: ['prepare returns a ref-only stage ReviewInput', 'finalize admits ACCEPTED/REPAIR'],
        slices: [sliceDef(sliceId, TASKS)],
        dependencies: [],
        risk_facts: ['public_api_change', 'core_state_machine'],
      };
      fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map((t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`);
      const content =
        `# Stage ${stageId} — S3 Review\n\n` +
        `## Slice ${sliceId}\n<!-- SLICE:${sliceId}:BEGIN -->\n\n### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S03-D-01 | review-s3.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content);
    },
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
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

/** Baseline fixture: manifest + all tasks checked + evidence finalized + commit. */
function baselineFx(): S3Fx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll('baseline');
  return fx;
}

/** Worker envelope for fixture prerequisite admits (finalize-slice by default). */
function makeEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: `tok-${Math.random().toString(36).slice(2)}`,
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S03-D-T01',
    mode: 'finalize-slice',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/opencode-plugin/src/tools/review.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 't01 worker',
    ...overrides,
  };
}

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

/**
 * Build a stage in UNDER_REVIEW: STAGE_PLAN + SPV_PASS + worker finalize-slice
 * → CV PASS → SLICE_COMMIT → INTEGRATION_PASS, then commit the receipts and
 * add a GATE_PASS receipt (git-clean + HEAD-bound). The stage derives
 * UNDER_REVIEW from persisted facts.
 */
function underReviewFx(): { fx: S3Fx; head: string; manifestDigest: string } {
  const fx = baselineFx();
  const head = gitHead(fx.root);
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
  // Commit the prerequisite receipts so the working tree is clean for the
  // git-clean gate precondition; the new HEAD is a descendant of the original.
  fx.commitAll('prerequisite receipts');
  const head2 = gitHead(fx.root);
  const gate = admitGateResult(
    { type: 'gate_result', stageId: STAGE_ID, verdict: 'PASS', manifestDigest, snapshotDigest: head2, summary: 'gate pass' },
    spvDeps,
  );
  expect(gate.accepted).toBe(true);
  expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
    'UNDER_REVIEW',
  );
  return { fx, head: head2, manifestDigest };
}

// ============================================================
// Real-shaped context / tool helpers
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

function makeContext(root: string): RuntimeContext {
  return createRuntimeContext(makeInput(root));
}

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s03d-t01',
    messageID: 'msg-s03d-t01',
    agent: 'stage-reviewer',
    directory: root,
    worktree: root,
    abort,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type ReviewExecuteTool = {
  args: ReviewToolArgsShape;
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

function makeTool(
  context: RuntimeContext,
  handlers?: ReviewOperationHandlers,
): ReviewExecuteTool {
  return createReviewTool(context, handlers) as unknown as ReviewExecuteTool;
}

/** Extract the canonical ToolResult `data` projection from the host output. */
function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
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

function reviewReceipts(root: string): any[] {
  const dir = path.join(root, '.proofloop', 'receipts', 'review', STAGE_ID);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf-8')));
}

// ============================================================
// PO-S03-D-01 — operation / args contract through the real seam
// ============================================================

describe('review S3 operation contract (PO-S03-D-01)', () => {
  it('stage_status still dispatches through the real seam (S2 regression)', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        stage_status: vi.fn((_i: ReviewResolvedArgs) =>
          successResult({ data: { op: 'stage_status' } }),
        ),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: STAGE_ID },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('ProofLoop Review');
      expect(envelope.output).toContain('Operation: stage_status');
      expect(envelope.output).toContain('Status: ok');
      expect(handlers.stage_status).toHaveBeenCalledTimes(1);
    } finally {
      project.cleanup();
    }
  });

  it('prepare_stage_review is accepted by parse (stage_id + optional scope=stage)', () => {
    const project = baselineFx();
    try {
      const parsed = parseReviewArgs(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
        project.root,
      );
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.args.operation).toBe('prepare_stage_review');
        expect(parsed.args.stageId).toBe(STAGE_ID);
        expect(parsed.args.scope).toBe('stage');
      }
      const parsedNoScope = parseReviewArgs(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        project.root,
      );
      expect(parsedNoScope.ok).toBe(true);
    } finally {
      project.cleanup();
    }
  });

  it('finalize_stage_review is accepted by parse (stage_id + verdict + optional summary)', () => {
    const project = baselineFx();
    try {
      for (const verdict of ['ACCEPTED', 'REPAIR'] as const) {
        const parsed = parseReviewArgs(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict, summary: 's' },
          project.root,
        );
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.args.verdict).toBe(verdict);
          expect(parsed.args.summary).toBe('s');
        }
      }
    } finally {
      project.cleanup();
    }
  });

  it('rejects every unsupported operation through REAL execute (no dispatch, no write)', async () => {
    const project = underReviewFx().fx;
    try {
      const before = snapshotProtected(project.root);
      for (const operation of REJECTED_REVIEW_OPERATIONS) {
        const handlers: ReviewOperationHandlers = {
          stage_status: vi.fn(),
          prepare_stage_review: vi.fn(),
          finalize_stage_review: vi.fn(),
        };
        const tool = makeTool(makeContext(project.root), handlers);
        const envelope = await tool.execute(
          { operation, stage_id: STAGE_ID },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
        expect(handlers.stage_status).not.toHaveBeenCalled();
        expect(handlers.prepare_stage_review).not.toHaveBeenCalled();
        expect(handlers.finalize_stage_review).not.toHaveBeenCalled();
      }
      const after = snapshotProtected(project.root);
      expectProtectedIdentical(before, after);
    } finally {
      project.cleanup();
    }
  });

  it('rejects ANY unknown operation value through REAL execute with a canonical Finding', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        stage_status: vi.fn(),
        prepare_stage_review: vi.fn(),
        finalize_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'frobnicate', stage_id: STAGE_ID },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.stage_status).not.toHaveBeenCalled();
      expect(handlers.prepare_stage_review).not.toHaveBeenCalled();
      expect(handlers.finalize_stage_review).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('rejects scope != stage with a canonical Finding before any dispatch', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        prepare_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      for (const scope of ['project', 'banana', '']) {
        const envelope = await tool.execute(
          { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
        expect(handlers.prepare_stage_review).not.toHaveBeenCalled();
      }
    } finally {
      project.cleanup();
    }
  });

  it('rejects a verdict outside {ACCEPTED, REPAIR} with a canonical Finding (no runtime request)', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        finalize_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      for (const verdict of ['PASS', 'REJECTED', 'BLOCKED', '', 7]) {
        const envelope = await tool.execute(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict, summary: 's' },
          makeToolContext(project.root),
        );
        expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(envelope.output).toContain('Status: failed');
        expect(handlers.finalize_stage_review).not.toHaveBeenCalled();
      }
    } finally {
      project.cleanup();
    }
  });

  it('rejects missing verdict / missing summary for finalize with a canonical Finding', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        finalize_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const noVerdict = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, summary: 's' },
        makeToolContext(project.root),
      );
      expect(noVerdict.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      const noSummary = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED' },
        makeToolContext(project.root),
      );
      expect(noSummary.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(handlers.finalize_stage_review).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('rejects missing stage_id and non-canonical stage_id fail-closed for the S3 operations', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        prepare_stage_review: vi.fn(),
        finalize_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      for (const stageId of ['', '../../../../tmp/attacker', 'S03-D', 's3']) {
        const prep = await tool.execute(
          { operation: 'prepare_stage_review', stage_id: stageId, scope: 'stage' },
          makeToolContext(project.root),
        );
        expect(prep.output).toContain('RUNTIME.SCHEMA_MISMATCH');
        expect(prep.output).toContain('Status: failed');
        const fin = await tool.execute(
          { operation: 'finalize_stage_review', stage_id: stageId, verdict: 'ACCEPTED', summary: 's' },
          makeToolContext(project.root),
        );
        expect(fin.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      }
      expect(handlers.prepare_stage_review).not.toHaveBeenCalled();
      expect(handlers.finalize_stage_review).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('rejects a mismatched project_root with HOST.PROJECT_NOT_TRUSTED for the S3 operations', async () => {
    const project = baselineFx();
    const other = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        prepare_stage_review: vi.fn(),
        finalize_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, project_root: other.root },
        makeToolContext(project.root),
      );
      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(handlers.prepare_stage_review).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
      other.cleanup();
    }
  });

  it('rejects a verdict/summary field on stage_status and a scope field on finalize (closed validation)', async () => {
    const project = baselineFx();
    try {
      const handlers: ReviewOperationHandlers = {
        stage_status: vi.fn(),
        finalize_stage_review: vi.fn(),
      };
      const tool = makeTool(makeContext(project.root), handlers);
      const statusWithVerdict = await tool.execute(
        { operation: 'stage_status', stage_id: STAGE_ID, verdict: 'ACCEPTED' },
        makeToolContext(project.root),
      );
      expect(statusWithVerdict.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      const finalizeWithScope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 's', scope: 'stage' },
        makeToolContext(project.root),
      );
      expect(finalizeWithScope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(handlers.stage_status).not.toHaveBeenCalled();
      expect(handlers.finalize_stage_review).not.toHaveBeenCalled();
    } finally {
      project.cleanup();
    }
  });

  it('every contract-layer finding is accepted by the kernel validateFinding oracle', () => {
    const project = baselineFx();
    const other = baselineFx();
    try {
      const cases: unknown[] = [
        {},
        { stage_id: STAGE_ID },
        { operation: 'finalize_stage_review', stage_id: STAGE_ID },
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'project' },
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'banana' },
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'PASS', summary: 's' },
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED' },
        { operation: 'stage_status', stage_id: STAGE_ID, scope: 'stage' },
        { operation: 'run_gate', stage_id: STAGE_ID },
        { operation: 'prepare_project_review', stage_id: STAGE_ID },
        { operation: 'stage_status', stage_id: '' },
        { operation: 'stage_status', stage_id: STAGE_ID, project_root: other.root },
      ];
      for (const raw of cases) {
        const parsed = parseReviewArgs(raw, project.root);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.result.findings.length).toBeGreaterThan(0);
          for (const finding of parsed.result.findings) {
            expect(() => validateFinding(finding)).not.toThrow();
          }
        }
      }
    } finally {
      project.cleanup();
      other.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-05 — cancellation boundary
// ============================================================

describe('review S3 cancellation boundary (PO-S03-D-05)', () => {
  it('propagates a pre-aborted caller as AbortError for the new operations', async () => {
    const project = baselineFx();
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = makeTool(makeContext(project.root));
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
          makeToolContext(project.root, controller.signal),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toBe('AbortError');
    } finally {
      project.cleanup();
    }
  });

  it('propagates abort-after-completion as AbortError (post-execution cooperative check)', async () => {
    const project = baselineFx();
    try {
      const controller = new AbortController();
      const handlers: ReviewOperationHandlers = {
        prepare_stage_review: (_input) => {
          controller.abort();
          return successResult({ data: { op: 'prepare_stage_review' } });
        },
      };
      const tool = makeTool(makeContext(project.root), handlers);
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'prepare_stage_review', stage_id: STAGE_ID },
          makeToolContext(project.root, controller.signal),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toBe('AbortError');
    } finally {
      project.cleanup();
    }
  });

  it('aborted calls never write a receipt', async () => {
    const project = underReviewFx().fx;
    try {
      const controller = new AbortController();
      controller.abort();
      const tool = makeTool(makeContext(project.root));
      let thrown: unknown;
      try {
        await tool.execute(
          { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 's' },
          makeToolContext(project.root, controller.signal),
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect((thrown as Error).name).toBe('AbortError');
      expect(reviewReceipts(project.root)).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-01/05 — prepare read-only projection + no-write
// ============================================================

describe('prepare_stage_review: ref-only projection + no-write (PO-S03-D-01/05)', () => {
  it('prepare assembles a review_scope: stage ReviewInput from persisted facts and NEVER writes', async () => {
    const { fx } = underReviewFx();
    try {
      const before = snapshotProtected(fx.root);
      const tool = makeTool(makeContext(fx.root));
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
        makeToolContext(fx.root),
      );
      const after = snapshotProtected(fx.root);
      expectProtectedIdentical(before, after);

      expect(envelope.output).toContain('ProofLoop Review');
      expect(envelope.output).toContain('Operation: prepare_stage_review');
      expect(envelope.output).toContain('Status: ok');
      expect(envelope.output).toContain('Review input:');

      const data = parseData(envelope.output);
      expect(data['review_scope']).toBe('stage');
      expect(data['stage_id']).toBe(STAGE_ID);
      expect(data['stage_goal']).toBe('S3 stage review via the real review tool seam');
      expect(Array.isArray(data['stage_outcomes'])).toBe(true);
      expect((data['stage_outcomes'] as unknown[]).length).toBeGreaterThan(0);
      expect(data['manifest_digest']).toBe(manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID }));
      expect(typeof data['branch']).toBe('string');
      expect((data['branch'] as string).length).toBeGreaterThan(0); // e.g. 'master'
      expect(typeof data['snapshot']).toBe('string');
      expect((data['snapshot'] as string).length).toBe(40);
      // Reconcile refs: the stage-gate receipt and the per-slice CV receipt.
      const gateRef = data['stage_gate_receipt_ref'] as { ref: string; digest: string } | null;
      expect(gateRef).not.toBeNull();
      expect(gateRef?.ref).toContain('.proofloop/receipts/stage-gate/');
      const cvRefs = data['cv_receipt_refs'] as Array<{ ref: string; digest: string }>;
      expect(cvRefs).toHaveLength(1);
      expect(cvRefs[0].ref).toContain('.proofloop/receipts/cv/');
      expect(cvRefs[0].ref).toContain(`${SLICE_ID}`);
    } finally {
      fx.cleanup();
    }
  });

  it('prepare data carries NO verdict and NO Receipt payload (ref-only entries only)', async () => {
    const { fx } = underReviewFx();
    try {
      const tool = makeTool(makeContext(fx.root));
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      const data = parseData(envelope.output);
      expect('verdict' in data).toBe(false);
      // Ref-only rule: the gate/CV refs are exactly { ref, digest } — never a
      // payload/body/timestamp/signature.
      const gateRef = data['stage_gate_receipt_ref'] as { ref: string; digest: string } | null;
      const cvRefs = data['cv_receipt_refs'] as Array<{ ref: string; digest: string }>;
      const refEntries = [gateRef, ...cvRefs].filter(
        (r): r is { ref: string; digest: string } => r !== null,
      );
      expect(refEntries.length).toBeGreaterThan(0);
      for (const ref of refEntries) {
        expect(Object.keys(ref).sort()).toEqual(['digest', 'ref']);
      }
      // ToolResult-level refs stay empty (read-only prepare; the ReviewInput
      // carries the ref-only entries).
      expect(envelope.output).not.toMatch(/Receipt: /);
    } finally {
      fx.cleanup();
    }
  });

  it('every projected path/ref in the prepare data is root-bound relative (no absolute, no ..)', async () => {
    const { fx } = underReviewFx();
    try {
      const tool = makeTool(makeContext(fx.root));
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      const data = parseData(envelope.output);
      const pathValues: string[] = [
        String(data['tasks_path']),
        String(data['manifest_path']),
        String((data['stage_gate_receipt_ref'] as { ref: string } | null)?.ref ?? ''),
        ...(data['cv_receipt_refs'] as Array<{ ref: string }>).map((r) => r.ref),
      ];
      for (const p of pathValues) {
        expect(p.length).toBeGreaterThan(0);
        expect(path.isAbsolute(p)).toBe(false);
        expect(p.split('/')).not.toContain('..');
      }
    } finally {
      fx.cleanup();
    }
  });

  it('the projection guard fails closed with HOST.PATH_OUTSIDE_PROJECT for an outside-root ref', () => {
    const project = baselineFx();
    try {
      const outside = path.join(path.dirname(project.root), 'outside-evil', 'x.json');
      expect(makeReviewRefEntry(project.root, outside, 'd'.repeat(64))).toBeNull();
      const guard = guardReviewPathRef(project.root, outside, 'evil ref');
      expect(guard).not.toBeNull();
      expect(guard?.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
      // An in-root path normalizes to a root-relative ref.
      const inRoot = path.join(project.root, '.proofloop', 'receipts', 'cv', STAGE_ID, SLICE_ID, 'a'.repeat(64) + '.json');
      const entry = makeReviewRefEntry(project.root, inRoot, 'a'.repeat(64));
      expect(entry).not.toBeNull();
      expect(entry?.ref).toBe(`.proofloop/receipts/cv/${STAGE_ID}/${SLICE_ID}/${'a'.repeat(64)}.json`);
    } finally {
      project.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-01/03/04/05 — finalize through the runtime admit seam
// ============================================================

describe('finalize_stage_review: runtime admitStageReview wiring (PO-S03-D-01/03/04/05)', () => {
  it('ACCEPTED on UNDER_REVIEW writes exactly one STAGE_REVIEW_PASS receipt through the runtime pipeline', async () => {
    const { fx } = underReviewFx();
    try {
      const tool = makeTool(makeContext(fx.root));
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('ProofLoop Review');
      expect(envelope.output).toContain('Operation: finalize_stage_review');
      expect(envelope.output).toContain('Status: ok');
      expect(envelope.output).toContain('Admit result:');

      const data = parseData(envelope.output);
      expect(data['accepted']).toBe(true);
      const receiptRef = data['receipt_ref'] as { ref: string; digest: string } | null;
      expect(receiptRef).not.toBeNull();
      expect(receiptRef?.ref).toBe(
        `.proofloop/receipts/review/${STAGE_ID}/${receiptRef?.digest}.json`,
      );

      const receipts = reviewReceipts(fx.root);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].type).toBe('STAGE_REVIEW_PASS');
      expect(receipts[0].digest).toBe(receiptRef?.digest);
      // Fresh reconcile readback: stage COMPLETED.
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
        'COMPLETED',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('REPAIR on UNDER_REVIEW is a legal no-Receipt branch: accepted, null ref, warn finding, no write', async () => {
    const { fx } = underReviewFx();
    try {
      const tool = makeTool(makeContext(fx.root));
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');

      const data = parseData(envelope.output);
      expect(data['accepted']).toBe(true);
      expect(data['receipt_ref']).toBeNull();
      // In-memory new_state reflects the reopen target (EXECUTING).
      expect((data['new_state'] as { stage_state?: string } | null)?.stage_state).toBe(
        'EXECUTING',
      );
      const findings = data['findings'] as Array<{ code: string; severity: string; message: string }>;
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.some((f) => f.code === 'DOMAIN.INVALID_TRANSITION' && f.severity === 'warn')).toBe(
        true,
      );

      // No receipt is written; the review category is NOT created.
      expect(reviewReceipts(fx.root)).toHaveLength(0);
      expect(existsSync(path.join(fx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      // Fresh reconcile stays on persisted facts (UNDER_REVIEW — no
      // STAGE_REVIEW_PASS receipt exists).
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
        'UNDER_REVIEW',
      );
    } finally {
      fx.cleanup();
    }
  });

  it('finalize on a non-UNDER_REVIEW stage fails closed with no Receipt', async () => {
    const fx = baselineFx();
    try {
      const tool = makeTool(makeContext(fx.root));
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'x' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).toContain('DOMAIN.INVALID_TRANSITION');
      expect(reviewReceipts(fx.root)).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});
