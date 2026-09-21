/**
 * PO-S09-A-01: the shared canonical project/trust-root observation seam
 * (`packages/runtime/test/fixtures/e2e25.ts`) resolves the canonical root from
 * an EXPLICIT base directory (default = the seam's own module directory) and
 * always yields the primary worktree that owns the repository common `.git`
 * directory — never the base directory, never `process.cwd()` and never a
 * linked worktree's own root.
 *
 * Observations are read-only and root-bound: an unobservable artifact, a failed
 * Git resolution, an empty common directory or a root-relative value that
 * escapes the canonical root all raise the existing typed observation error —
 * never a silent skip and never a fallback to a worktree-local copy.
 *
 * PO: PO-S09-A-01. Every mutation happens in an isolated temp Git fixture; the
 * real `.proofloop/**` is only ever observed (never a mutation target).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeFixture, commitAll } from './helpers';
import {
  CanonicalProjectMesObservationError,
  observeCanonicalProjectArtifact,
  resolveCanonicalProjectRoot,
  sha256OfBytes,
} from './fixtures/e2e25';

/** A root-relative capture directory used as the observed artifact location. */
const CAPTURE_REL = '.proofloop/forensics/mes-recovery-20260910';
const ARTIFACT_REL = `${CAPTURE_REL}/snapshot-67.json`;

interface LinkedFixture {
  readonly primary: ReturnType<typeof makeFixture>;
  /** A LINKED worktree of the primary repository (its own local root). */
  readonly linked: string;
  /** A base dir nested inside the linked worktree (mirrors the real test-dist layout). */
  readonly nestedBase: string;
}

/**
 * Primary temp Git repository plus one linked worktree of the SAME repository,
 * so the canonical root (primary worktree) and a worktree-local root are two
 * distinct directories on disk.
 */
function makeLinkedWorktreeFixture(): LinkedFixture {
  const primary = makeFixture();
  primary.write('seed.txt', 'seed\n');
  commitAll(primary, 'seed');
  const linked = path.join(primary.dir, '.proofloop', 'worktrees', 'decoy-linked');
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  primary.run(['worktree', 'add', '--detach', linked]);
  const nestedBase = path.join(linked, 'packages', 'runtime', 'test-dist');
  fs.mkdirSync(nestedBase, { recursive: true });
  return { primary, linked, nestedBase };
}

