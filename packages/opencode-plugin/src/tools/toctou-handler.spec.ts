/**
 * @proofloop/opencode-plugin — TOCTOU post-check handler spec (S2-F-001 round 2
 * + round 3 manifest-path identity points + round 4 test independence).
 *
 * The manifest-content guard validates the manifest BEFORE the runtime call.
 * The runtime then re-reads the manifest and the evidence files; an attacker
 * could swap the manifest (or redirect an evidence path) between the pre-check
 * and the runtime read. `reverifyManifestContentAfterRead` is the post-read
 * closure: after the runtime call the plugin re-reads the manifest and compares
 * the canonical content digest and per-slice evidence path resolutions against
 * the pre-read baseline. ANY change discards the runtime result and fails
 * closed with HOST.PROJECT_NOT_TRUSTED.
 *
 * Round 3 (`reverifyManifestPathIdentity`): a manifest PATH swapped to an
 * external symlink between `reverifyStagePaths` and the baseline would make
 * baseline / runtime / post-check all read the SAME external manifest
 * (identical digest) and pass the content checks. The handler re-verifies the
 * manifest path identity BEFORE the baseline and AFTER the post-check.
 *
 * Round 4 (test independence): the pre-baseline tests assert a runtime
 * invocation counter of ZERO. If the pre-baseline identity check were removed,
 * the swap would fall to the final identity check AFTER the runtime read and
 * the counter assertion would FAIL — proving the tests independently detect
 * the pre-baseline window (verified by mutation: removing the pre-baseline
 * check turns the pre-baseline tests RED).
 *
 * This spec proves the END-TO-END handler behaviour with test-only mocks:
 *   - `@proofloop/runtime` is mocked so `reconcileStage` /
 *     `NextActionService.nextAction` increment `runtimeCallCount` and perform
 *     a manifest CONTENT swap before delegating to the real runtime
 *     (round 2 attack timeline);
 *   - `../path-boundary.js` is mocked so `reverifyCanonicalPath` performs a
 *     manifest PATH swap (file → external symlink) on a chosen identity-check
 *     call (round 3: call 2 = pre-baseline, call 3 = final identity).
 * The handler must return the fail-closed Finding WITHOUT the runtime-derived
 * data.
 */

import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Swap target set by each test; applied by the mocked runtime before it reads. */
let swapTarget: { manifestPath: string; manifestJson: string } | undefined;

/**
 * Runtime invocation counter (S2-F-001 round 4). Incremented by the mocked
 * `reconcileStage` / `NextActionService.nextAction` — a pre-baseline path swap
 * MUST fail the handler BEFORE the runtime is reached, so the pre-baseline
 * tests assert `runtimeCallCount === 0` (proving the swap happened before the
 * baseline and the external manifest was never read for derivation).
 */
let runtimeCallCount = 0;

vi.doMock('@proofloop/runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('@proofloop/runtime')>();
  const origReconcile = real.reconcileStage;
  const origNext = real.NextActionService.prototype.nextAction;
  const applySwap = (): void => {
    if (swapTarget !== undefined) {
      fs.writeFileSync(swapTarget.manifestPath, swapTarget.manifestJson, 'utf-8');
    }
  };
  return {
    ...real,
    reconcileStage: ((input: Parameters<typeof origReconcile>[0]) => {
      runtimeCallCount += 1;
      applySwap();
      return origReconcile(input);
    }) as typeof real.reconcileStage,
    NextActionService: class extends real.NextActionService {
      override nextAction(
        input: Parameters<typeof origNext>[0],
      ): ReturnType<typeof origNext> {
        runtimeCallCount += 1;
        applySwap();
        return super.nextAction(input);
      }
    },
  };
});

/**
 * Round-3 manifest-PATH swap triggers. `reverifyCanonicalPath` (from the
 * mocked `../path-boundary.js`) swaps the manifest FILE to an external symlink
 * on the Nth identity-check call for `manifestPathToWatch`:
 *   1 = inside reverifyStagePaths, 2 = pre-baseline identity, 3 = final identity.
 * Default (Infinity) makes the wrapper transparent.
 */
