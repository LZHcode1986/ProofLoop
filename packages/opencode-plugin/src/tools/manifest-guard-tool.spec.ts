/**
 * @proofloop/opencode-plugin — Malicious-manifest matrix through the REAL
 * stage/review default wiring (S2 review finding S2-F-001).
 *
 * The S2 tools must fail closed on a schema-valid malicious manifest BEFORE
 * the runtime is called: `proofloop_stage(status/next)` and
 * `proofloop_review(stage_status)` (which delegates to the stage status
 * handler) never derive a state/action from manifest content fields that would
 * read OUTSIDE the canonical worktree trust root.
 *
 * Matrix (on real temp git fixtures):
 *   - evidence_path `../` escape → HOST.PROJECT_NOT_TRUSTED, no runtime
 *     derivation, no outside read (sentinel file outside the root stays
 *     unread — its content never appears in the output), read-only;
 *   - slice_id path separators / `..` → HOST.PROJECT_NOT_TRUSTED;
 *   - evidence_path absolute outside the root → HOST.PROJECT_NOT_TRUSTED;
 *   - evidence_path symlink escape (evidence file is a symlink to an outside
 *     file) → HOST.PROJECT_NOT_TRUSTED;
 *   - valid manifest → unaffected (Status: ok, normal canonical output);
 *   - unreadable manifest → DOMAIN.STAGE_NOT_FOUND.
 *
 * Every fail-closed finding is kernel-canonical (validated by the S1
 * `validateFinding` oracle through the unified error boundary).
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PluginInput, ToolContext } from '@opencode-ai/plugin';
import { createRuntimeContext } from '../host-context.js';
import type { RuntimeContext } from '../host-context.js';
import { createStageTool } from './stage.js';
import { createReviewTool } from './review.js';

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

interface Fx {
  readonly root: string;
  readonly stageId: string;
  write(rel: string, content: string): void;
  writeManifest(opts?: { slice_id?: string; evidence_path?: string }): void;
  writeTasksMd(entries: readonly { id: string; checked: boolean }[]): void;
  writeEvidence(): void;
  commitAll(): void;
  cleanup(): void;
}

function makeFx(): Fx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-tool-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'stage@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Stage Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const fx: Fx = {
    root,
    stageId: STAGE,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (opts = {}) => {
      const manifest = {
        stage_id: STAGE,
        source_path: `delivery/stages/${STAGE}/tasks.md`,
        source_digest: 'd69204b7a2882ff8ac094e6deb4bb3b04c508462776d7e89d0e8d513f3388128',
        stage_goal: 'Stage S2 — read-only tools',
        outcomes: ['bounded status', 'single canonical next action'],
        slices: [
          {
            slice_id: opts.slice_id ?? SLICE,
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
            tasks: [...TASKS],
            risk_facts: ['core_state_machine'],
            evidence_path:
              opts.evidence_path ??
              `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
            cv_minimum_level: 'enhanced',
          },
        ],
        dependencies: [],
        risk_facts: [],
      };
      fx.write(
        `.proofloop/manifests/${STAGE}.json`,
        JSON.stringify(manifest, null, 2),
      );
    },
    writeTasksMd: (entries) => {
      const out: string[] = [`# Stage ${STAGE} — read-only tools`];
      out.push(`<!-- SLICE:${SLICE}:BEGIN -->`, `## Slice ${SLICE}`);
      for (const t of entries) {
        out.push(`- [${t.checked ? 'x' : ' '}] ${t.id}: task`);
      }
      out.push(`<!-- SLICE:${SLICE}:END -->`);
      fx.write(`delivery/stages/${STAGE}/tasks.md`, out.join('\n'));
    },
    writeEvidence: () => {
      const out: string[] = [`# Slice ${SLICE} Evidence`, '', '## Task Evidence', ''];
      for (const t of TASKS) {
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
      out.push('', '## Current CV Status', '', '- Status: NOT_RUN', '');
      fx.write(`delivery/stages/${STAGE}/evidence/${SLICE}.md`, out.join('\n'));
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

function makeToolContext(root: string, agent: string): ToolContext {
  return {
    sessionID: 'sess-s2f001',
    messageID: 'msg-s2f001',
    agent,
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

type ExecuteTool = {
  execute: (
    args: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ output: string }>;
};

/** sha256 digest map of every file in the tree (relative → digest). */
function treeDigests(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        map.set(
          path.relative(root, abs),
          createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
        );
      }
    }
  };
  walk(root);
  return map;
}

