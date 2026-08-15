/**
 * S09-D-T01 — pre-admission pristine Evidence refresh transaction.
 *
 * The Runtime-owned refresh operation is the ONLY rebind path after a Manifest
 * digest changes: it accepts the current Manifest + expected previous Manifest
 * digest, verifies that the Stage has no plan/execution Receipts yet and that
 * every declared Evidence file is still the initializer's pristine template
 * (old binding), then updates all files through a transaction journal with
 * per-file compare-and-swap.  Non-pristine / stale / symlink / competitor /
 * unrecovered-transaction states fail closed with no writes; an interrupted
 * transaction is detectable and can be recovered (complete) or rolled back.
 * Task Ref: REF-S09-D-T01
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeDigest, type VNextManifest } from '@proofloop/kernel';
import { compileVNextManifestCli } from './compile-vnext-manifest';
import { initializeVNextSliceEvidence } from './initialize-vnext-slice-evidence';
import { renderVNextEvidenceSkeleton } from './vnext-cli-support-vnext';
import { validateVNextStage } from './validate-vnext-stage';
import {
  REFRESH_JOURNAL_FILE,
  refreshVNextSliceEvidence,
  type RefreshVNextSliceEvidenceResult,
} from '../vnext/evidence-refresh';
import type { CompileVNextManifestInput } from '../vnext';

/**
 * S09-D-T01 repair — fault injection hooks for the post-swap CAS failure
 * regression.  `node:fs` is mocked once for this file (every src consumer
 * shares the mock); the default behavior is a pure pass-through and the
 * hooks are only armed inside the one test that needs them.
 *
 * S09-REVIEW-001 hooks:
 *  - `replaceTargetBeforeTempWrite`: runs when the swap opens its temp file
 *    (before any byte of the replacement is written), so a test can race the
 *    target file between the compare and the rename;
 *  - `failUnlinkJournal`: makes `unlinkSync` throw EACCES for the transaction
 *    journal so the success path cannot silently delete recovery state.
 */
const refreshFsHooks = vi.hoisted(() => ({
  afterRenameSync: null as null | ((args: unknown[]) => void),
  replaceTargetBeforeTempWrite: null as null | (() => void),
  failUnlinkJournal: false,
}));