let manifestPathToWatch: string | undefined;
let swapOnManifestCall: number;
let manifestIdentityCalls: number;
let externalManifestPath: string | undefined;

vi.doMock('../path-boundary.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../path-boundary.js')>();
  return {
    ...real,
    reverifyCanonicalPath: ((root: string, p: string) => {
      if (
        manifestPathToWatch !== undefined &&
        externalManifestPath !== undefined &&
        p === manifestPathToWatch
      ) {
        manifestIdentityCalls += 1;
        if (manifestIdentityCalls === swapOnManifestCall) {
          fs.rmSync(p, { force: true });
          fs.symlinkSync(externalManifestPath, p);
        }
      }
      return real.reverifyCanonicalPath(root, p);
    }) as typeof real.reverifyCanonicalPath,
  };
});

beforeEach(() => {
  swapTarget = undefined;
  manifestPathToWatch = undefined;
  swapOnManifestCall = Infinity;
  manifestIdentityCalls = 0;
  externalManifestPath = undefined;
  runtimeCallCount = 0;
});

const STAGE = 'S2';
const SLICE = 'S02-A';
const TASKS = ['S02-A-T01', 'S02-A-T02'];

/** Full valid fixture (git + tasks + evidence + manifest) — pre-check passes. */
function makeFx(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-toctou-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'stage@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Stage Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const manifest = {
    stage_id: STAGE,
    source_path: `delivery/stages/${STAGE}/tasks.md`,
    source_digest: 'd69204b7a2882ff8ac094e6deb4bb3b04c508462776d7e89d0e8d513f3388128',
    stage_goal: 'Stage S2 — read-only tools',
    outcomes: ['bounded status', 'single canonical next action'],
    slices: [
      {
        slice_id: SLICE,
        goal: 'goal',
        observable_outcome: 'out',
        public_seam: 'seam',
        dependencies: [],
        proof_obligations: [],
        tasks: [...TASKS],
        risk_facts: [],
        evidence_path: `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: [],
  };
  const write = (rel: string, content: string): void => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf-8');
  };
  write(
    `.proofloop/manifests/${STAGE}.json`,
    JSON.stringify(manifest, null, 2),
  );
  const tasksMd: string[] = [`# Stage ${STAGE} — read-only tools`];
  tasksMd.push(`<!-- SLICE:${SLICE}:BEGIN -->`, `## Slice ${SLICE}`);
  for (const t of TASKS) tasksMd.push(`- [ ] ${t}: task`);
  tasksMd.push(`<!-- SLICE:${SLICE}:END -->`);
  write(`delivery/stages/${STAGE}/tasks.md`, tasksMd.join('\n'));
  write(
    `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
    `# Slice ${SLICE} Evidence\n\n## Task Evidence\n`,
  );
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fixture']);
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A DIFFERENT valid manifest (passes the guard, but the digest differs). */
function differentValidManifestJson(): string {
  const manifest = {
    stage_id: STAGE,
    source_path: `delivery/stages/${STAGE}/tasks.md`,
    source_digest: 'a'.repeat(64),
    stage_goal: 'attacker-changed-goal',
    outcomes: ['out'],
    slices: [
      {
        slice_id: SLICE,
        goal: 'goal',
        observable_outcome: 'out',
        public_seam: 'seam',
        dependencies: [],
        proof_obligations: [],
        tasks: [...TASKS],
        risk_facts: [],
        evidence_path: `delivery/stages/${STAGE}/evidence/${SLICE}.md`,
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: [],
  };
  return JSON.stringify(manifest, null, 2);
}

/** A MALICIOUS schema-valid manifest (evidence_path escapes the root). */
function maliciousManifestJson(): string {
  const manifest = {
    stage_id: STAGE,
    source_path: `delivery/stages/${STAGE}/tasks.md`,
    source_digest: 'b'.repeat(64),
    stage_goal: 'malicious',
    outcomes: ['out'],
    slices: [
      {
        slice_id: SLICE,
        goal: 'goal',
        observable_outcome: 'out',
        public_seam: 'seam',
        dependencies: [],
        proof_obligations: [],
        tasks: [...TASKS],
        risk_facts: [],
        evidence_path: `../outside-${SLICE}/secret.md`,
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: [],
  };
  return JSON.stringify(manifest, null, 2);
}

let stageModule: typeof import('./stage.js') | undefined;

beforeAll(async () => {
  vi.resetModules();
  stageModule = await import('./stage.js');
});

function handler() {
  if (stageModule === undefined) throw new Error('stage module not loaded');
  return stageModule;
}

describe('S2-F-001 TOCTOU post-check through the real handlers', () => {
  it('status: manifest swapped to a DIFFERENT valid manifest mid-call → runtime result DISCARDED (digest mismatch)', () => {
    const fx = makeFx();
    try {
      swapTarget = {
        manifestPath: path.join(fx.root, '.proofloop', 'manifests', `${STAGE}.json`),
        manifestJson: differentValidManifestJson(),
      };
      const result = handler().stageStatusHandler({
        operation: 'status',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      // The pre-check passed and the runtime produced a result, but the
      // post-check detected the swap: fail-closed, no runtime-derived data.
      expect(runtimeCallCount).toBe(1); // the runtime WAS invoked once
      expect(result.result.ok).toBe(false);
      expect(
        result.result.findings.some((f) => f.code === 'HOST.PROJECT_NOT_TRUSTED'),
      ).toBe(true);
      expect(result.result.data).toBeUndefined();
      expect(result.statusText).toBeUndefined();
    } finally {
      swapTarget = undefined;
      fx.cleanup();
    }
  });

  it('status: manifest swapped to MALICIOUS content mid-call → post-check fails closed', () => {
    const fx = makeFx();
    try {
      swapTarget = {
        manifestPath: path.join(fx.root, '.proofloop', 'manifests', `${STAGE}.json`),
        manifestJson: maliciousManifestJson(),
      };
      const result = handler().stageStatusHandler({
        operation: 'status',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      expect(runtimeCallCount).toBe(1); // swap applied INSIDE the runtime call
      expect(result.result.ok).toBe(false);
      expect(
        result.result.findings.some((f) => f.code === 'HOST.PROJECT_NOT_TRUSTED'),
      ).toBe(true);
      expect(result.result.data).toBeUndefined();
      expect(result.statusText).toBeUndefined();
    } finally {
      swapTarget = undefined;
      fx.cleanup();
    }
  });

  it('next: manifest swapped mid-call → derived action DISCARDED (post-check)', () => {
    const fx = makeFx();
    try {
      swapTarget = {
        manifestPath: path.join(fx.root, '.proofloop', 'manifests', `${STAGE}.json`),
        manifestJson: maliciousManifestJson(),
      };
      const result = handler().stageNextHandler({
        operation: 'next',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      expect(runtimeCallCount).toBe(1); // swap applied INSIDE nextAction
      expect(result.result.ok).toBe(false);
      expect(
        result.result.findings.some((f) => f.code === 'HOST.PROJECT_NOT_TRUSTED'),
      ).toBe(true);
      expect(result.result.data).toBeUndefined();
      expect(result.nextText).toBeUndefined();
    } finally {
      swapTarget = undefined;
      fx.cleanup();
    }
  });

  it('no swap → post-check passes and the runtime result is delivered unchanged', () => {
    const fx = makeFx();
    try {
      swapTarget = undefined;
      const result = handler().stageStatusHandler({
        operation: 'status',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      expect(runtimeCallCount).toBe(1); // normal runtime invocation
      expect(result.result.ok).toBe(true);
      expect(result.result.data).toBeDefined();
      expect(result.statusText).toBeDefined();
    } finally {
      fx.cleanup();
    }
  });

  it('status: manifest PATH swapped to an external symlink after reverifyStagePaths, BEFORE the baseline → fail-closed, no leak (round 3 pre-baseline identity)', () => {
    const fx = makeFx();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-ident-out-'));
    try {
      const externalManifest = path.join(outside, 'external.json');
      fs.writeFileSync(externalManifest, differentValidManifestJson(), 'utf-8');
      manifestPathToWatch = path.join(fx.root, '.proofloop', 'manifests', `${STAGE}.json`);
      externalManifestPath = externalManifest;
      // Call 1 (inside reverifyStagePaths) passes on the real file; call 2
      // (pre-baseline identity) swaps the file to the external symlink → the
      // handler fails closed BEFORE the baseline/runtime ever read it.
      swapOnManifestCall = 2;

      const result = handler().stageStatusHandler({
        operation: 'status',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      // Round-4 independence: the swap happened BEFORE the baseline read, so
      // the runtime must NEVER have been invoked (otherwise the swap would
      // have fallen to the final identity check AFTER the runtime read and
      // this assertion would fail).
      expect(runtimeCallCount).toBe(0);
      expect(result.result.ok).toBe(false);
      expect(
        result.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
      ).toBe(true);
      expect(result.result.data).toBeUndefined();
      expect(result.statusText).toBeUndefined();
      // The external manifest was never read for derivation — no runtime
      // output leaked.
      expect(result.result.findings.some((f) => f.message.includes('external'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  it('status: manifest PATH swapped to an external symlink AFTER the post-check → final identity fails closed, runtime result discarded (round 3 final identity)', () => {
    const fx = makeFx();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-ident-out-'));
    try {
      const externalManifest = path.join(outside, 'external.json');
      fs.writeFileSync(externalManifest, differentValidManifestJson(), 'utf-8');
      manifestPathToWatch = path.join(fx.root, '.proofloop', 'manifests', `${STAGE}.json`);
      externalManifestPath = externalManifest;
      // Calls 1 (reverifyStagePaths) and 2 (pre-baseline identity) pass, the
      // baseline + runtime + post-check all read the real in-root manifest;
      // call 3 (final identity) swaps the file → the derived result is
      // discarded.
      swapOnManifestCall = 3;

      const result = handler().stageStatusHandler({
        operation: 'status',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      // The runtime WAS invoked once (the swap happens only at the final
      // identity check AFTER the post-check); its result is then discarded.
      expect(runtimeCallCount).toBe(1);
      expect(result.result.ok).toBe(false);
      expect(
        result.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
      ).toBe(true);
      expect(result.result.data).toBeUndefined();
      expect(result.statusText).toBeUndefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fx.cleanup();
    }
  });

  it('next: manifest PATH swapped to an external symlink BEFORE the baseline → fail-closed, no derived action (round 3 pre-baseline identity)', () => {
    const fx = makeFx();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 's2f001-ident-out-'));
    try {
      const externalManifest = path.join(outside, 'external.json');
      fs.writeFileSync(externalManifest, differentValidManifestJson(), 'utf-8');
      manifestPathToWatch = path.join(fx.root, '.proofloop', 'manifests', `${STAGE}.json`);
      externalManifestPath = externalManifest;
      swapOnManifestCall = 2;

      const result = handler().stageNextHandler({
        operation: 'next',
        stageId: STAGE,
        projectRoot: fx.root,
      });

      // Round-4 independence: the swap happened BEFORE the baseline, so the
      // runtime must NEVER have been invoked.
      expect(runtimeCallCount).toBe(0);
      expect(result.result.ok).toBe(false);
      expect(
        result.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT'),
      ).toBe(true);
      expect(result.result.data).toBeUndefined();
      expect(result.nextText).toBeUndefined();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fx.cleanup();
    }
  });
});
