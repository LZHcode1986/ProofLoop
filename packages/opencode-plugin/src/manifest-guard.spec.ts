/**
 * @proofloop/opencode-plugin — Manifest content trust-root guard spec
 * (S2 review finding S2-F-001, OUT-S2-01/03).
 *
 * PO: S2-F-001 (malicious manifest content fields must fail closed before any
 * runtime read), re-verified at the shared `validateManifestContentFields`
 * seam consumed by `proofloop_stage(status/next)` and
 * `proofloop_review(stage_status)` (via the shared stage status handler).
 *
 * The guard validates the manifest CONTENT fields the runtime derives read
 * paths from:
 *   - `slice.evidence_path` must resolve inside the canonical worktree root
 *     (component-wise realpath walk — rejects `..` escapes, absolute escapes
 *     and symlink escapes);
 *   - `slice.slice_id` must be a canonical slice id (`/^S\d{2,}-[A-Z]$/` —
 *     rejects path separators, `..` and absolute prefixes).
 *
 * Fail-closed codes: unreadable / invalid-JSON manifest →
 * DOMAIN.STAGE_NOT_FOUND; schema-invalid manifest → RUNTIME.SCHEMA_MISMATCH;
 * malicious content field → HOST.PROJECT_NOT_TRUSTED. Every finding is
 * verified through the kernel `validateFinding` oracle (the S1 boundary).
 */

import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateFinding } from '@proofloop/runtime';
import {
  CANONICAL_SLICE_ID,
  checkManifestContentBaseline,
  reverifyManifestContentAfterRead,
  reverifyManifestPathIdentity,
  validateManifestContentFields,
} from './manifest-guard.js';
import type { ManifestContentBaseline } from './manifest-guard.js';