// The journal file name is fixed by the Runtime contract
// (`REFRESH_JOURNAL_FILE` in vnext-cli-support-vnext.ts); the mock factory is
// hoisted above module imports, so the literal is duplicated here.
const REFRESH_JOURNAL_FILENAME = '.vnext-refresh-journal.json';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: ((...args: Parameters<typeof import('node:fs').renameSync>) => {
      const result = actual.renameSync(...args);
      if (refreshFsHooks.afterRenameSync !== null) {
        refreshFsHooks.afterRenameSync(args);
      }
      return result;
    }) as typeof import('node:fs').renameSync,
    openSync: ((...args: Parameters<typeof import('node:fs').openSync>) => {
      if (refreshFsHooks.replaceTargetBeforeTempWrite !== null) {
        const filePath = typeof args[0] === 'string' ? args[0] : '';
        const base = filePath.split('/').pop() ?? '';
        // Only swap temp files (`.<name>.<pid>.<ts>.<uuid>.tmp`); the journal
        // write uses the same .tmp convention, so its temp must be excluded —
        // the injection must land AFTER the per-file compare, i.e. on the
        // swap's own temp open.
        if (
          base.startsWith('.') &&
          base.endsWith('.tmp') &&
          !base.startsWith(`.${REFRESH_JOURNAL_FILENAME}.`)
        ) {
          refreshFsHooks.replaceTargetBeforeTempWrite();
        }
      }
      return actual.openSync(...args);
    }) as typeof import('node:fs').openSync,
    unlinkSync: ((...args: Parameters<typeof import('node:fs').unlinkSync>) => {
      if (refreshFsHooks.failUnlinkJournal) {
        const filePath = typeof args[0] === 'string' ? args[0] : '';
        if (filePath.endsWith(`/${REFRESH_JOURNAL_FILENAME}`)) {
          const error = new Error('EACCES: permission denied, unlink') as NodeJS.ErrnoException;
          error.code = 'EACCES';
          throw error;
        }
      }
      return actual.unlinkSync(...args);
    }) as typeof import('node:fs').unlinkSync,
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function buildInput(root: string, versionMarker: string): CompileVNextManifestInput {
  const refs = [
    '<!-- proofloop:entity id="goal" kind="goal" -->',
    `goal ${versionMarker}`,
    '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
    `task A ${versionMarker}`,
    '<!-- proofloop:entity id="S04-B-T01" kind="task" -->',
    `task B ${versionMarker}`,
    '<!-- proofloop:entity id="accept" kind="acceptance" -->',
    'acceptance',
    '<!-- proofloop:entity id="seam" kind="seam" -->',
    'seam',
    '<!-- proofloop:entity id="oracle" kind="oracle" -->',
    'oracle',
    '<!-- proofloop:entity id="risk" kind="risk" -->',
    'risk',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'refs.md'), refs, 'utf8');
  const tasks = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
  fs.mkdirSync(path.dirname(tasks), { recursive: true });
  fs.writeFileSync(tasks, 'not parsed\n', 'utf8');
  return {
    root,
    stage_id: 'S04',
    plan_path: 'delivery/stages/S04/tasks.md',
    plan: {
      schema_version: 2,
      items: [
        {
          id: 'S04-A-T01',
          kind: 'task',
          goal: `slice A goal ${versionMarker}`,
          refs: ['REF-TA'],
          dependencies: [],
          required_skills: [],
          execution_scope: {
            kind: 'implementation',
            code_paths: ['packages/runtime/src/vnext/evidence-refresh.ts'],
            test_paths: ['packages/runtime/src/cli/refresh-vnext-slice-evidence.spec.ts'],
            forbidden_paths: ['.proofloop/receipts'],
          },
        },
        {
          id: 'S04-B-T01',
          kind: 'task',
          goal: `slice B goal ${versionMarker}`,
          refs: ['REF-TB'],
          dependencies: [],
          required_skills: [],
          execution_scope: {
            kind: 'implementation',
            code_paths: ['packages/runtime/src/vnext/evidence-refresh.ts'],
            test_paths: ['packages/runtime/src/cli/refresh-vnext-slice-evidence.spec.ts'],
            forbidden_paths: ['.proofloop/receipts'],
          },
        },
      ],
    },
    refs: [
      { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/goal' },
      { ref_id: 'REF-TA', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
      { ref_id: 'REF-TB', kind: 'task', ref: 'refs.md#/entities/S04-B-T01' },
      { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
      { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/seam' },
      { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
      { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/risk' },
    ],
    authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
    slices: [
      {
        slice_id: 'S04-A',
        proof_index: {
          slice_id: 'S04-A',
          goal_ref: 'REF-G',
          task_refs: ['REF-TA'],
          acceptance_refs: ['REF-A'],
          seam_refs: ['REF-S'],
          oracle_refs: ['REF-O'],
          risk_refs: [
            {
              ref_id: 'REF-R',
              applies_to_acceptance_refs: ['REF-A'],
              applies_to_seam_refs: ['REF-S'],
            },
          ],
        },
        required_skills: [],
        depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      },
      {
        slice_id: 'S04-B',
        proof_index: {
          slice_id: 'S04-B',
          goal_ref: 'REF-G',
          task_refs: ['REF-TB'],
          acceptance_refs: ['REF-A'],
          seam_refs: ['REF-S'],
          oracle_refs: ['REF-O'],
          risk_refs: [
            {
              ref_id: 'REF-R',
              applies_to_acceptance_refs: ['REF-A'],
              applies_to_seam_refs: ['REF-S'],
            },
          ],
        },
        required_skills: [],
        depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-B.md',
      },
    ],
  };
}

interface RefreshFixture {
  readonly root: string;
  readonly manifestV1: string;
  readonly manifestV2: string;
  readonly evidenceDir: string;
  readonly evidenceA: string;
  readonly evidenceB: string;
  readonly digestV1: string;
  readonly digestV2: string;
}

function makeFixture(): RefreshFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-refresh-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestV1 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v1.json');
  const manifestV2 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v2.json');
  const evidenceDir = path.join(root, 'delivery', 'stages', 'S04', 'evidence');

  const requestV1 = path.join(root, 'request-v1.json');
  fs.writeFileSync(requestV1, JSON.stringify(buildInput(root, 'v1')), 'utf8');
  expect(compileVNextManifestCli([requestV1, manifestV1, root])).toBe(0);
  expect(initializeVNextSliceEvidence(manifestV1, evidenceDir, root).success).toBe(true);

  const requestV2 = path.join(root, 'request-v2.json');
  fs.writeFileSync(requestV2, JSON.stringify(buildInput(root, 'v2')), 'utf8');
  expect(compileVNextManifestCli([requestV2, manifestV2, root])).toBe(0);

  const digestV1 = computeDigest(JSON.parse(fs.readFileSync(manifestV1, 'utf8')));
  const digestV2 = computeDigest(JSON.parse(fs.readFileSync(manifestV2, 'utf8')));
  expect(digestV1).not.toBe(digestV2);
  return {
    root,
    manifestV1,
    manifestV2,
    evidenceDir,
    evidenceA: path.join(evidenceDir, 'S04-A.md'),
    evidenceB: path.join(evidenceDir, 'S04-B.md'),
    digestV1,
    digestV2,
  };
}

/** Write a synthetic interrupted-transaction state: journal + partial swap. */
function identityOf(file: string): string {
  const stat = fs.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
}

/** Canonical NEW skeleton of every declared evidence file for manifest-v2. */
function canonicalNewByFile(fx: RefreshFixture): Map<string, string> {
  const manifest = JSON.parse(fs.readFileSync(fx.manifestV2, 'utf8')) as VNextManifest;
  return new Map(
    manifest.slices.map((slice) => [
      path.basename(slice.evidence_path),
      renderVNextEvidenceSkeleton(manifest, slice, fx.digestV2),
    ]),
  );
}

/**
 * Synthetic interrupted-transaction state: journal + partial swap.  Every
 * entry's `new` content is the slice-specific CANONICAL skeleton rendered for
 * the current Manifest — never a cross-file copy (each Slice binds its own
 * Stage/Slice/Plan/Manifest identity).
 */
function installPartialTransaction(fx: RefreshFixture, oldContentA: string, oldContentB: string): void {
  const newByFile = canonicalNewByFile(fx);
  const newA = newByFile.get('S04-A.md') as string;
  const newB = newByFile.get('S04-B.md') as string;
  // Capture the pre-swap identities BEFORE touching the files.
  const identityA = identityOf(fx.evidenceA);
  const identityB = identityOf(fx.evidenceB);
  const journal = {
    version: 1,
    stage_id: 'S04',
    manifest_ref: 'delivery/stages/S04/tasks.md',
    previous_manifest_digest: fx.digestV1,
    manifest_digest: fx.digestV2,
    files: [
      { name: 'S04-A.md', old: oldContentA, new: newA, old_identity: identityA },
      { name: 'S04-B.md', old: oldContentB, new: newB, old_identity: identityB },
    ],
  };
  // File A already swapped to the new binding (an atomic rename replaced the
  // inode — simulate with unlink+create so the identity really changes);
  // file B still has the old one on its original inode.
  fs.unlinkSync(fx.evidenceA);
  fs.writeFileSync(fx.evidenceA, newA, 'utf8');
  fs.writeFileSync(fx.evidenceB, oldContentB, 'utf8');
  fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');
}

function readJournal(fx: RefreshFixture): Record<string, unknown> | null {
  const journalPath = path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) return null;
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Record<string, unknown>;
}

describe('refresh-vnext-slice-evidence — pre-admission pristine Evidence refresh transaction (S09-D-T01)', () => {
  it('refreshes every declared pristine skeleton to the new Manifest binding with full coverage', () => {
    const fx = makeFixture();
    const beforeA = fs.readFileSync(fx.evidenceA, 'utf8');
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');
    expect(beforeA).toContain(`Manifest Digest: ${fx.digestV1}`);
    expect(beforeB).toContain(`Manifest Digest: ${fx.digestV1}`);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(true);
    expect(result.mode).toBe('refresh');
    expect(result.blocked_recovery).toBe(false);
    expect(result.errors).toEqual([]);
    expect(result.refreshed).toHaveLength(2);
    // Full coverage: every declared evidence path is rebound.
    expect(result.refreshed).toContain('delivery/stages/S04/evidence/S04-A.md');
    expect(result.refreshed).toContain('delivery/stages/S04/evidence/S04-B.md');
    // Both files carry the NEW Manifest binding (not a mixture).
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    // The transaction journal is gone after success.
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed when the expected previous Manifest digest does not match the old binding', () => {
    const fx = makeFixture();
    const beforeA = fs.readFileSync(fx.evidenceA, 'utf8');
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: 'f'.repeat(64),
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_OLD_BINDING_MISMATCH')).toBe(true);
    // No write, no journal.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(beforeA);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(beforeB);
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed when any skeleton is non-pristine (Task Evidence already present)', () => {
    const fx = makeFixture();
    const beforeA = fs.readFileSync(fx.evidenceA, 'utf8');
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');
    fs.appendFileSync(fx.evidenceA, '\nworker evidence for S04-A-T01\n', 'utf8');

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_NON_PRISTINE')).toBe(true);
    // No partial refresh: the pristine sibling is untouched and no journal remains.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain('worker evidence for S04-A-T01');
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(beforeB);
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed on a mixed old binding — the full preflight runs before any file is written', () => {
    const fx = makeFixture();
    const beforeA = fs.readFileSync(fx.evidenceA, 'utf8');
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');
    // S04-A stays on the V1 binding; S04-B is replaced by a stale template
    // whose Manifest Digest is neither the expected old binding nor the new one.
    fs.writeFileSync(
      fx.evidenceB,
      beforeB.replace(`Manifest Digest: ${fx.digestV1}`, `Manifest Digest: ${'a'.repeat(64)}`),
      'utf8',
    );

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_OLD_BINDING_MISMATCH')).toBe(true);
    // Even the file that matched the old binding must NOT be swapped.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(beforeA);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${'a'.repeat(64)}`);
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed when an evidence file is a symlink', () => {
    const fx = makeFixture();
    fs.unlinkSync(fx.evidenceA);
    fs.symlinkSync(fx.evidenceB, fx.evidenceA);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    // The symlink is rejected at the root-bound manifest layer (canonical
    // resolution mismatch) or by the refresh file identity check — both are
    // fail-closed before any write.
    expect(
      result.errors.some(
        (error) =>
          error.type === 'EVIDENCE_SYMLINK' ||
          error.type === 'EVIDENCE_NON_PRISTINE' ||
          error.type === 'PATH_ESCAPE',
      ),
    ).toBe(true);
    expect(fs.lstatSync(fx.evidenceA).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed when a competitor file exists in the evidence directory', () => {
    const fx = makeFixture();
    fs.writeFileSync(path.join(fx.evidenceDir, 'COMPETITOR.md'), 'not declared', 'utf8');

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_DIR_COMPETITOR')).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed when the Stage already has plan/execution receipts (post-admission)', () => {
    const fx = makeFixture();
    const planDir = path.join(fx.root, '.proofloop', 'receipts', 'plan', 'S04');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'vnext-stage-plan.json'), '{}', 'utf8');

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.type === 'RECEIPT_ABSENCE_FAILED')).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    expect(readJournal(fx)).toBeNull();
  });

  it('returns blocked recovery when an unrecovered transaction journal exists', () => {
    const fx = makeFixture();
    const beforeA = fs.readFileSync(fx.evidenceA, 'utf8');
    installPartialTransaction(fx, beforeA, beforeA.replace(/Slice S04-A Evidence/, 'Slice S04-B Evidence'));

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.blocked_recovery).toBe(true);
    expect(result.errors.some((error) => error.type === 'UNRECOVERED_TRANSACTION')).toBe(true);
    // A fresh refresh must never silently continue a persisted transaction:
    // file A stays on the already-swapped canonical new content and the
    // journal is retained.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(canonicalNewByFile(fx).get('S04-A.md'));
    expect(readJournal(fx)).not.toBeNull();
  });

  it('recover mode completes an interrupted transaction from the journal', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    const newA = canonicalNewByFile(fx).get('S04-A.md') as string;
    // Interrupted state: file A already swapped, file B still old.
    installPartialTransaction(fx, oldA, oldB);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(result.success).toBe(true);
    expect(result.recovered).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(newA);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    expect(readJournal(fx)).toBeNull();
  });

  it('rollback mode reverts a partially updated transaction to the old binding', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    installPartialTransaction(fx, oldA, oldB);

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'rollback',
    });
    expect(result.success).toBe(true);
    expect(result.rolled_back).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(oldB);
    expect(readJournal(fx)).toBeNull();
  });

  it('recover/rollback fail closed when the journal does not match the requested Manifest', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    installPartialTransaction(fx, oldA, fs.readFileSync(fx.evidenceB, 'utf8'));
    // Corrupt the journal's manifest binding.
    const journalPath = path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { manifest_digest: string };
    journal.manifest_digest = 'b'.repeat(64);
    fs.writeFileSync(journalPath, JSON.stringify(journal), 'utf8');

    const recover = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(recover.success).toBe(false);
    expect(recover.blocked_recovery).toBe(true);
    expect(readJournal(fx)).not.toBeNull();

    const rollback = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'rollback',
    });
    expect(rollback.success).toBe(false);
    expect(rollback.blocked_recovery).toBe(true);
    expect(readJournal(fx)).not.toBeNull();
  });

  it('dist entry performs the same refresh after build', () => {
    const fx = makeFixture();
    const dist = path.join(
      path.resolve(__dirname, '..', '..', '..', '..'),
      'packages',
      'runtime',
      'dist',
      'cli',
      'refresh-vnext-slice-evidence.js',
    );
    const result = spawnSync(
      process.execPath,
      [dist, fx.manifestV2, fx.digestV1, fx.evidenceDir, fx.root],
      { encoding: 'utf8', timeout: 30000 },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as RefreshVNextSliceEvidenceResult;
    expect(parsed.success).toBe(true);
    expect(parsed.stage_id).toBe('S04');
    expect(parsed.refreshed).toHaveLength(2);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    expect(readJournal(fx)).toBeNull();
  });
});

