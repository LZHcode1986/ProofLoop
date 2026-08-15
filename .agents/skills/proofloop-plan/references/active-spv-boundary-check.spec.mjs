/**
 * Spec for the read-only SPV boundary-check helper
 * (active-spv-boundary-check.mjs).
 *
 * Pure mechanical branches only:
 *   - closed argument parsing (unknown/missing/duplicate/invalid);
 *   - root-bound Manifest path resolution incl. symlink escape;
 *   - kernel `computeDigest` loading and digest projection verification with
 *     the REAL @proofloop/kernel computeDigest;
 *   - git boundary checks and a full CLI run inside a disposable temp repo.
 *
 * The tests never depend on this worktree being clean, never write into the
 * repository and use system temp dirs (cleaned up after each run).
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseArgs,
  resolveRootBoundPath,
  loadKernelComputeDigest,
  verifyDigestProjections,
  verifyGitBoundary,
} from './active-spv-boundary-check.mjs';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const SPEC_DIR = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(SPEC_DIR, '..', '..', '..', '..');
const REAL_KERNEL_DIST = path.join(REPO_ROOT, 'packages', 'kernel', 'dist', 'index.js');

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

const tempDirs = [];
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
after(cleanupTempDirs);

/** A minimal but structurally faithful vNext Manifest fixture. */
function makeManifestFixture({ proofDigest = null } = {}) {
  const referenceIndex = {
    'REF-TEST-GOAL': { kind: 'goal', ref: 'delivery/stages/T/tasks.md#/entities/T-goal', file_digest: 'a'.repeat(64), section_digest: 'b'.repeat(64) },
    'REF-TEST-ACCEPTANCE': { kind: 'acceptance', ref: 'delivery/stages/T/tasks.md#/entities/T-A-ACCEPTANCE', file_digest: 'a'.repeat(64), section_digest: 'b'.repeat(64) },
    'REF-TEST-PROOF': { kind: 'proof_spec', ref: 'delivery/stages/T/tasks.md#/entities/T-RUNTIME-PROOF', file_digest: 'a'.repeat(64), section_digest: 'b'.repeat(64) },
  };
  const slices = [
    {
      slice_id: 'T-A',
      proof_index: {
        slice_id: 'T-A',
        goal_ref: 'REF-TEST-GOAL',
        task_refs: ['REF-TEST-T01'],
        acceptance_refs: ['REF-TEST-ACCEPTANCE'],
        seam_refs: [],
        oracle_refs: [],
        risk_refs: [],
      },
      required_skills: [],
      depends_on: [],
      evidence_path: 'delivery/stages/T/evidence/T-A.md',
    },
  ];
  const manifest = {
    version: 2,
    stage_id: 'T',
    plan: { ref: 'delivery/stages/T/tasks.md', plan_digest: 'c'.repeat(64), schema_version: 2 },
    reference_index: referenceIndex,
    authority_ref_ids: ['REF-TEST-GOAL'],
    task_scopes: {},
    slices,
  };
  return manifest;
}

function computeDigestOf(value) {
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  assert.equal(kernel.ok, true, 'real kernel dist must be available for the spec');
  return kernel.computeDigest(value);
}

function expectedDigestsFor(manifest) {
  return {
    manifestDigest: computeDigestOf(manifest),
    planDigest: manifest.plan.plan_digest,
    referenceIndexDigest: computeDigestOf(manifest.reference_index),
    proofIndexDigest: computeDigestOf(manifest.slices.map((slice) => slice.proof_index)),
  };
}

function validArgv({ root, manifest = '.proofloop/manifests/T.json', snapshot = '1'.repeat(40), digests = null } = {}) {
  const expected = digests ?? expectedDigestsFor(makeManifestFixture());
  return {
    argv: [
      '--project-root', root,
      '--manifest', manifest,
      '--snapshot', snapshot,
      '--plan-digest', expected.planDigest,
      '--manifest-digest', expected.manifestDigest,
      '--reference-index-digest', expected.referenceIndexDigest,
      '--proof-index-digest', expected.proofIndexDigest,
    ],
    expected,
  };
}