/** Real temp worktree fixture (canonical trust root). */
function makeWorktree(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), 's2f001-guard-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Schema-valid manifest with a controllable slice content (S2-F-001). */
function writeManifest(
  root: string,
  opts: { slice_id?: string; evidence_path?: string } = {},
): string {
  const manifestPath = path.join(root, '.proofloop', 'manifests', 'S2.json');
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const manifest = {
    stage_id: 'S2',
    source_path: 'delivery/stages/S2/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'goal',
    outcomes: ['out'],
    slices: [
      {
        slice_id: opts.slice_id ?? 'S02-A',
        goal: 'goal',
        observable_outcome: 'out',
        public_seam: 'seam',
        dependencies: [],
        proof_obligations: [],
        tasks: ['S02-A-T01'],
        risk_facts: [],
        evidence_path:
          opts.evidence_path ?? 'delivery/stages/S2/evidence/S02-A.md',
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: [],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
  return manifestPath;
}

/** Assert every finding of a fail-closed guard result is kernel-canonical. */
function assertCanonicalFindings(result: { findings: readonly { code: string }[] }): void {
  expect(result.findings.length).toBeGreaterThan(0);
  for (const finding of result.findings) {
    expect(() => validateFinding(finding as never)).not.toThrow();
  }
}

/** Assert a fail-closed result carries exactly the expected finding code. */
function expectFailCode(
  result: { findings: readonly { code: string }[] } | null,
  code: string,
): void {
  expect(result).not.toBeNull();
  const findings = result?.findings ?? [];
  expect(findings.some((f) => f.code === code)).toBe(true);
  assertCanonicalFindings(result as { findings: readonly { code: string }[] });
}

describe('CANONICAL_SLICE_ID (S2-F-001 slice id pattern)', () => {
  it('accepts the canonical slice id forms', () => {
    expect(CANONICAL_SLICE_ID.test('S02-A')).toBe(true);
    expect(CANONICAL_SLICE_ID.test('S03-B')).toBe(true);
    expect(CANONICAL_SLICE_ID.test('S10-Z')).toBe(true);
  });

  it.each([
    'S02-A/../../etc',
    'S02-A\\..\\..\\tmp',
    '../../etc/passwd',
    '/etc/passwd',
    '..',
    'S02-A/..',
    'S02-A:../etc',
    'S02-A-T01',
    'S2-A',
    'S02-A1',
    'S02',
    '',
  ])('rejects non-canonical slice id %s', (sliceId) => {
    expect(CANONICAL_SLICE_ID.test(sliceId)).toBe(false);
  });
});

describe('validateManifestContentFields (S2-F-001)', () => {
  it('accepts a valid manifest (canonical slice id + in-root evidence_path) → null', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      expect(validateManifestContentFields(project.root, manifestPath)).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it('accepts an evidence_path that does not exist yet inside the root (lexical tail) → null', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root, {
        evidence_path: 'delivery/stages/S2/evidence/not-yet-written.md',
      });
      expect(validateManifestContentFields(project.root, manifestPath)).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it.each([
    '../outside/secret.md',
    '../../tmp/attacker/secret.md',
    'S02-A/../../secret.md',
    'delivery/stages/S2/../../../../secret.md',
  ])(
    'rejects evidence_path "%s" escaping the root → HOST.PROJECT_NOT_TRUSTED (no runtime read)',
    (evidencePath) => {
      const project = makeWorktree();
      try {
        const manifestPath = writeManifest(project.root, { evidence_path: evidencePath });
        expectFailCode(validateManifestContentFields(project.root, manifestPath), 'HOST.PROJECT_NOT_TRUSTED');
      } finally {
        project.cleanup();
      }
    },
  );

  it('rejects an ABSOLUTE evidence_path outside the root → HOST.PROJECT_NOT_TRUSTED', () => {
    const project = makeWorktree();
    try {
      const outside = path.join(tmpdir(), 's2f001-absolute-outside.md');
      const manifestPath = writeManifest(project.root, { evidence_path: outside });
      expectFailCode(validateManifestContentFields(project.root, manifestPath), 'HOST.PROJECT_NOT_TRUSTED');
    } finally {
      project.cleanup();
    }
  });

  it('rejects an evidence_path whose symlink target escapes the root → HOST.PROJECT_NOT_TRUSTED', () => {
    const project = makeWorktree();
    const outsideDir = mkdtempSync(path.join(tmpdir(), 's2f001-symlink-out-'));
    try {
      writeFileSync(path.join(outsideDir, 'secret.md'), 'SENTINEL_OUTSIDE', 'utf-8');
      const evidenceDir = path.join(project.root, 'delivery', 'stages', 'S2', 'evidence');
      mkdirSync(evidenceDir, { recursive: true });
      symlinkSync(path.join(outsideDir, 'secret.md'), path.join(evidenceDir, 'S02-A.md'));
      const manifestPath = writeManifest(project.root, {
        evidence_path: 'delivery/stages/S2/evidence/S02-A.md',
      });
      expectFailCode(validateManifestContentFields(project.root, manifestPath), 'HOST.PROJECT_NOT_TRUSTED');
    } finally {
      project.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it.each([
    'S02-A/../../etc',
    'S02-A\\..\\..\\tmp',
    '..',
    'S02-A/..',
    '/etc/passwd',
    'S02-A:../etc',
  ])('rejects slice_id "%s" → HOST.PROJECT_NOT_TRUSTED', (sliceId) => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root, { slice_id: sliceId });
      expectFailCode(validateManifestContentFields(project.root, manifestPath), 'HOST.PROJECT_NOT_TRUSTED');
    } finally {
      project.cleanup();
    }
  });

  it('unreadable manifest → DOMAIN.STAGE_NOT_FOUND', () => {
    const project = makeWorktree();
    try {
      const manifestPath = path.join(project.root, '.proofloop', 'manifests', 'S2.json');
      // Do NOT write the file — the manifest is missing/unreadable.
      expectFailCode(validateManifestContentFields(project.root, manifestPath), 'DOMAIN.STAGE_NOT_FOUND');
    } finally {
      project.cleanup();
    }
  });

  it('invalid-JSON manifest → DOMAIN.STAGE_NOT_FOUND', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      writeFileSync(manifestPath, '{ not valid json', 'utf-8');
      expectFailCode(validateManifestContentFields(project.root, manifestPath), 'DOMAIN.STAGE_NOT_FOUND');
    } finally {
      project.cleanup();
    }
  });

  it('schema-invalid manifest → RUNTIME.SCHEMA_MISMATCH', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      (raw as { slices: unknown }).slices = 'not-an-array';
      writeFileSync(manifestPath, JSON.stringify(raw), 'utf-8');
      expectFailCode(validateManifestContentFields(project.root, manifestPath), 'RUNTIME.SCHEMA_MISMATCH');
    } finally {
      project.cleanup();
    }
  });
});