describe('S09-D-T02 — fresh S10 fixture proves the compile/validate/initialize/recompile/refresh/final-validate chain', () => {
  /**
   * Build a Materializer-shaped active candidate input for a FRESH S10 stage
   * inside a temp root.  The real `delivery/stages/S10` directory is never
   * touched: everything lives under `root`.
   */
  function buildS10CandidateInput(root: string, versionMarker: string): Record<string, unknown> {
    const planPath = 'delivery/stages/S10/tasks.md';
    const tasksPath = path.join(root, planPath);
    fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
    // The tasks.md body is FIXED across the v1/v2 recompile: only the
    // candidate goal text carries the version marker, so the reference
    // file/section digests stay stable while the plan digest changes.
    fs.writeFileSync(
      tasksPath,
      [
        '<!-- proofloop:entity id="S10-goal" kind="goal" -->',
        'stage goal',
        ...['A', 'B', 'C', 'D', 'E'].flatMap((letter) => [
          `<!-- proofloop:entity id="S10-${letter}-goal" kind="goal" -->`,
          `slice goal ${letter}`,
          `<!-- proofloop:entity id="S10-${letter}-T01" kind="task" -->`,
          `task goal ${letter}`,
        ]),
        '<!-- proofloop:entity id="S10-A-acceptance" kind="acceptance" -->',
        'acceptance',
        '<!-- proofloop:entity id="S10-A-seam" kind="seam" -->',
        'seam',
        '<!-- proofloop:entity id="S10-A-oracle" kind="oracle" -->',
        'oracle',
        '<!-- proofloop:entity id="S10-A-risk" kind="risk" -->',
        'risk',
        '<!-- proofloop:entity id="S10-RUNTIME-PROOF" kind="proof_spec" -->',
        'executable proof specification',
      ].join('\n'),
      'utf8',
    );
    const entity = (ref_id: string, kind: string, entityId: string) => ({
      ref_id,
      kind,
      ref: `${planPath}#/entities/${entityId}`,
    });
    return {
      schema_version: 2,
      mode: 'replan',
      caller: 'brain',
      owner: 'pluginv2-active-plan-materializer',
      project_root: root,
      stage_id: 'S10',
      candidate_plan_path: planPath,
      selected_work_item_refs: [`${planPath}#/entities/S10-A-goal`],
      authority_entity_refs: [`${planPath}#/entities/S10-A-acceptance`],
      existing_plan_ref: planPath,
      finding_refs: [],
      stage_goal: {
        entity_id: 'S10-goal',
        ref_id: 'REF-S10-GOAL',
        goal: `Compile one executable Runtime Proof for the fresh S10 fixture ${versionMarker}.`,
        refs: ['REF-S10-A-GOAL', 'REF-S10-B-GOAL', 'REF-S10-C-GOAL', 'REF-S10-D-GOAL', 'REF-S10-E-GOAL'],
      },
      dependencies: [],
      constraints: ['candidate-only; fixture lives in a temp root'],
      out_of_scope: ['execution'],
      reference_index: [
        entity('REF-S10-GOAL', 'goal', 'S10-goal'),
        ...['A', 'B', 'C', 'D', 'E'].flatMap((letter) => [
          entity(`REF-S10-${letter}-GOAL`, 'goal', `S10-${letter}-goal`),
          entity(`REF-S10-${letter}-T01`, 'task', `S10-${letter}-T01`),
        ]),
        entity('REF-S10-A-ACCEPTANCE', 'acceptance', 'S10-A-acceptance'),
        entity('REF-S10-A-SEAM', 'seam', 'S10-A-seam'),
        entity('REF-S10-A-ORACLE', 'oracle', 'S10-A-oracle'),
        entity('REF-S10-A-RISK', 'risk', 'S10-A-risk'),
        entity('REF-S10-RUNTIME-PROOF', 'proof_spec', 'S10-RUNTIME-PROOF'),
      ],
      slices: ['S10-A', 'S10-B', 'S10-C', 'S10-D', 'S10-E'].map((sliceId, sliceIndex) => ({
        slice_id: sliceId,
        goal_entity_id: `${sliceId}-goal`,
        goal: `Execute the fresh S10 chain under a real executable proof ${versionMarker}.`,
        proof_index: {
          slice_id: sliceId,
          goal_ref: `REF-${sliceId}-GOAL`,
          task_refs: [`REF-${sliceId}-T01`],
          acceptance_refs: ['REF-S10-A-ACCEPTANCE'],
          seam_refs: ['REF-S10-A-SEAM'],
          oracle_refs: ['REF-S10-A-ORACLE'],
          risk_refs: [
            {
              ref_id: 'REF-S10-A-RISK',
              applies_to_acceptance_refs: ['REF-S10-A-ACCEPTANCE'],
              applies_to_seam_refs: ['REF-S10-A-SEAM'],
            },
          ],
        },
        dependencies: [],
        required_skills: ['test-driven-development'],
        evidence_path: `delivery/stages/S10/evidence/S10-${String.fromCharCode(65 + sliceIndex)}.md`,
        tasks: [
          {
            task_id: `${sliceId}-T01`,
            entity_id: `${sliceId}-T01`,
            goal: `Run the fresh S10 chain ${versionMarker}.`,
            refs: [`REF-${sliceId}-T01`],
            dependencies: [sliceId],
            required_skills: ['test-driven-development'],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/vnext/candidate-input.ts'],
              test_paths: ['packages/runtime/src/vnext/candidate-input.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
            checkbox: false,
            status: 'NOT_STARTED',
            cv_status: 'NOT_RUN',
          },
        ],
      })),
    };
  }

  interface S10Fixture {
    readonly root: string;
    readonly tasksPath: string;
    readonly evidenceDir: string;
    readonly evidence: readonly string[];
    readonly manifestV1: string;
    readonly manifestV2: string;
    readonly digestV1: string;
    readonly digestV2: string;
  }

  function makeS10Fixture(): S10Fixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-s10-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const tasksPath = path.join(root, 'delivery', 'stages', 'S10', 'tasks.md');
    const evidenceDir = path.join(root, 'delivery', 'stages', 'S10', 'evidence');
    const evidence = ['A', 'B', 'C', 'D', 'E'].map((letter) => path.join(evidenceDir, `S10-${letter}.md`));
    const manifestV1 = path.join(root, 'delivery', 'stages', 'S10', 'manifest-v1.json');
    const manifestV2 = path.join(root, 'delivery', 'stages', 'S10', 'manifest-v2.json');

    const requestV1 = path.join(root, 'request-v1.json');
    fs.writeFileSync(requestV1, JSON.stringify(buildS10CandidateInput(root, 'v1')), 'utf8');
    expect(compileVNextManifestCli([requestV1, manifestV1, root])).toBe(0);
    expect(initializeVNextSliceEvidence(manifestV1, evidenceDir, root).success).toBe(true);

    const requestV2 = path.join(root, 'request-v2.json');
    fs.writeFileSync(requestV2, JSON.stringify(buildS10CandidateInput(root, 'v2')), 'utf8');
    expect(compileVNextManifestCli([requestV2, manifestV2, root])).toBe(0);

    const digestV1 = computeDigest(JSON.parse(fs.readFileSync(manifestV1, 'utf8')));
    const digestV2 = computeDigest(JSON.parse(fs.readFileSync(manifestV2, 'utf8')));
    expect(digestV1).not.toBe(digestV2);
    return { root, tasksPath, evidenceDir, evidence, manifestV1, manifestV2, digestV1, digestV2 };
  }

  it('runs the full chain over ALL five declared skeletons and keeps the restricted boundary on a fresh S10 fixture', () => {
    const fx = makeS10Fixture();

    // 1. compile v1 (Materializer-shaped candidate with executable proof)
    //    already done in makeS10Fixture.
    // 2. mechanical validation of the fresh v1 Manifest + initialized evidence
    const validatedV1 = validateVNextStage(fx.tasksPath, fx.manifestV1, fx.evidenceDir, fx.root);
    expect(validatedV1.valid).toBe(true);
    expect(validatedV1.errors).toEqual([]);
    for (const evidence of fx.evidence) {
      expect(fs.readFileSync(evidence, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    }

    // 3. recompile v2 — new Manifest digest, evidence still bound to v1.
    // 4. final validation BEFORE refresh fails closed on the old binding.
    const preRefresh = validateVNextStage(fx.tasksPath, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(preRefresh.valid).toBe(false);
    expect(preRefresh.errors.some((error) => error.type === 'EVIDENCE_BINDING_MISMATCH')).toBe(true);

    // 5. refresh transaction rebinds every pristine skeleton to the new binding.
    const refreshed = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(refreshed.success).toBe(true);
    expect(refreshed.errors).toEqual([]);
    expect(refreshed.refreshed).toHaveLength(5);
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      expect(refreshed.refreshed).toContain(`delivery/stages/S10/evidence/S10-${letter}.md`);
      expect(fs.readFileSync(path.join(fx.evidenceDir, `S10-${letter}.md`), 'utf8')).toContain(
        `Manifest Digest: ${fx.digestV2}`,
      );
    }

    // 6. final validation passes with the all-binding Validator.
    const finalValidated = validateVNextStage(fx.tasksPath, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(finalValidated.valid).toBe(true);
    expect(finalValidated.errors).toEqual([]);

    // Restricted boundary: the fixture root contains ONLY the declared
    // artifacts — no .proofloop, no Receipts, no stray files, no journal —
    // and the Runtime-owned proof digest is derived from the canonical
    // projection (never caller-supplied).
    expect(fs.existsSync(path.join(fx.root, '.proofloop'))).toBe(false);
    expect(fs.readdirSync(fx.evidenceDir)).toEqual(['S10-A.md', 'S10-B.md', 'S10-C.md', 'S10-D.md', 'S10-E.md']);
    const manifest = JSON.parse(fs.readFileSync(fx.manifestV2, 'utf8')) as Record<string, unknown>;
    expect('runtime_proof' in manifest).toBe(false);
  });

  it('restricted boundary: old-binding refresh, non-pristine files, receipts and unrecovered journals fail closed', () => {
    const fx = makeS10Fixture();

    // a) Wrong expected previous digest → EVIDENCE_OLD_BINDING_MISMATCH, no writes.
    const wrongPrevious = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: 'f'.repeat(64),
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(wrongPrevious.success).toBe(false);
    expect(wrongPrevious.errors.some((error) => error.type === 'EVIDENCE_OLD_BINDING_MISMATCH')).toBe(true);
    for (const evidence of fx.evidence) {
      expect(fs.readFileSync(evidence, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    }
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);

    // b) Non-pristine skeleton (Task Evidence present) → EVIDENCE_NON_PRISTINE,
    //    and the other four pristine skeletons stay untouched.
    fs.appendFileSync(fx.evidence[0], '\nworker evidence for S10-A-T01\n', 'utf8');
    const nonPristine = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(nonPristine.success).toBe(false);
    expect(nonPristine.errors.some((error) => error.type === 'EVIDENCE_NON_PRISTINE')).toBe(true);
    for (const evidence of fx.evidence.slice(1)) {
      expect(fs.readFileSync(evidence, 'utf8')).toContain(`Manifest Digest: ${fx.digestV1}`);
    }
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);

    // c) Post-admission receipts block the refresh transaction.
    fs.writeFileSync(
      fx.evidence[0],
      fs.readFileSync(fx.evidence[0], 'utf8').replace('\nworker evidence for S10-A-T01\n', ''),
      'utf8',
    );
    const planDir = path.join(fx.root, '.proofloop', 'receipts', 'plan', 'S10');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'vnext-stage-plan.json'), '{}', 'utf8');
    const receiptBlocked = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(receiptBlocked.success).toBe(false);
    expect(receiptBlocked.errors.some((error) => error.type === 'RECEIPT_ABSENCE_FAILED')).toBe(true);
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);
  });

  it('restricted boundary: an unrecovered journal blocks final validation, and an incomplete journal set never recovers', () => {
    const fx = makeS10Fixture();
    const oldContents = fx.evidence.map((evidence) => fs.readFileSync(evidence, 'utf8'));
    // Canonical NEW skeletons rendered for the CURRENT Manifest — every entry
    // binds its own Slice identity (never a cross-file copy).
    const manifestV2Value = JSON.parse(fs.readFileSync(fx.manifestV2, 'utf8')) as VNextManifest;
    const newByFile = new Map(
      manifestV2Value.slices.map((slice) => [
        path.basename(slice.evidence_path),
        renderVNextEvidenceSkeleton(manifestV2Value, slice, fx.digestV2),
      ]),
    );
    // Deliberately INCOMPLETE journal: only one of the five declared files.
    const journal = {
      version: 1,
      stage_id: 'S10',
      manifest_ref: 'delivery/stages/S10/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: [
        {
          name: 'S10-A.md',
          old: oldContents[0],
          new: newByFile.get('S10-A.md'),
          old_identity: identityOf(fx.evidence[0]),
        },
      ],
    };
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');

    const blocked = validateVNextStage(fx.tasksPath, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(blocked.valid).toBe(false);
    expect(blocked.errors.some((error) => error.type === 'UNRECOVERED_TRANSACTION')).toBe(true);

    // A fresh refresh must fail closed on the unrecovered journal.
    const fresh = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(fresh.success).toBe(false);
    expect(fresh.blocked_recovery).toBe(true);

    // recover must FAIL CLOSED on the incomplete journal set: it must never
    // modify undeclared files nor report success for a partial transaction.
    const incompleteRecover = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(incompleteRecover.success).toBe(false);
    expect(incompleteRecover.errors.some((error) => error.type === 'JOURNAL_BINDING_MISMATCH')).toBe(true);
    for (let index = 0; index < fx.evidence.length; index += 1) {
      expect(fs.readFileSync(fx.evidence[index], 'utf8')).toBe(oldContents[index]);
    }
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(true);

    // A COMPLETE journal (all five files) recovers, then final validation passes.
    const completeJournal = {
      version: 1,
      stage_id: 'S10',
      manifest_ref: 'delivery/stages/S10/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: fx.evidence.map((evidence, index) => ({
        name: path.basename(evidence),
        old: oldContents[index],
        new: newByFile.get(path.basename(evidence)),
        old_identity: identityOf(evidence),
      })),
    };
    fs.writeFileSync(
      path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE),
      JSON.stringify(completeJournal),
      'utf8',
    );
    const recovered = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(recovered.success).toBe(true);
    expect(recovered.recovered).toBe(true);
    for (const evidence of fx.evidence) {
      expect(fs.readFileSync(evidence, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    }
    expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);
    const finalValidated = validateVNextStage(fx.tasksPath, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(finalValidated.valid).toBe(true);
  });
});

