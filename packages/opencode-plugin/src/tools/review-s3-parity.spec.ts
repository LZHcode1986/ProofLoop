/**
 * @proofloop/opencode-plugin — proofloop_review S3 sourcing + CLI parity spec
 * (S03-D-T02).
 *
 * PO: PO-S03-D-02 (prepare assembles the `review_scope: stage` ReviewInput
 * from canonical persisted facts — every field verifiable against an
 * independent fixture oracle, ref-only, no verdict, no Receipt body),
 * PO-S03-D-03 (finalize ACCEPTED → canonical StageReviewAdmissionRequest →
 * admitStageReview → STAGE_REVIEW_PASS receipt; CLI-admit parity with
 * identical receipt digest/bytes under frozen time), PO-S03-D-04 (finalize
 * REPAIR = legal accepted no-Receipt branch; CLI parity; persisted facts
 * unchanged).
 *
 * The runtime CLI `admitRequest` (packages/runtime/dist/cli/admit.js) is
 * consumed ONLY inside this TEST process as the parity oracle — the production
 * plugin never shells the CLI and never bypasses the runtime admit methods.
 *
 * Parity semantics (S03-B pattern): time is frozen (vi.useFakeTimers) so the
 * plugin finalize and the CLI oracle produce IDENTICAL receipt timestamps →
 * identical digests and identical receipt file bytes. Fixture chains are
 * deterministic (fixed actionToken + fixed snapshot/commit bindings) so the
 * two identical fixtures yield byte-identical receipt sets.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
  readReceiptCategory,
  reconcileStage,
} from '@proofloop/runtime';
import type { AdmissionDeps, SpvGateAdmissionDeps } from '@proofloop/runtime';
import { admitRequest } from '@proofloop/runtime/dist/cli/admit.js';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createReviewTool } from './review.js';
import type { ReviewToolArgsShape } from './review.js';
import { projectAdmitNewState } from './stage-admit-common.js';
import { deriveCleanRoom, deriveStageRiskLevel } from './review-common.js';

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-D';
const TASKS: readonly string[] = ['S03-D-T01', 'S03-D-T02', 'S03-D-T03'];
const FROZEN_NOW = new Date('2026-08-03T00:00:00.000Z');
const FIXED_ACTION_TOKEN = 'tok-parity-t02';
const PRD_CONTENT = '# PRD — ProofLoop\n\nGoal-first proof for S3.\n';
const TECH_SPEC_CONTENT = '# Contract State Matrix\n\nStage review operations §1.3.\n';

/** Deterministic git commit environment (fixed dates → identical SHAs across fixtures). */
function gitCommitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_AUTHOR_DATE: '2026-08-03T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-08-03T00:00:00Z',
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

// ============================================================
// Deterministic UNDER_REVIEW fixture builder
// ============================================================

interface ReviewFx {
  readonly root: string;
  write(rel: string, content: string): void;
  writeManifest(riskFacts?: readonly string[]): void;
  writeAuthorityDocs(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  commitAll(message?: string): string;
  cleanup(): void;
}

function makeFx(): ReviewFx {
  const root = mkdtempSync(path.join(tmpdir(), 's03d-t02-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 's03d@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'S03D T02']);
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

  const fx: ReviewFx = {
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
        stage_goal: 'S3 stage review via the real review tool seam',
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
      fx.write('PRD.md', PRD_CONTENT);
      fx.write('tech-spec/contract-state-matrix.md', TECH_SPEC_CONTENT);
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
            `|---|---|---|---|---|\n| PO-S03-D-02 | review-s3-parity.spec.ts | yes | yes | pass |\n\n` +
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
    summary: 't02 worker',
  };
}

/**
 * Build an UNDER_REVIEW stage from a fresh fixture (deterministic chain):
 * STAGE_PLAN + SPV_PASS + worker finalize-slice → CV PASS → SLICE_COMMIT →
 * INTEGRATION_PASS. When `withGate` the prerequisite receipts are committed
 * (git-clean) and a GATE_PASS receipt bound to the new HEAD is added. The
 * stage derives UNDER_REVIEW from persisted facts.
 */
function buildUnderReview(fx: ReviewFx, withGate: boolean): { head: string; manifestDigest: string } {
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

  if (withGate) {
    // Commit the prerequisite receipts so the tree is git-clean for the gate
    // precondition; the gate binds to the new HEAD.
    fx.commitAll('prerequisite receipts');
    const head2 = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    const gate = admitGateResult(
      { type: 'gate_result', stageId: STAGE_ID, verdict: 'PASS', manifestDigest, snapshotDigest: head2, summary: 'gate pass' },
      spvDeps,
    );
    expect(gate.accepted).toBe(true);
  }

  expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
    'UNDER_REVIEW',
  );
  return { head, manifestDigest };
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

function makeToolContext(root: string, abort: AbortSignal = new AbortController().signal): ToolContext {
  return {
    sessionID: 'sess-s03d-t02',
    messageID: 'msg-s03d-t02',
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

function makeTool(root: string): ReviewExecuteTool {
  return createReviewTool(makeContext(root)) as unknown as ReviewExecuteTool;
}

/** Extract the canonical ToolResult `data` projection from the host output. */
function parseData(output: string): Record<string, unknown> {
  const line = output.split('\n').find((l) => l.startsWith('Data: '));
  expect(line, `expected a Data: line in:\n${output}`).toBeDefined();
  return JSON.parse(line!.slice('Data: '.length)) as Record<string, unknown>;
}

function gitHead(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
}

function gitBranch(root: string): string {
  return execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
  }).trim();
}

function sha256Bytes(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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
        map.set(rel, createHash('sha256').update(content).digest('hex'));
      }
    }
  };
  walk(path.join(root, '.proofloop', 'receipts'), '.proofloop/receipts');
  return map;
}