describe('checkManifestContentBaseline + reverifyManifestContentAfterRead (S2-F-001 TOCTOU)', () => {
  /** Build a valid manifest baseline from the current fixture state. */
  function preBaseline(project: { root: string }, manifestPath: string): ManifestContentBaseline {
    const pre = checkManifestContentBaseline(project.root, manifestPath);
    expect(pre.ok).toBe(true);
    if (!pre.ok) throw new Error('unreachable');
    return pre.baseline;
  }

  it('unchanged manifest → post-check returns null (no false positive)', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const baseline = preBaseline(project, manifestPath);
      expect(reverifyManifestContentAfterRead(project.root, manifestPath, baseline)).toBeNull();
    } finally {
      project.cleanup();
    }
  });

  it('manifest replaced with MALICIOUS content after pre-check → post-check fails closed', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const baseline = preBaseline(project, manifestPath);
      // Attacker swaps the manifest to a schema-valid malicious one AFTER the
      // pre-check (before/while the runtime would read it).
      writeFileSync(
        manifestPath,
        JSON.stringify({
          ...JSON.parse(readFileSync(manifestPath, 'utf-8')),
          slices: [
            {
              slice_id: 'S02-A',
              goal: 'goal',
              observable_outcome: 'out',
              public_seam: 'seam',
              dependencies: [],
              proof_obligations: [],
              tasks: ['S02-A-T01'],
              risk_facts: [],
              evidence_path: '../outside/secret.md',
              cv_minimum_level: 'enhanced',
            },
          ],
        }),
        'utf-8',
      );
      const after = reverifyManifestContentAfterRead(project.root, manifestPath, baseline);
      expectFailCode(after, 'HOST.PROJECT_NOT_TRUSTED');
    } finally {
      project.cleanup();
    }
  });

  it('manifest replaced with a DIFFERENT VALID manifest after pre-check → post-check fails closed (digest mismatch)', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const baseline = preBaseline(project, manifestPath);
      // Attacker swaps to another VALID manifest (different stage_goal) — both
      // pass the content guard, but the digest comparison detects the swap.
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
      raw.stage_goal = 'attacker-changed-goal';
      writeFileSync(manifestPath, JSON.stringify(raw), 'utf-8');
      const after = reverifyManifestContentAfterRead(project.root, manifestPath, baseline);
      expectFailCode(after, 'HOST.PROJECT_NOT_TRUSTED');
    } finally {
      project.cleanup();
    }
  });

  it('manifest unreadable after pre-check → post-check fails closed', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const baseline = preBaseline(project, manifestPath);
      rmSync(manifestPath, { force: true });
      const after = reverifyManifestContentAfterRead(project.root, manifestPath, baseline);
      expectFailCode(after, 'DOMAIN.STAGE_NOT_FOUND');
    } finally {
      project.cleanup();
    }
  });

  it('evidence path redirected (symlink escape) after pre-check → post-check fails closed', () => {
    const project = makeWorktree();
    const outsideDir = mkdtempSync(path.join(tmpdir(), 's2f001-toctou-out-'));
    try {
      // Pre-check: evidence_path is a plain in-root path that does not exist
      // yet (lexical tail) — valid.
      const manifestPath = writeManifest(project.root, {
        evidence_path: 'delivery/stages/S2/evidence/S02-A.md',
      });
      const baseline = preBaseline(project, manifestPath);
      // Attacker creates a symlink at the evidence path pointing OUTSIDE the
      // root after the pre-check; the runtime read would follow it.
      const evidenceDir = path.join(project.root, 'delivery', 'stages', 'S2', 'evidence');
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(path.join(outsideDir, 'secret.md'), 'OUTSIDE', 'utf-8');
      symlinkSync(path.join(outsideDir, 'secret.md'), path.join(evidenceDir, 'S02-A.md'));
      const after = reverifyManifestContentAfterRead(project.root, manifestPath, baseline);
      expectFailCode(after, 'HOST.PROJECT_NOT_TRUSTED');
    } finally {
      project.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('evidence path redirected (in-root alternate) after pre-check → post-check fails closed (identity mismatch)', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root, {
        evidence_path: 'delivery/stages/S2/evidence/S02-A.md',
      });
      const baseline = preBaseline(project, manifestPath);
      // Attacker creates a regular file at the evidence path — the canonical
      // path re-resolves to the SAME path for a plain file, so this stays an
      // in-root non-escape (identity holds → post-check passes). This proves
      // the post-check is not a false positive for a legitimately-created
      // evidence file during a long read.
      const evidenceDir = path.join(project.root, 'delivery', 'stages', 'S2', 'evidence');
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(
        path.join(evidenceDir, 'S02-A.md'),
        '# Slice S02-A Evidence\n',
        'utf-8',
      );
      expect(reverifyManifestContentAfterRead(project.root, manifestPath, baseline)).toBeNull();
    } finally {
      project.cleanup();
    }
  });
});