describe('S09-D-T01 repair — journal binding/identity, duplicate binding fields, post-swap CAS failure and zero-write (CV S09-D-REPAIR-UNBOUND-JOURNAL-PARTIAL-CAS-CWD-PARITY-S10-COVERAGE)', () => {
  it('rejects a forged journal whose file set is not exactly the Manifest declarations', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    const newA = oldA.replace(`Manifest Digest: ${fx.digestV1}`, `Manifest Digest: ${fx.digestV2}`);
    // Forged journal: declares an UNDECLARED file alongside the real ones.
    const journal = {
      version: 1,
      stage_id: 'S04',
      manifest_ref: 'delivery/stages/S04/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: [
        { name: 'S04-A.md', old: oldA, new: newA, old_identity: identityOf(fx.evidenceA) },
        { name: 'S04-B.md', old: oldB, new: newA, old_identity: identityOf(fx.evidenceB) },
        { name: 'EVIL.md', old: oldA, new: newA, old_identity: identityOf(fx.evidenceA) },
      ],
    };
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');

    for (const mode of ['recover', 'rollback'] as const) {
      const result = refreshVNextSliceEvidence({
        manifestPath: fx.manifestV2,
        previousManifestDigest: fx.digestV1,
        evidenceDir: fx.evidenceDir,
        projectRoot: fx.root,
        mode,
      });
      expect(result.success).toBe(false);
      expect(result.errors.some((error) => error.type === 'JOURNAL_BINDING_MISMATCH')).toBe(true);
      // No declared file was modified and no undeclared file was created.
      expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
      expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(oldB);
      expect(fs.existsSync(path.join(fx.evidenceDir, 'EVIL.md'))).toBe(false);
      expect(readJournal(fx)).not.toBeNull();
    }
  });

  it('rejects a journal bound to a different previous Manifest digest', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    const newA = oldA.replace(`Manifest Digest: ${fx.digestV1}`, `Manifest Digest: ${fx.digestV2}`);
    const journal = {
      version: 1,
      stage_id: 'S04',
      manifest_ref: 'delivery/stages/S04/tasks.md',
      previous_manifest_digest: 'a'.repeat(64),
      manifest_digest: fx.digestV2,
      files: [
        { name: 'S04-A.md', old: oldA, new: newA, old_identity: identityOf(fx.evidenceA) },
        { name: 'S04-B.md', old: oldB, new: newA, old_identity: identityOf(fx.evidenceB) },
      ],
    };
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');

    const recover = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(recover.success).toBe(false);
    expect(recover.errors.some((error) => error.type === 'JOURNAL_BINDING_MISMATCH')).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
    expect(readJournal(fx)).not.toBeNull();
  });

  it('fails closed on duplicate Plan Digest / Manifest Digest binding lines instead of ignoring them', () => {
    const fx = makeFixture();
    const beforeA = fs.readFileSync(fx.evidenceA, 'utf8');
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');
    // Duplicate binding lines inside the Plan Binding section: the pristine
    // comparison must NOT strip them away.
    fs.writeFileSync(
      fx.evidenceA,
      beforeA.replace(
        `- Manifest Digest: ${fx.digestV1}`,
        `- Manifest Digest: ${fx.digestV1}\n- Manifest Digest: ${fx.digestV1}`,
      ),
      'utf8',
    );

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(
      result.errors.some(
        (error) => error.type === 'EVIDENCE_OLD_BINDING_MISMATCH' || error.type === 'EVIDENCE_NON_PRISTINE',
      ),
    ).toBe(true);
    // The pristine sibling stays untouched and no journal was written.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`- Manifest Digest: ${fx.digestV1}\n- Manifest Digest: ${fx.digestV1}`);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(beforeB);
    expect(readJournal(fx)).toBeNull();
  });

  it('rolls back the already-swapped file when the post-swap read-back fails (never leaves an unrecoverable partial binding)', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');

    // Inject a post-swap read-back failure: immediately after the atomic
    // rename of S04-A.md, strip its read permission so the verification read
    // fails (EACCES) — the rename already succeeded, so the file holds the
    // new binding and MUST be added to the rollback set.  The in-process
    // rollback then also fails to read it, so the journal must be RETAINED
    // (blocked recovery) instead of being deleted into an unrecoverable
    // partial-new state.
    let renamedTarget = '';
    refreshFsHooks.afterRenameSync = (args: unknown[]) => {
      const target = String((args as [string, string])[1]);
      if (target.endsWith('/S04-A.md')) {
        renamedTarget = target;
        fs.chmodSync(target, 0o000);
      }
    };
    try {
      const result = refreshVNextSliceEvidence({
        manifestPath: fx.manifestV2,
        previousManifestDigest: fx.digestV1,
        evidenceDir: fx.evidenceDir,
        projectRoot: fx.root,
      });
      expect(result.success).toBe(false);
      expect(result.blocked_recovery).toBe(true);
      expect(result.errors.some((error) => error.type === 'EVIDENCE_SWAP_FAILED')).toBe(true);
      expect(result.errors.some((error) => error.type === 'ROLLBACK_FAILED')).toBe(true);
      // The swapped file was tracked for rollback, but the rollback itself
      // could not read it — the journal is retained so the partial state is
      // detectable and recoverable by an operator.
      expect(fs.existsSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE))).toBe(true);
      expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(oldB);
    } finally {
      refreshFsHooks.afterRenameSync = null;
      if (renamedTarget.length > 0) {
        try {
          fs.chmodSync(renamedTarget, 0o644);
        } catch {
          // best effort
        }
      }
    }
  });

  it('performs the receipt-absence preflight before creating the evidence directory (zero writes on rejection)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-zero-write-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    // Compile v1+v2 WITHOUT initializing the evidence skeletons.
    const requestV1 = path.join(root, 'request-v1.json');
    fs.writeFileSync(requestV1, JSON.stringify(buildInput(root, 'v1')), 'utf8');
    const manifestV1 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v1.json');
    expect(compileVNextManifestCli([requestV1, manifestV1, root])).toBe(0);
    const requestV2 = path.join(root, 'request-v2.json');
    fs.writeFileSync(requestV2, JSON.stringify(buildInput(root, 'v2')), 'utf8');
    const manifestV2 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v2.json');
    expect(compileVNextManifestCli([requestV2, manifestV2, root])).toBe(0);
    const digestV1 = computeDigest(JSON.parse(fs.readFileSync(manifestV1, 'utf8')));

    // The Stage is already post-admission: plan receipts exist.
    const planDir = path.join(root, '.proofloop', 'receipts', 'plan', 'S04');
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(path.join(planDir, 'vnext-stage-plan.json'), '{}', 'utf8');

    const evidenceDir = path.join(root, 'delivery', 'stages', 'S04', 'evidence');
    const result = refreshVNextSliceEvidence({
      manifestPath: manifestV2,
      previousManifestDigest: digestV1,
      evidenceDir,
      projectRoot: root,
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.type === 'RECEIPT_ABSENCE_FAILED')).toBe(true);
    // ZERO writes: the evidence directory itself must never have been created.
    expect(fs.existsSync(evidenceDir)).toBe(false);
    expect(fs.existsSync(path.join(evidenceDir, REFRESH_JOURNAL_FILE))).toBe(false);
  });

  it('recover fails closed when the on-disk file identity no longer matches the journaled old identity', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    installPartialTransaction(fx, oldA, oldB);
    // Replace file A with a NEW inode carrying the SAME old content: the
    // journaled old identity no longer matches.
    fs.unlinkSync(fx.evidenceA);
    fs.writeFileSync(fx.evidenceA, oldA, 'utf8');

    const recover = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(recover.success).toBe(false);
    expect(recover.errors.some((error) => error.type === 'UNRECOVERABLE_STATE')).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
    expect(readJournal(fx)).not.toBeNull();
  });

  it('preflights EVERY journal entry before ANY write: a legal first file is never touched when a later entry is forged', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    const newByFile = canonicalNewByFile(fx);
    const identityA = identityOf(fx.evidenceA);
    const identityB = identityOf(fx.evidenceB);
    // Entry A is fully legal (canonical old + canonical new + correct
    // identity); entry B is FORGED: its journaled new is NOT the canonical
    // skeleton for S04-B.
    const journal = {
      version: 1,
      stage_id: 'S04',
      manifest_ref: 'delivery/stages/S04/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: [
        { name: 'S04-A.md', old: oldA, new: newByFile.get('S04-A.md'), old_identity: identityA },
        { name: 'S04-B.md', old: oldB, new: `${newByFile.get('S04-B.md')}\nextra forged line\n`, old_identity: identityB },
      ],
    };
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');

    const recover = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'recover',
    });
    expect(recover.success).toBe(false);
    expect(recover.blocked_recovery).toBe(true);
    expect(recover.errors.some((error) => error.type === 'UNRECOVERABLE_STATE')).toBe(true);
    // ZERO modification: the legal first file was NOT swapped even though its
    // own entry passed — the whole transaction preflights first.
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(oldB);
    expect(readJournal(fx)).not.toBeNull();
  });

  it('rejects a forged replacement (legal old + forged new) with zero writes and the journal retained', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    const newByFile = canonicalNewByFile(fx);
    const identityA = identityOf(fx.evidenceA);
    const identityB = identityOf(fx.evidenceB);
    // Forged new: looks like the refreshed skeleton (Manifest Digest replaced)
    // but is NOT the canonical render — an attacker who knows the digest
    // values cannot fabricate a writable replacement.
    const forgedNew = newByFile.get('S04-A.md')!.replace(
      `- Manifest Digest: ${fx.digestV2}`,
      `- Manifest Digest: ${fx.digestV2}\n- Manifest Digest: ${fx.digestV2}`,
    );
    const journal = {
      version: 1,
      stage_id: 'S04',
      manifest_ref: 'delivery/stages/S04/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: [
        { name: 'S04-A.md', old: oldA, new: forgedNew, old_identity: identityA },
        { name: 'S04-B.md', old: oldB, new: newByFile.get('S04-B.md'), old_identity: identityB },
      ],
    };
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');

    for (const mode of ['recover', 'rollback'] as const) {
      const result = refreshVNextSliceEvidence({
        manifestPath: fx.manifestV2,
        previousManifestDigest: fx.digestV1,
        evidenceDir: fx.evidenceDir,
        projectRoot: fx.root,
        mode,
      });
      expect(result.success).toBe(false);
      expect(result.blocked_recovery).toBe(true);
      expect(result.errors.some((error) => error.type === 'UNRECOVERABLE_STATE')).toBe(true);
      expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
      expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(oldB);
      expect(readJournal(fx)).not.toBeNull();
    }
  });

  it('rollback then a fresh refresh restores a consistent state that final validation accepts', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    installPartialTransaction(fx, oldA, oldB);

    const rolledBack = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
      mode: 'rollback',
    });
    expect(rolledBack.success).toBe(true);
    expect(rolledBack.rolled_back).toBe(true);
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(oldA);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(oldB);

    // After rollback the files are on the OLD binding: final validation of the
    // CURRENT Manifest correctly fails closed (old binding, not a mixed one).
    const tasksPath = path.join(fx.root, 'delivery', 'stages', 'S04', 'tasks.md');
    const oldBindingValidate = validateVNextStage(tasksPath, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(oldBindingValidate.valid).toBe(false);
    expect(oldBindingValidate.errors.some((error) => error.type === 'EVIDENCE_BINDING_MISMATCH')).toBe(true);

    // A fresh refresh rebinds both files, and final validation passes.
    const refreshed = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(refreshed.success).toBe(true);
    const finalValidate = validateVNextStage(tasksPath, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(finalValidate.valid).toBe(true);
    expect(finalValidate.errors).toEqual([]);
  });

  it('built dist CLI recovers an interrupted transaction and removes the journal', () => {
    const fx = makeFixture();
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    installPartialTransaction(fx, oldA, oldB);
    const dist = path.join(
      path.resolve(__dirname, '..', '..', '..', '..'),
      'packages',
      'runtime',
      'dist',
      'cli',
      'refresh-vnext-slice-evidence.js',
    );
    const result = spawnSync(
      process.execPath,
      [dist, fx.manifestV2, fx.digestV1, fx.evidenceDir, fx.root, 'recover'],
      { encoding: 'utf8', timeout: 30000 },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as RefreshVNextSliceEvidenceResult;
    expect(parsed.success).toBe(true);
    expect(parsed.recovered).toBe(true);
    expect(parsed.mode).toBe('recover');
    expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(canonicalNewByFile(fx).get('S04-A.md'));
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
    expect(readJournal(fx)).toBeNull();
  });

  it('fails closed when the Evidence file carries a duplicate Plan Binding section', () => {
    const fx = makeFixture();
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');
    // A second `## Plan Binding` section anywhere in the file must fail
    // closed — the parser refuses duplicated sections entirely.
    fs.appendFileSync(fx.evidenceA, '\n## Plan Binding\n\n- Stage ID: S04\n', 'utf8');

    const result = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(result.success).toBe(false);
    expect(result.refreshed).toEqual([]);
    expect(
      result.errors.some(
        (error) => error.type === 'EVIDENCE_OLD_BINDING_MISMATCH' || error.type === 'EVIDENCE_NON_PRISTINE',
      ),
    ).toBe(true);
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(beforeB);
    expect(readJournal(fx)).toBeNull();
  });
});