/** Create a disposable git repo (init + config + base commit). */
function makeGitRepo({ withIgnore = true } = {}) {
  const root = makeTempDir('spv-boundary-check-repo-');
  const run = (args) => {
    const result = spawnSync('git', args, { cwd: root, shell: false, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return String(result.stdout ?? '').trim();
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'spv-spec@example.com']);
  run(['config', 'user.name', 'SPV Spec']);
  if (withIgnore) {
    fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\npackages/kernel/dist/\n');
  }
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  run(['add', '.gitignore', 'base.txt']);
  run(['commit', '-q', '-m', 'base']);
  return { root, head: run(['rev-parse', 'HEAD']) };
}

function writeManifest(root, manifest, relative = '.proofloop/manifests/T.json') {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(manifest, null, 2)}\n`);
  return absolute;
}

function copyKernelDist(root) {
  const target = path.join(root, 'packages', 'kernel', 'dist');
  fs.cpSync(REAL_KERNEL_DIST.replace(/index\.js$/, ''), target, { recursive: true });
  assert.ok(fs.existsSync(path.join(target, 'index.js')), 'kernel dist copy must exist');
  return path.join(target, 'index.js');
}

// ---------------------------------------------------------------------------
// Closed argument parser
// ---------------------------------------------------------------------------

test('parseArgs accepts a full valid argument set', () => {
  const { root } = makeGitRepo();
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  const parsed = parseArgs(validArgv({ root, digests: expected }).argv);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.args.projectRoot, root);
  assert.equal(parsed.args.manifest, '.proofloop/manifests/T.json');
  assert.equal(parsed.args.snapshot, '1'.repeat(40));
  assert.equal(parsed.args.manifestDigest, expected.manifestDigest);
});

test('parseArgs rejects an unknown flag', () => {
  const parsed = parseArgs(['--project-root', '/tmp', '--bogus', 'x']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_UNKNOWN');
});

test('parseArgs rejects a positional (non-flag) argument', () => {
  const parsed = parseArgs(['--project-root', '/tmp', 'stray']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_UNKNOWN');
});

test('parseArgs rejects a missing required flag', () => {
  const parsed = parseArgs(['--project-root', '/tmp', '--manifest', 'x.json']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_MISSING');
});

test('parseArgs rejects a duplicate flag', () => {
  const parsed = parseArgs([
    '--project-root', '/tmp', '--project-root', '/tmp',
    '--manifest', 'x.json', '--snapshot', 'a'.repeat(40),
    '--plan-digest', 'b'.repeat(64), '--manifest-digest', 'b'.repeat(64),
    '--reference-index-digest', 'b'.repeat(64), '--proof-index-digest', 'b'.repeat(64),
    '--runtime-proof-digest', 'b'.repeat(64),
  ]);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_DUPLICATE');
});

test('parseArgs rejects a relative project root', () => {
  const parsed = parseArgs([
    '--project-root', 'relative/root',
    '--manifest', 'x.json', '--snapshot', 'a'.repeat(40),
    '--plan-digest', 'b'.repeat(64), '--manifest-digest', 'b'.repeat(64),
    '--reference-index-digest', 'b'.repeat(64), '--proof-index-digest', 'b'.repeat(64),
    '--runtime-proof-digest', 'b'.repeat(64),
  ]);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_INVALID');
  assert.match(parsed.error.message, /absolute/);
});

test('parseArgs rejects a non-hex / wrong-length / uppercase snapshot', () => {
  const base = [
    '--project-root', '/tmp',
    '--manifest', 'x.json',
    '--plan-digest', 'b'.repeat(64), '--manifest-digest', 'b'.repeat(64),
    '--reference-index-digest', 'b'.repeat(64), '--proof-index-digest', 'b'.repeat(64),
    '--runtime-proof-digest', 'b'.repeat(64),
  ];
  for (const snapshot of ['not-hex', 'abcd', '1'.repeat(41), 'A'.repeat(40), 'ABCDEF0123'.repeat(4)]) {
    const parsed = parseArgs(['--snapshot', snapshot, ...base]);
    assert.equal(parsed.ok, false, `snapshot "${snapshot}" must be rejected`);
    assert.equal(parsed.error.code, 'ARG_INVALID');
  }
});

test('parseArgs rejects a non-hex digest', () => {
  const argv = validArgv({ root: '/tmp' }).argv;
  const flagIndex = argv.indexOf('--manifest-digest');
  argv[flagIndex + 1] = 'xyz';
  const parsed = parseArgs(argv);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_INVALID');
  assert.match(parsed.error.message, /64-hex/);
});

test('parseArgs rejects an absolute manifest path', () => {
  const argv = validArgv({ root: '/tmp' }).argv;
  const flagIndex = argv.indexOf('--manifest');
  argv[flagIndex + 1] = '/etc/passwd';
  const parsed = parseArgs(argv);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_INVALID');
});

test('parseArgs rejects a flag at the end without a value', () => {
  const parsed = parseArgs(['--project-root']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'ARG_INVALID');
});

// ---------------------------------------------------------------------------
// Root-bound Manifest path resolution
// ---------------------------------------------------------------------------

test('resolveRootBoundPath accepts a manifest inside the root', () => {
  const root = makeTempDir('spv-boundary-check-root-');
  const manifest = path.join(root, 'manifests', 'T.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, '{}');
  const bound = resolveRootBoundPath(root, 'manifests/T.json');
  assert.equal(bound.ok, true);
  assert.equal(bound.absolute, manifest);
});

test('resolveRootBoundPath rejects a path escaping the root', () => {
  const root = makeTempDir('spv-boundary-check-root-');
  const outside = path.join(os.tmpdir(), `spv-boundary-outside-${process.pid}.json`);
  fs.writeFileSync(outside, '{}');
  try {
    const bound = resolveRootBoundPath(root, `manifests/../../${path.basename(outside)}`);
    assert.equal(bound.ok, false);
    assert.equal(bound.error.code, 'PATH_OUTSIDE_ROOT');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('resolveRootBoundPath rejects a missing manifest', () => {
  const root = makeTempDir('spv-boundary-check-root-');
  const bound = resolveRootBoundPath(root, 'manifests/absent.json');
  assert.equal(bound.ok, false);
  assert.equal(bound.error.code, 'PATH_ABSENT');
});

test('resolveRootBoundPath rejects a symlink escaping the root', () => {
  const root = makeTempDir('spv-boundary-check-root-');
  const outside = path.join(os.tmpdir(), `spv-boundary-target-${process.pid}.json`);
  fs.writeFileSync(outside, '{}');
  try {
    const link = path.join(root, 'escape.json');
    fs.symlinkSync(outside, link);
    const bound = resolveRootBoundPath(root, 'escape.json');
    assert.equal(bound.ok, false);
    assert.equal(bound.error.code, 'PATH_ESCAPE');
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('resolveRootBoundPath rejects an in-root symlink identity change', () => {
  const root = makeTempDir('spv-boundary-check-root-');
  fs.mkdirSync(path.join(root, 'manifests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifests', 'real.json'), '{}');
  fs.symlinkSync(path.join(root, 'manifests', 'real.json'), path.join(root, 'manifests', 'link.json'));
  const bound = resolveRootBoundPath(root, 'manifests/link.json');
  assert.equal(bound.ok, false);
  assert.equal(bound.error.code, 'PATH_ESCAPE');
});

test('resolveRootBoundPath rejects an absolute manifest argument', () => {
  const root = makeTempDir('spv-boundary-check-root-');
  const bound = resolveRootBoundPath(root, '/etc/passwd');
  assert.equal(bound.ok, false);
  assert.equal(bound.error.code, 'PATH_NOT_RELATIVE');
});

// ---------------------------------------------------------------------------
// Kernel computeDigest loading
// ---------------------------------------------------------------------------

test('loadKernelComputeDigest loads the real kernel computeDigest', () => {
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  assert.equal(kernel.ok, true);
  assert.equal(typeof kernel.computeDigest, 'function');
  assert.match(kernel.computeDigest({ a: 1 }), SHA256_HEX_RE);
});

test('loadKernelComputeDigest fails closed on a missing module', () => {
  const kernel = loadKernelComputeDigest('/nonexistent/kernel/dist/index.js');
  assert.equal(kernel.ok, false);
  assert.equal(kernel.error.code, 'KERNEL_MISSING');
});

test('loadKernelComputeDigest fails closed when computeDigest is not exported', () => {
  const dir = makeTempDir('spv-boundary-check-kernel-');
  const index = path.join(dir, 'index.js');
  fs.writeFileSync(index, 'module.exports = { sha256Hex: () => "x" };\n');
  const kernel = loadKernelComputeDigest(index);
  assert.equal(kernel.ok, false);
  assert.equal(kernel.error.code, 'KERNEL_NO_EXPORT');
});

test('loadKernelComputeDigest fails closed on a module load error', () => {
  const dir = makeTempDir('spv-boundary-check-kernel-');
  const index = path.join(dir, 'index.js');
  fs.writeFileSync(index, 'throw new Error("boom");\n');
  const kernel = loadKernelComputeDigest(index);
  assert.equal(kernel.ok, false);
  assert.equal(kernel.error.code, 'KERNEL_LOAD_FAILED');
});

// ---------------------------------------------------------------------------
// Digest projection verification (real kernel computeDigest)
// ---------------------------------------------------------------------------

test('verifyDigestProjections accepts a fully consistent Manifest', () => {
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  const verification = verifyDigestProjections(manifest, expected, kernel.computeDigest);
  assert.equal(verification.ok, true);
  assert.equal(verification.digests.manifest_digest, expected.manifestDigest);
  assert.equal(verification.digests.plan_digest, expected.planDigest);
  assert.equal(verification.digests.reference_index_digest, expected.referenceIndexDigest);
  assert.equal(verification.digests.proof_index_digest, expected.proofIndexDigest);
});

test('verifyDigestProjections rejects a wrong manifest digest', () => {
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  const verification = verifyDigestProjections(manifest, { ...expected, manifestDigest: 'd'.repeat(64) }, kernel.computeDigest);
  assert.equal(verification.ok, false);
  assert.equal(verification.mismatches[0].field, 'manifest_digest');
});

test('verifyDigestProjections rejects a wrong plan digest', () => {
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  const verification = verifyDigestProjections(manifest, { ...expected, planDigest: 'e'.repeat(64) }, kernel.computeDigest);
  assert.equal(verification.ok, false);
  assert.equal(verification.mismatches[0].field, 'plan_digest');
});

test('verifyDigestProjections rejects a wrong reference index digest', () => {
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  const verification = verifyDigestProjections(manifest, { ...expected, referenceIndexDigest: 'f'.repeat(64) }, kernel.computeDigest);
  assert.equal(verification.ok, false);
  assert.equal(verification.mismatches[0].field, 'reference_index_digest');
});

test('verifyDigestProjections rejects a wrong proof index digest', () => {
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  const verification = verifyDigestProjections(manifest, { ...expected, proofIndexDigest: '1'.repeat(64) }, kernel.computeDigest);
  assert.equal(verification.ok, false);
  assert.equal(verification.mismatches[0].field, 'proof_index_digest');
});

test('verifyDigestProjections fails closed on missing structural sections', () => {
  const kernel = loadKernelComputeDigest(REAL_KERNEL_DIST);
  const manifest = makeManifestFixture();
  const base = expectedDigestsFor(manifest);

  const noSlices = { ...manifest, slices: undefined };
  const v1 = verifyDigestProjections(noSlices, { ...base, manifestDigest: computeDigestOf(noSlices) }, kernel.computeDigest);
  assert.equal(v1.ok, false);
  assert.equal(v1.mismatches[0].field, 'proof_index_digest');

  const noRefIndex = { ...manifest, reference_index: undefined };
  const v2 = verifyDigestProjections(noRefIndex, { ...base, manifestDigest: computeDigestOf(noRefIndex) }, kernel.computeDigest);
  assert.equal(v2.ok, false);
  assert.equal(v2.mismatches[0].field, 'reference_index_digest');

  const noPlan = { ...manifest, plan: undefined };
  const v3 = verifyDigestProjections(noPlan, { ...base, manifestDigest: computeDigestOf(noPlan) }, kernel.computeDigest);
  assert.equal(v3.ok, false);
  assert.equal(v3.mismatches[0].field, 'plan_digest');
});

// ---------------------------------------------------------------------------
// Git boundary verification (disposable temp repos)
// ---------------------------------------------------------------------------

test('verifyGitBoundary accepts a clean temp repo with matching HEAD', () => {
  const { root, head } = makeGitRepo();
  const boundary = verifyGitBoundary(root, head);
  assert.equal(boundary.ok, true);
  assert.equal(boundary.head, head);
});

test('verifyGitBoundary rejects a dirty worktree', () => {
  const { root, head } = makeGitRepo();
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'dirty\n');
  const boundary = verifyGitBoundary(root, head);
  assert.equal(boundary.ok, false);
  assert.equal(boundary.error.code, 'GIT_DIRTY');
});

test('verifyGitBoundary rejects a snapshot that does not equal HEAD', () => {
  const { root } = makeGitRepo();
  const boundary = verifyGitBoundary(root, 'a'.repeat(40));
  assert.equal(boundary.ok, false);
  assert.equal(boundary.error.code, 'SNAPSHOT_MISMATCH');
});

test('verifyGitBoundary rejects a non-git directory', () => {
  const root = makeTempDir('spv-boundary-check-nogit-');
  const boundary = verifyGitBoundary(root, 'a'.repeat(40));
  assert.equal(boundary.ok, false);
  assert.equal(boundary.error.code, 'GIT_TOPLEVEL_FAILED');
});

// ---------------------------------------------------------------------------
// End-to-end CLI (disposable temp repo + real kernel dist copy)
// ---------------------------------------------------------------------------

function runCli(root, argv, extra = {}) {
  const helper = path.join(SPEC_DIR, 'active-spv-boundary-check.mjs');
  return spawnSync(process.execPath, [helper, ...argv], {
    cwd: root,
    shell: false,
    encoding: 'utf8',
    ...extra,
  });
}

test('CLI verifies a consistent boundary in a temp repo (exit 0, closed JSON)', () => {
  const { root, head } = makeGitRepo();
  copyKernelDist(root);
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  writeManifest(root, manifest);

  const result = runCli(root, validArgv({ root, snapshot: head, digests: expected }).argv);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.valid, true);
  assert.equal(output.clean, true);
  assert.equal(output.project_root, fs.realpathSync(root));
  assert.equal(output.head, head);
  assert.match(output.manifest_path, /manifests\/T\.json$/);
  assert.equal(output.digests.manifest_digest, expected.manifestDigest);
});

test('CLI fails closed on a tampered digest (exit 1, stderr JSON)', () => {
  const { root, head } = makeGitRepo();
  copyKernelDist(root);
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  writeManifest(root, manifest);

  const result = runCli(root, validArgv({ root, snapshot: head, digests: { ...expected, proofIndexDigest: '9'.repeat(64) } }).argv);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.valid, false);
  assert.equal(error.error.code, 'DIGEST_MISMATCH');
  assert.equal(error.error.mismatches[0].field, 'proof_index_digest');
});

test('CLI fails closed on a snapshot/HEAD mismatch (exit 1)', () => {
  const { root } = makeGitRepo();
  copyKernelDist(root);
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  writeManifest(root, manifest);

  const result = runCli(root, validArgv({ root, snapshot: 'a'.repeat(40), digests: expected }).argv);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.error.code, 'SNAPSHOT_MISMATCH');
});

test('CLI fails closed on a dirty worktree (exit 1)', () => {
  const { root, head } = makeGitRepo();
  copyKernelDist(root);
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  writeManifest(root, manifest);
  fs.writeFileSync(path.join(root, 'dirty.txt'), 'dirty\n');

  const result = runCli(root, validArgv({ root, snapshot: head, digests: expected }).argv);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.error.code, 'GIT_DIRTY');
});

test('CLI fails closed on usage errors (exit 2)', () => {
  const { root } = makeGitRepo();
  const argv = validArgv({ root }).argv;
  const result = runCli(root, [...argv.slice(0, 2), '--bogus', 'x', ...argv.slice(2)]);
  assert.equal(result.status, 2);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.error.code, 'ARG_UNKNOWN');
});

test('CLI fails closed when the kernel dist is missing (exit 1)', () => {
  const { root, head } = makeGitRepo();
  const manifest = makeManifestFixture();
  const expected = expectedDigestsFor(manifest);
  writeManifest(root, manifest);

  const result = runCli(root, validArgv({ root, snapshot: head, digests: expected }).argv);
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr.trim());
  assert.equal(error.error.code, 'KERNEL_MISSING');
});