// ============================================================
// PO-S03-D-02 — ReviewInput independent persisted-facts sourcing
// ============================================================

describe('ReviewInput sourcing from canonical persisted facts (PO-S03-D-02)', () => {
  it('every required field is sourced from persisted facts and matches an independent oracle', async () => {
    const fx = makeFx();
    fx.writeManifest(['core_state_machine', 'irreversible_operation']);
    fx.writeAuthorityDocs();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll('baseline');
    buildUnderReview(fx, true); // with gate for stage_gate_receipt_ref
    try {
      const tool = makeTool(fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID, scope: 'stage' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');
      const data = parseData(envelope.output);

      // review_scope fixed.
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
      expect(data['branch']).toBe(gitBranch(fx.root));
      expect(data['snapshot']).toBe(gitHead(fx.root));

      // Authority refs vs independent file reads (root-bound + content digests).
      const authorityRefs = data['authority_refs'] as Array<{ ref: string; digest: string }>;
      const prdRef = authorityRefs.find((r) => r.ref === 'PRD.md');
      expect(prdRef).toEqual({ ref: 'PRD.md', digest: sha256Bytes(path.join(fx.root, 'PRD.md')) });
      const techRef = authorityRefs.find((r) => r.ref === 'tech-spec/contract-state-matrix.md');
      expect(techRef).toEqual({
        ref: 'tech-spec/contract-state-matrix.md',
        digest: sha256Bytes(path.join(fx.root, 'tech-spec', 'contract-state-matrix.md')),
      });

      // Stage Gate receipt ref vs the independent gate category read.
      const gate = readReceiptCategory({
        projectRoot: fx.root,
        category: 'stage-gate',
        stageId: STAGE_ID,
      });
      expect(gate.chainValid).toBe(true);
      const gateRef = data['stage_gate_receipt_ref'] as { ref: string; digest: string } | null;
      expect(gateRef).not.toBeNull();
      expect(gateRef?.digest).toBe(gate.latest?.receipt.digest);
      expect(gateRef?.ref).toBe(
        `.proofloop/receipts/stage-gate/${STAGE_ID}/${gate.latest?.receipt.digest}.json`,
      );

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

      // Risk level + clean-room facts (deterministic projections).
      expect(data['risk_level']).toBe(deriveStageRiskLevel(['core_state_machine', 'irreversible_operation']));
      expect(data['risk_level']).toBe('critical');
      expect(data['clean_room']).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('the prepare output contains NO verdict and NO Receipt body — refs are exactly { ref, digest }', async () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeAuthorityDocs();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll('baseline');
    buildUnderReview(fx, true);
    try {
      const tool = makeTool(fx.root);
      const envelope = await tool.execute(
        { operation: 'prepare_stage_review', stage_id: STAGE_ID },
        makeToolContext(fx.root),
      );
      const data = parseData(envelope.output);
      const serialized = JSON.stringify(data);
      expect('verdict' in data).toBe(false);
      // No Receipt payload/body leaks anywhere (no payload/timestamp/
      // signature/version fields, no receipt JSON body).
      expect(serialized).not.toContain('"payload"');
      expect(serialized).not.toContain('"timestamp"');
      expect(serialized).not.toContain('"signature"');
      expect(serialized).not.toContain('previous_digest');
      // Every ref entry is exactly { ref, digest }.
      const refGroups: unknown[] = [
        ...(data['authority_refs'] as unknown[]),
        ...(data['cv_receipt_refs'] as unknown[]),
      ];
      const gateRef = data['stage_gate_receipt_ref'] as { ref: string; digest: string } | null;
      if (gateRef !== null) refGroups.push(gateRef);
      expect(refGroups.length).toBeGreaterThan(0);
      for (const ref of refGroups) {
        expect(Object.keys(ref as Record<string, unknown>).sort()).toEqual(['digest', 'ref']);
      }
    } finally {
      fx.cleanup();
    }
  });

  it('deriveStageRiskLevel maps manifest risk facts deterministically (pure oracle)', () => {
    expect(deriveStageRiskLevel(['irreversible_operation', 'core_state_machine'])).toBe('critical');
    expect(deriveStageRiskLevel(['irreversible_operation', 'external_side_effect'])).toBe('critical');
    expect(deriveStageRiskLevel(['core_state_machine'])).toBe('high');
    expect(deriveStageRiskLevel(['external_side_effect'])).toBe('high');
    expect(deriveStageRiskLevel(['persistent_state', 'authorization'])).toBe('medium');
    expect(deriveStageRiskLevel(['public_api_change'])).toBe('low');
    expect(deriveStageRiskLevel([])).toBe('low');
  });

  it('deriveCleanRoom is false when evidence is not finalized (pure oracle)', () => {
    expect(
      deriveCleanRoom({
        receipt_chain_valid: true,
        slices: [{ slice_id: SLICE_ID, evidence_finalized: false }],
      }),
    ).toBe(false);
    expect(
      deriveCleanRoom({
        receipt_chain_valid: true,
        slices: [{ slice_id: SLICE_ID, evidence_finalized: true }],
      }),
    ).toBe(true);
    expect(
      deriveCleanRoom({ receipt_chain_valid: false, slices: [] }),
    ).toBe(false);
  });
});

// ============================================================
// PO-S03-D-03 — finalize ACCEPTED CLI parity (frozen time)
// ============================================================

describe('finalize ACCEPTED: CLI stage_review parity (PO-S03-D-03)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plugin finalize ACCEPTED projection + receipt bytes equal the CLI stage_review oracle', async () => {
    const cliFx = makeFx();
    cliFx.writeManifest();
    cliFx.writeTasksMd([...TASKS]);
    cliFx.writeEvidence(true);
    cliFx.commitAll('baseline');
    buildUnderReview(cliFx, false);

    const pluginFx = makeFx();
    pluginFx.writeManifest();
    pluginFx.writeTasksMd([...TASKS]);
    pluginFx.writeEvidence(true);
    pluginFx.commitAll('baseline');
    buildUnderReview(pluginFx, false);
    try {
      // CLI oracle on fixture A.
      const cli = admitRequest(
        { type: 'stage_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        cliFx.root,
      );
      // Plugin on fixture B.
      const tool = makeTool(pluginFx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(pluginFx.root),
      );
      const plugin = parseData(envelope.output);

      expect(cli.accepted).toBe(true);
      expect(plugin.accepted).toBe(true);
      // receipt_ref digest parity (frozen time → same runtime receipt).
      const cliDigest = cli.receipt_ref as string;
      expect((plugin.receipt_ref as { digest: string }).digest).toBe(cliDigest);
      expect((plugin.receipt_ref as { ref: string }).ref).toBe(
        `.proofloop/receipts/review/${STAGE_ID}/${cliDigest}.json`,
      );
      // new_state bounded canonical-fields parity.
      expect(plugin.new_state).toEqual(projectAdmitNewState(cli.new_state));
      // findings parity.
      expect(plugin.findings).toEqual(cli.findings);
      // Receipt file bytes IDENTICAL (same runtime, same timestamp).
      expect(snapshotReceipts(pluginFx.root)).toEqual(snapshotReceipts(cliFx.root));
    } finally {
      cliFx.cleanup();
      pluginFx.cleanup();
    }
  });

  it('ACCEPTED writes one STAGE_REVIEW_PASS to review/<stage>/ with a valid chain and fresh reconcile derives COMPLETED', async () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll('baseline');
    buildUnderReview(fx, false);
    try {
      const tool = makeTool(fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: 'accept' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('Status: ok');

      const receipts = reviewReceipts(fx.root);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].type).toBe('STAGE_REVIEW_PASS');
      expect(receipts[0].payload).toEqual({ verdict: 'ACCEPTED', summary: 'accept' });

      // The review category chain is valid after the append.
      const review = readReceiptCategory({
        projectRoot: fx.root,
        category: 'review',
        stageId: STAGE_ID,
      });
      expect(review.chainValid).toBe(true);
      expect(review.receipts).toHaveLength(1);

      // Fresh reconcile readback derives COMPLETED from persisted facts.
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
        'COMPLETED',
      );
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// PO-S03-D-04 — finalize REPAIR no-Receipt CLI parity
// ============================================================

describe('finalize REPAIR: legal no-Receipt branch CLI parity (PO-S03-D-04)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('plugin REPAIR matches the CLI oracle: accepted true, null ref, warn finding, no receipt, persisted facts unchanged', async () => {
    const cliFx = makeFx();
    cliFx.writeManifest();
    cliFx.writeTasksMd([...TASKS]);
    cliFx.writeEvidence(true);
    cliFx.commitAll('baseline');
    buildUnderReview(cliFx, false);

    const pluginFx = makeFx();
    pluginFx.writeManifest();
    pluginFx.writeTasksMd([...TASKS]);
    pluginFx.writeEvidence(true);
    pluginFx.commitAll('baseline');
    buildUnderReview(pluginFx, false);
    try {
      // CLI oracle on fixture A.
      const cli = admitRequest(
        { type: 'stage_review', stageId: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        cliFx.root,
      );
      // Plugin on fixture B.
      const tool = makeTool(pluginFx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        makeToolContext(pluginFx.root),
      );
      const plugin = parseData(envelope.output);

      expect(cli.accepted).toBe(true);
      expect(plugin.accepted).toBe(true);
      expect(cli.receipt_ref).toBeNull();
      expect(plugin.receipt_ref).toBeNull();
      // warn Finding parity (DOMAIN.INVALID_TRANSITION, recoverable).
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
      // No receipt is written; the review category is NOT created on either side.
      expect(reviewReceipts(cliFx.root)).toHaveLength(0);
      expect(reviewReceipts(pluginFx.root)).toHaveLength(0);
      expect(existsSync(path.join(cliFx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      expect(existsSync(path.join(pluginFx.root, '.proofloop', 'receipts', 'review'))).toBe(false);
      // Fresh reconcile stays on persisted facts (UNDER_REVIEW, no
      // STAGE_REVIEW_PASS receipt).
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

  it('REPAIR leaves the persisted review category byte-identical (no write)', async () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll('baseline');
    buildUnderReview(fx, false);
    try {
      const before = snapshotReceipts(fx.root);
      const tool = makeTool(fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'REPAIR', summary: 'reopen' },
        makeToolContext(fx.root),
      );
      const after = snapshotReceipts(fx.root);
      expect(envelope.output).toContain('Status: ok');
      expect(before).toEqual(after);
    } finally {
      fx.cleanup();
    }
  });
});

// ============================================================
// summary binding edge cases (PO-S03-D-03)
// ============================================================

describe('finalize summary binding (PO-S03-D-03)', () => {
  it('empty summary on an UNDER_REVIEW fixture fails closed with no receipt', async () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll('baseline');
    buildUnderReview(fx, false);
    try {
      const before = snapshotReceipts(fx.root);
      const tool = makeTool(fx.root);
      const envelope = await tool.execute(
        { operation: 'finalize_stage_review', stage_id: STAGE_ID, verdict: 'ACCEPTED', summary: '' },
        makeToolContext(fx.root),
      );
      expect(envelope.output).toContain('RUNTIME.SCHEMA_MISMATCH');
      expect(envelope.output).toContain('Status: failed');
      expect(snapshotReceipts(fx.root)).toEqual(before);
      expect(reviewReceipts(fx.root)).toHaveLength(0);
      // Fresh reconcile stays UNDER_REVIEW (no receipt was written).
      expect(reconcileStage({ projectRoot: fx.root, stageId: STAGE_ID }).stage_state).toBe(
        'UNDER_REVIEW',
      );
    } finally {
      fx.cleanup();
    }
  });
});