function writeArtifact(root: string, relative: string, bytes: Buffer): string {
  const abs = path.join(root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return abs;
}

/** The typed, visible fail-closed observation error (never ENOENT, never a skip). */
function typedObservationError(error: unknown): boolean {
  return error instanceof CanonicalProjectMesObservationError;
}

test('resolves the primary worktree root from a linked-worktree base', () => {
  const { primary, linked, nestedBase } = makeLinkedWorktreeFixture();
  try {
    // Independent truth: `primary.dir` is the worktree we created, and `linked`
    // is a DIFFERENT worktree of the same repository. Any base inside the
    // linked worktree must resolve to the primary worktree root.
    assert.notEqual(linked, primary.dir);
    assert.equal(resolveCanonicalProjectRoot(linked), primary.dir);
    assert.equal(resolveCanonicalProjectRoot(nestedBase), primary.dir);
    assert.equal(resolveCanonicalProjectRoot(`${linked}/`), primary.dir);
    assert.equal(resolveCanonicalProjectRoot(linked), resolveCanonicalProjectRoot(nestedBase));

    // The default base dir is the seam's own module directory: from the real
    // Slice worktree that still resolves to the repository owning the common
    // `.git` directory, i.e. to the root that actually carries the canonical
    // forensic captures (the Slice worktree itself carries none).
    const canonicalRoot = resolveCanonicalProjectRoot();
    assert.equal(resolveCanonicalProjectRoot(__dirname), canonicalRoot);
    assert.equal(fs.statSync(path.join(canonicalRoot, '.git')).isDirectory(), true);
    assert.throws(() => observeCanonicalProjectArtifact(ARTIFACT_REL), typedObservationError);
  } finally {
    primary.cleanup();
  }
});

test('observes only the canonical copy when a worktree-local decoy exists', () => {
  const { primary, linked, nestedBase } = makeLinkedWorktreeFixture();
  try {
    const canonicalBytes = Buffer.from('{"capture":"canonical"}\n', 'utf8');
    const decoyBytes = Buffer.from('{"capture":"worktree-local-decoy"}\n', 'utf8');
    const canonicalAbs = writeArtifact(primary.dir, ARTIFACT_REL, canonicalBytes);
    const decoyAbs = writeArtifact(linked, ARTIFACT_REL, decoyBytes);

    const observed = observeCanonicalProjectArtifact(ARTIFACT_REL, nestedBase);

    assert.equal(observed.root, primary.dir, 'observation resolves the primary worktree root');
    assert.equal(observed.path, canonicalAbs, 'observation path is the canonical copy');
    assert.equal(observed.sha256, sha256OfBytes(canonicalBytes), 'observed bytes are the canonical bytes');
    assert.deepEqual(observed.bytes, canonicalBytes);
    assert.ok(!observed.path.startsWith(`${linked}${path.sep}`), 'the observation never points into the linked worktree');

    // The decoy genuinely diverges and is never returned; it stays untouched.
    assert.notEqual(observed.sha256, sha256OfBytes(decoyBytes));
    assert.deepEqual(fs.readFileSync(decoyAbs), decoyBytes, 'the worktree-local decoy is never a mutation target');
  } finally {
    primary.cleanup();
  }
});

test('fails closed typed when the canonical artifact is unobservable', () => {
  const { primary, linked, nestedBase } = makeLinkedWorktreeFixture();
  const noGit = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-nogit-'));
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-empty-common-'));
  const savedPath = process.env.PATH;
  try {
    // A worktree-local copy alone is NOT an observation source: the canonical
    // artifact is missing, so the observation fails closed typed and never
    // silently falls back to the decoy.
    const decoyAbs = writeArtifact(linked, ARTIFACT_REL, Buffer.from('{"capture":"decoy"}\n', 'utf8'));
    assert.equal(fs.existsSync(path.join(primary.dir, ARTIFACT_REL)), false);
    assert.throws(() => observeCanonicalProjectArtifact(ARTIFACT_REL, nestedBase), typedObservationError);
    assert.equal(fs.existsSync(decoyAbs), true, 'the fail-closed observation leaves the decoy where it was');

    // Git resolution failure (base dir outside any repository) is typed too.
    assert.throws(() => resolveCanonicalProjectRoot(noGit), typedObservationError);
    assert.throws(() => observeCanonicalProjectArtifact(ARTIFACT_REL, noGit), typedObservationError);

    // An EMPTY common directory is a typed failure as well — the empty answer
    // is never used as (or silently turned into) a root.
    fs.writeFileSync(path.join(shimDir, 'git'), '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(path.join(shimDir, 'git'), 0o755);
    process.env.PATH = `${shimDir}${path.delimiter}${savedPath ?? ''}`;
    assert.throws(() => resolveCanonicalProjectRoot(primary.dir), typedObservationError);
    assert.throws(() => observeCanonicalProjectArtifact(ARTIFACT_REL, primary.dir), typedObservationError);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(noGit, { recursive: true, force: true });
    primary.cleanup();
  }
});

test('never resolves outside the canonical root', () => {
  const { primary, linked, nestedBase } = makeLinkedWorktreeFixture();
  const escapeDir = `${primary.dir}-escape`;
  try {
    fs.mkdirSync(escapeDir, { recursive: true });
    const escapeAbs = path.join(escapeDir, 'outside.json');
    fs.writeFileSync(escapeAbs, '{"outside":true}\n', 'utf8');

    // The escaping targets EXIST, so the typed failure is the root bound — not
    // a missing artifact and not a silent miss.
    assert.equal(fs.existsSync(escapeAbs), true);
    const escapingRel = path.relative(primary.dir, escapeAbs);
    assert.throws(() => observeCanonicalProjectArtifact(escapingRel, nestedBase), typedObservationError);
    assert.throws(() => observeCanonicalProjectArtifact(`.proofloop/../../../${path.basename(escapeAbs)}`, nestedBase), typedObservationError);
    assert.throws(() => observeCanonicalProjectArtifact(escapeAbs, nestedBase), typedObservationError, 'an absolute path is never root-relative');
    assert.throws(() => observeCanonicalProjectArtifact('', nestedBase), typedObservationError);
    assert.throws(() => resolveCanonicalProjectRoot(''), typedObservationError);
  } finally {
    fs.rmSync(escapeDir, { recursive: true, force: true });
    primary.cleanup();
  }
});

test('never observes bytes through a symlink that escapes the canonical root', () => {
  const { primary, linked, nestedBase } = makeLinkedWorktreeFixture();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-outside-'));
  try {
    // The LEXICAL path is inside the canonical root, but an intermediate path
    // component is a symlink pointing OUTSIDE it — so the bytes physically
    // live outside the root and must never be observed.
    const outsideFile = path.join(outsideDir, 'artifact.json');
    fs.writeFileSync(outsideFile, '{"capture":"outside"}\n', 'utf8');
    const linkedDirInside = path.join(primary.dir, CAPTURE_REL, 'linked-dir');
    fs.mkdirSync(path.dirname(linkedDirInside), { recursive: true });
    fs.symlinkSync(outsideDir, linkedDirInside, 'dir');
    const escapingDirRel = `${CAPTURE_REL}/linked-dir/artifact.json`;
    assert.equal(fs.existsSync(path.join(primary.dir, escapingDirRel)), true, 'the lexical path exists inside the root');
    assert.throws(() => observeCanonicalProjectArtifact(escapingDirRel, nestedBase), typedObservationError);

    // A symlinked FILE escaping the root is rejected the same way.
    const linkedFileInside = path.join(primary.dir, CAPTURE_REL, 'linked-file.json');
    fs.symlinkSync(outsideFile, linkedFileInside, 'file');
    assert.throws(() => observeCanonicalProjectArtifact(`${CAPTURE_REL}/linked-file.json`, nestedBase), typedObservationError);

    // A symlink that resolves INSIDE the canonical root stays a legal
    // root-bound observation (the bound is the real path, not "no symlinks").
    const insideTarget = writeArtifact(primary.dir, `${CAPTURE_REL}/inside-target.json`, Buffer.from('{"capture":"inside"}\n', 'utf8'));
    const insideLink = path.join(primary.dir, CAPTURE_REL, 'inside-link.json');
    fs.symlinkSync(insideTarget, insideLink, 'file');
    const observed = observeCanonicalProjectArtifact(`${CAPTURE_REL}/inside-link.json`, nestedBase);
    assert.deepEqual(observed.bytes, fs.readFileSync(insideTarget));
    assert.ok(!observed.path.startsWith(`${linked}${path.sep}`));
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    primary.cleanup();
  }
});