// ============================================================
// S09-REVIEW-001 — atomic identity CAS before rename + journal
// removal failure is reported as blocked (never silent success)
// ============================================================
describe('S09-REVIEW-001 — refresh identity CAS and journal removal fail-closed', () => {
  it('rejects a swap whose target identity changed between compare and rename (zero replacement write)', () => {
    const fx = makeFixture();
    const attackerContent = '# attacker replaced the target in the compare/rename window\n';
    const beforeB = fs.readFileSync(fx.evidenceB, 'utf8');
    let fired = false;
    refreshFsHooks.replaceTargetBeforeTempWrite = () => {
      if (fired) return;
      fired = true;
      // Replace S04-A.md with a DIFFERENT inode + content while the swap is
      // between the compare and the rename: the identity CAS must refuse.
      fs.unlinkSync(fx.evidenceA);
      fs.writeFileSync(fx.evidenceA, attackerContent, 'utf8');
    };
    try {
      const result = refreshVNextSliceEvidence({
        manifestPath: fx.manifestV2,
        previousManifestDigest: fx.digestV1,
        evidenceDir: fx.evidenceDir,
        projectRoot: fx.root,
      });
      expect(result.success).toBe(false);
      expect(result.refreshed).toEqual([]);
      expect(result.errors.some((error) => error.type === 'EVIDENCE_SWAP_FAILED')).toBe(true);
      // The rename was refused BEFORE it happened: the failure is a clean
      // transaction abort (journal removed, no blocked recovery), never a
      // half-swap that needed rollback.
      expect(result.blocked_recovery).toBe(false);
      expect(readJournal(fx)).toBeNull();
      // The attacker content is never overwritten by the replacement and the
      // sibling file is untouched (no partial transaction).
      expect(fs.readFileSync(fx.evidenceA, 'utf8')).toBe(attackerContent);
      expect(fs.readFileSync(fx.evidenceB, 'utf8')).toBe(beforeB);
    } finally {
      refreshFsHooks.replaceTargetBeforeTempWrite = null;
    }
  });

  it('reports blocked recovery when the journal cannot be removed after a successful refresh', () => {
    const fx = makeFixture();
    refreshFsHooks.failUnlinkJournal = true;
    try {
      const result = refreshVNextSliceEvidence({
        manifestPath: fx.manifestV2,
        previousManifestDigest: fx.digestV1,
        evidenceDir: fx.evidenceDir,
        projectRoot: fx.root,
      });
      // The files were refreshed, but the transaction must NOT be reported as
      // success while the journal (the recoverable state) is still present.
      expect(result.success).toBe(false);
      expect(result.blocked_recovery).toBe(true);
      expect(result.errors.some((error) => error.type === 'JOURNAL_REMOVE_FAILED')).toBe(true);
      expect(fs.readFileSync(fx.evidenceA, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
      expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);
      // The journal is retained so recover/rollback stays possible.
      expect(readJournal(fx)).not.toBeNull();
    } finally {
      refreshFsHooks.failUnlinkJournal = false;
    }
  });
});