/** Read-only assertion: only `.proofloop/logs/**` may newly appear. */
function assertReadOnlyExceptLogs(
  before: Map<string, string>,
  after: Map<string, string>,
): void {
  for (const [rel, digest] of before) {
    expect(after.has(rel), `file deleted: ${rel}`).toBe(true);
    expect(after.get(rel), `file changed: ${rel}`).toBe(digest);
  }
  for (const rel of after.keys()) {
    if (before.has(rel)) continue;
    expect(rel.startsWith('.proofloop/logs/'), `new file outside logs: ${rel}`).toBe(true);
  }
}

describe('S2-F-001 malicious manifest matrix through the real stage tool', () => {
  it('stage status: evidence_path `../` escape → HOST.PROJECT_NOT_TRUSTED, no runtime derivation, no outside read', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-outside-'));
    try {
      const sentinel = path.join(outside, 'secret.md');
      fs.writeFileSync(sentinel, 'SENTINEL_SECRET_CONTENT', 'utf-8');
      const fx = makeFx();
      fx.writeManifest({
        evidence_path: `../${path.basename(outside)}/secret.md`,
      });
      fx.writeTasksMd([
        { id: 'S02-A-T01', checked: false },
        { id: 'S02-A-T02', checked: false },
      ]);
      fx.commitAll();

      const before = treeDigests(fx.root);
      const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
      const envelope = await tool.execute(
        { operation: 'status', stage_id: STAGE },
        makeToolContext(fx.root, 'executor'),
      );
      const after = treeDigests(fx.root);
      assertReadOnlyExceptLogs(before, after);

      // Fail-closed with the trust-boundary Finding, and the runtime was never
      // called (no reconcile-derived status facts).
      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).not.toContain('Slices (');
      expect(envelope.output).not.toContain('State:');
      // The sentinel outside the root was never read into the output.
      expect(envelope.output).not.toContain('SENTINEL_SECRET_CONTENT');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stage next: evidence_path `../` escape → HOST.PROJECT_NOT_TRUSTED, no runtime derivation', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-outside-'));
    try {
      const fx = makeFx();
      fx.writeManifest({
        evidence_path: `../${path.basename(outside)}/secret.md`,
      });
      fx.writeTasksMd([
        { id: 'S02-A-T01', checked: false },
        { id: 'S02-A-T02', checked: false },
      ]);
      fx.commitAll();

      const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
      const envelope = await tool.execute(
        { operation: 'next', stage_id: STAGE },
        makeToolContext(fx.root, 'executor'),
      );

      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      // No runtime-derived next action was produced.
      expect(envelope.output).not.toContain('Action:');
      expect(envelope.output).not.toContain('Role:');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('review stage_status: evidence_path `../` escape → HOST.PROJECT_NOT_TRUSTED (shared stage handler)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-outside-'));
    try {
      const fx = makeFx();
      fx.writeManifest({
        evidence_path: `../${path.basename(outside)}/secret.md`,
      });
      fx.writeTasksMd([
        { id: 'S02-A-T01', checked: false },
        { id: 'S02-A-T02', checked: false },
      ]);
      fx.commitAll();

      const tool = createReviewTool(makeContext(fx.root)) as unknown as ExecuteTool;
      const envelope = await tool.execute(
        { operation: 'stage_status', stage_id: STAGE },
        makeToolContext(fx.root, 'stage-reviewer'),
      );

      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).not.toContain('Slices (');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it.each([
    ['S02-A/../../etc', 'S02-A/../../etc'],
    ['S02-A\\..\\..\\tmp', 'S02-A\\..\\..\\tmp'],
    ['..', '..'],
  ] as const)('stage status: slice_id "%s" → HOST.PROJECT_NOT_TRUSTED', async (_label, sliceId) => {
    const fx = makeFx();
    fx.writeManifest({ slice_id: sliceId });
    fx.writeTasksMd([
      { id: 'S02-A-T01', checked: false },
      { id: 'S02-A-T02', checked: false },
    ]);
    fx.commitAll();

    const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE },
      makeToolContext(fx.root, 'executor'),
    );

    expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
    expect(envelope.output).toContain('Status: failed');
    expect(envelope.output).not.toContain('Slices (');
  });

  it('stage status: ABSOLUTE evidence_path outside the root → HOST.PROJECT_NOT_TRUSTED', async () => {
    const outside = path.join(os.tmpdir(), `s2f001-abs-${Date.now()}.md`);
    try {
      const fx = makeFx();
      fx.writeManifest({ evidence_path: outside });
      fx.writeTasksMd([
        { id: 'S02-A-T01', checked: false },
        { id: 'S02-A-T02', checked: false },
      ]);
      fx.commitAll();

      const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
      const envelope = await tool.execute(
        { operation: 'status', stage_id: STAGE },
        makeToolContext(fx.root, 'executor'),
      );

      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).not.toContain('Slices (');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('stage status: evidence_path symlink escape → HOST.PROJECT_NOT_TRUSTED', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-symlink-'));
    try {
      const sentinel = path.join(outside, 'secret.md');
      fs.writeFileSync(sentinel, 'SENTINEL_SYMLINK_CONTENT', 'utf-8');
      const fx = makeFx();
      // evidence_path is the canonical in-root path, but the file itself is a
      // symlink pointing OUTSIDE the root — the shared resolveWithinRoot walk
      // rejects the symlink escape even though the target exists.
      const evidenceDir = path.join(
        fx.root,
        'delivery',
        'stages',
        STAGE,
        'evidence',
      );
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.symlinkSync(sentinel, path.join(evidenceDir, `${SLICE}.md`));
      fx.writeManifest();
      fx.writeTasksMd([
        { id: 'S02-A-T01', checked: false },
        { id: 'S02-A-T02', checked: false },
      ]);
      fx.commitAll();

      const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
      const envelope = await tool.execute(
        { operation: 'status', stage_id: STAGE },
        makeToolContext(fx.root, 'executor'),
      );

      expect(envelope.output).toContain('HOST.PROJECT_NOT_TRUSTED');
      expect(envelope.output).toContain('Status: failed');
      expect(envelope.output).not.toContain('Slices (');
      expect(envelope.output).not.toContain('SENTINEL_SYMLINK_CONTENT');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('valid manifest → unaffected (Status: ok, canonical output)', async () => {
    const fx = makeFx();
    fx.writeManifest({});
    fx.writeTasksMd([
      { id: 'S02-A-T01', checked: false },
      { id: 'S02-A-T02', checked: false },
    ]);
    fx.writeEvidence();
    fx.commitAll();

    const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE },
      makeToolContext(fx.root, 'executor'),
    );

    expect(envelope.output).toContain('Status: ok');
    expect(envelope.output).toContain('Slices (');
    expect(envelope.output).not.toContain('HOST.PROJECT_NOT_TRUSTED');
  });

  it('unreadable manifest → DOMAIN.STAGE_NOT_FOUND', async () => {
    const fx = makeFx();
    // No manifest file at all: the guard fails closed with the canonical
    // manifest-source condition.
    fx.writeTasksMd([
      { id: 'S02-A-T01', checked: false },
      { id: 'S02-A-T02', checked: false },
    ]);
    fx.commitAll();

    const tool = createStageTool(makeContext(fx.root)) as unknown as ExecuteTool;
    const envelope = await tool.execute(
      { operation: 'status', stage_id: STAGE },
      makeToolContext(fx.root, 'executor'),
    );

    expect(envelope.output).toContain('DOMAIN.STAGE_NOT_FOUND');
    expect(envelope.output).toContain('Status: failed');
  });
});