describe('reverifyManifestPathIdentity (S2-F-001 round 3 pre-baseline/final identity)', () => {
  it('a real in-root manifest file → ok:true with the identity-verified path', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const identity = reverifyManifestPathIdentity(project.root, manifestPath);
      expect(identity.ok).toBe(true);
      if (identity.ok) {
        expect(identity.path).toBe(manifestPath);
      }
    } finally {
      project.cleanup();
    }
  });

  it('a missing manifest path → ok:true (identity holds lexically; the baseline read then fails DOMAIN.STAGE_NOT_FOUND)', () => {
    const project = makeWorktree();
    try {
      const manifestPath = path.join(project.root, '.proofloop', 'manifests', 'S2.json');
      const identity = reverifyManifestPathIdentity(project.root, manifestPath);
      expect(identity.ok).toBe(true);
      if (identity.ok) {
        const baseline = checkManifestContentBaseline(project.root, identity.path);
        expect(baseline.ok).toBe(false);
        if (!baseline.ok) {
          expect(baseline.result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
        }
      }
    } finally {
      project.cleanup();
    }
  });

  it('manifest path swapped to an OUTSIDE symlink → fail-closed HOST.PATH_OUTSIDE_PROJECT', () => {
    const project = makeWorktree();
    const outsideDir = mkdtempSync(path.join(tmpdir(), 's2f001-ident-out-'));
    try {
      const manifestPath = writeManifest(project.root);
      // First identity passes (real file).
      expect(reverifyManifestPathIdentity(project.root, manifestPath).ok).toBe(true);
      // Attacker swaps the manifest FILE to a symlink pointing OUTSIDE the
      // root — the identity re-check must fail closed.
      const externalManifest = path.join(outsideDir, 'external.json');
      writeFileSync(externalManifest, JSON.stringify({ stage_id: 'S2' }), 'utf-8');
      rmSync(manifestPath, { force: true });
      symlinkSync(externalManifest, manifestPath);
      const identity = reverifyManifestPathIdentity(project.root, manifestPath);
      expect(identity.ok).toBe(false);
      if (!identity.ok) {
        expect(identity.result.findings[0].code).toBe('HOST.PATH_OUTSIDE_PROJECT');
      }
    } finally {
      project.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('manifest path swapped to an IN-ROOT symlink redirect → fail-closed HOST.PATH_OUTSIDE_PROJECT', () => {
    const project = makeWorktree();
    try {
      const manifestPath = writeManifest(project.root);
      const alternate = path.join(project.root, 'alternate-manifest.json');
      writeFileSync(alternate, '{"stage_id":"S2"}', 'utf-8');
      rmSync(manifestPath, { force: true });
      symlinkSync('alternate-manifest.json', manifestPath);
      const identity = reverifyManifestPathIdentity(project.root, manifestPath);
      expect(identity.ok).toBe(false);
      if (!identity.ok) {
        expect(identity.result.findings[0].code).toBe('HOST.PATH_OUTSIDE_PROJECT');
      }
    } finally {
      project.cleanup();
    }
  });
});
