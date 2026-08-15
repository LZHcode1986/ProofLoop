/**
 * vNext Stage Close admission — P-11 tests.
 *
 * The Stage Close is the machine-authoritative "Stage is closed" marker for
 * closed/archived Stages (restricted closes such as S10 have no
 * STAGE_REVIEW_PASS and would otherwise stay active forever). This spec
 * exercises `admitVNextStageClose` against real S10 fixture files:
 *
 *   - the happy path admits a close and persists the write-once
 *     STAGE_CLOSE_PASS envelope into `.proofloop/receipts/stage-close/<stage>/`;
 *   - the P-11 bug regression: an ARCHIVED Stage's Manifest is a historical
 *     snapshot bound to the replan-time worktree digests, and the Authority
 *     files evolve afterwards (transition removals, …). The recorded
 *     reference digests then legitimately drift from the current root files
 *     (`REF-AWI-023 file_digest does not match the root bound source`). The
 *     Close admission must NOT revalidate Manifest reference bindings — it
 *     still requires the Manifest to be readable and stage-bound, and the
 *     Stage Plan/SPV authority receipts to bind the tuple;
 *   - every remaining fail-closed guard stays: missing Manifest, missing
 *     authority, snapshot drift, tuple mismatch, write-once, closed request
 *     schema.
 *
 * The fixture mirrors the review-admission fixture pattern: a fresh git repo
 * that copies the real S10 vNext Manifest (and the root-bound reference file
 * needed to reproduce the exact REF-AWI-023 digest drift), commits a clean
 * planning boundary, then writes the Stage Plan/SPV authority receipts into
 * `.proofloop/receipts/plan/S10/` (gitignored, like production).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  computeDigest,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  validateVNextManifest,
} from '@proofloop/kernel';
import type { VNextManifest } from '@proofloop/kernel';
import type { AdmitResult } from '../admit-pipeline';
import { assertVNextManifestReferenceBindings } from './dispatch';
import {
  admitVNextStageClose,
  VNEXT_STAGE_CLOSE_PASS_TYPE,
} from './stage-close-admission';
import type { VNextStageCloseAdmissionState } from './types';

const repo = path.resolve(__dirname, '../../../..');
const STAGE_ID = 'S10';
const FAKE_SHA256 = '0'.repeat(64);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), destination);
}

interface CloseFixture {
  readonly root: string;
  readonly stageId: string;
  readonly manifest: Record<string, any>;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
}

interface PrepareOptions {
  /**
   * P-11 regression fixture: mutate the recorded REF-AWI-023 file digest so
   * the Manifest no longer matches the root-bound source file — the exact
   * drift an archived Stage exhibits after the Authority files evolve.
   */
  readonly breakReferenceBindings?: boolean;
  /** Do not write the Manifest at all (a Stage that never existed). */
  readonly skipManifest?: boolean;
  /** Do not write the Stage Plan/SPV authority receipts. */
  readonly skipAuthority?: boolean;
  /** Write the SPV authority bound to a different Manifest digest. */
  readonly spvManifestDigestOverride?: string;
}

/**
 * Build a clean, committed S10 planning boundary: real vNext Manifest (the
 * binding-consistent repo artifact) + the REF-AWI-023 root-bound source, then
 * the Stage Plan/SPV admission authority receipts bound to the tuple.
 */
function prepareFixture(options: PrepareOptions = {}): CloseFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-stage-close-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-stage-close@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Stage Close Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  if (options.skipManifest !== true) {
    // The real S10 Manifest and the root-bound source of its first reference
    // (REF-AWI-023): the fixture reproduces the reported archived-Stage drift.
    copyFixture(root, `.proofloop/manifests/${STAGE_ID}.json`);
    copyFixture(root, 'tech-spec/task-acceptance-matrix.md');
  }

  const manifestPath = path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
  let manifest: Record<string, any> = {};
  if (options.skipManifest !== true) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    // Fail loudly if the repo artifact ever stops validating as vNext.
    validateVNextManifest(manifest);
    if (options.breakReferenceBindings === true) {
      const descriptor = manifest.reference_index['REF-AWI-023'];
      const digest = descriptor.file_digest as string;
      descriptor.file_digest = digest.startsWith('a') ? `b${digest.slice(1)}` : `a${digest.slice(1)}`;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  }

  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vNext stage-close planning boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = options.skipManifest === true ? FAKE_SHA256 : computeDigest(manifest);
  const planDigest = options.skipManifest === true
    ? FAKE_SHA256
    : (manifest.plan.plan_digest as string);

  if (options.skipAuthority !== true) {
    writeAuthorityReceipts(root, STAGE_ID, {
      manifestDigest: options.spvManifestDigestOverride ?? manifestDigest,
      planDigest,
      snapshotDigest,
    });
  }

  return { root, stageId: STAGE_ID, manifest, manifestDigest, planDigest, snapshotDigest };
}

/** Write the v2 SPV_PASS + STAGE_PLAN admission authority receipts (same closed shapes as `admitVNextStagePlan`). */
function writeAuthorityReceipts(
  root: string,
  stageId: string,
  bindings: { manifestDigest: string; planDigest: string; snapshotDigest: string },
): void {
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: stageId,
    manifest_digest: bindings.manifestDigest,
    plan_digest: bindings.planDigest,
    snapshot_digest: bindings.snapshotDigest,
  };
  const spv = { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) };
  const stagePlanContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'STAGE_PLAN' as const,
    stage_id: stageId,
    manifest_digest: bindings.manifestDigest,
    plan_digest: bindings.planDigest,
    snapshot_digest: bindings.snapshotDigest,
    spv_receipt_digest: spv.digest,
  };
  const stagePlan = { ...stagePlanContent, digest: computeVNextStagePlanReceiptDigest(stagePlanContent) };
  const directory = path.join(root, '.proofloop', 'receipts', 'plan', stageId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'vnext-spv-pass.json'), `${JSON.stringify(spv, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(directory, 'vnext-stage-plan.json'), `${JSON.stringify(stagePlan, null, 2)}\n`, 'utf8');
}

function closeRequest(
  fx: CloseFixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'stage_close',
    stageId: fx.stageId,
    closeType: 'restricted',
    reason: 'S10 restricted close: user-adjudicated, no STAGE_REVIEW_PASS, possibly unintegrated Slices',
    manifestDigest: fx.manifestDigest,
    snapshotDigest: fx.snapshotDigest,
    ...overrides,
  };
}

function admit(fx: CloseFixture, request: Record<string, unknown>): AdmitResult<VNextStageCloseAdmissionState> {
  return admitVNextStageClose(request, { projectRoot: fx.root });
}

/** Assert the persisted write-once envelope: digest-addressed, root-bound shape, payload === admitted state. */
function expectPersistedCloseReceipt(
  fx: CloseFixture,
  result: AdmitResult<VNextStageCloseAdmissionState>,
): void {
  const digest = result.receipt_ref;
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  const file = path.join(fx.root, '.proofloop', 'receipts', 'stage-close', fx.stageId, `${digest}.json`);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  expect(parsed.type).toBe(VNEXT_STAGE_CLOSE_PASS_TYPE);
  expect(parsed.stage_id).toBe(fx.stageId);
  expect(parsed.digest).toBe(digest);
  expect(parsed.payload).toEqual(result.vnext_state);
}

describe('vNext Stage Close admission (P-11)', () => {
  it('admits a restricted close of an active Stage and persists the write-once receipt', () => {
    const fx = prepareFixture();
    const result = admit(fx, closeRequest(fx));

    expect(result.accepted).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'STAGE_CLOSE_RESULT',
      action: 'STAGE_CLOSE',
      stage_id: STAGE_ID,
      close_type: 'restricted',
      reason: expect.any(String) as unknown as string,
      manifest_digest: fx.manifestDigest,
      plan_digest: fx.planDigest,
      snapshot_digest: fx.snapshotDigest,
      receipt_chain_valid: true,
    });
    expect(result.vnext_state?.stage_plan_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state?.spv_receipt_digest).toMatch(/^[a-f0-9]{64}$/);
    expectPersistedCloseReceipt(fx, result);
  });

  it('admits a full close (normal completion) the same way', () => {
    const fx = prepareFixture();
    const result = admit(fx, closeRequest(fx, { closeType: 'full', reason: 'S10 full close: normal completion' }));

    expect(result.accepted).toBe(true);
    expect(result.vnext_state?.close_type).toBe('full');
    expectPersistedCloseReceipt(fx, result);
  });

  it('admits the close of an archived Stage whose Manifest reference bindings no longer match the root files (REF-AWI-023 digest drift)', () => {
    // The archived-Stage fixture: the Manifest is a historical snapshot whose
    // recorded REF-AWI-023 file digest no longer matches the root-bound
    // source (the Authority files evolved after the restricted close).
    const fx = prepareFixture({ breakReferenceBindings: true });

    // Guard: this fixture genuinely reproduces the reported failure mode — the
    // binding revalidation MUST reject it (the exact `REF-AWI-023 file_digest
    // does not match the root bound source` error of the P-11 bug).
    expect(() => assertVNextManifestReferenceBindings(fx.root, fx.manifest as VNextManifest)).toThrow(
      /REF-AWI-023 file_digest does not match the root bound source/,
    );

    // The Stage Close admission is the machine marker for a closed/archived
    // Stage: it must NOT re-bind the historical Manifest to the current root
    // files. The close still succeeds and persists the receipt.
    const result = admit(fx, closeRequest(fx));
    expect(result.accepted).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.vnext_state?.manifest_digest).toBe(fx.manifestDigest);
    expectPersistedCloseReceipt(fx, result);
  });

  it('refuses a Stage with no readable Manifest (a Stage that never existed cannot be archived)', () => {
    const fx = prepareFixture({ skipManifest: true });
    const result = admit(fx, closeRequest(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.severity).toBe('error');
    expect(result.findings[0]?.message).toMatch(/Manifest/);
    expect(fs.existsSync(path.join(fx.root, '.proofloop', 'receipts', 'stage-close'))).toBe(false);
  });

  it('refuses when the Manifest stage_id does not match the request', () => {
    const fx = prepareFixture();
    const manifestPath = path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
    const tampered = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
    tampered.stage_id = 'S11';
    fs.writeFileSync(manifestPath, JSON.stringify(tampered), 'utf8');

    const result = admit(fx, closeRequest(fx));
    expect(result.accepted).toBe(false);
    expect(result.findings[0]?.message).toMatch(/stage_id/);
  });

  it('refuses when the request manifestDigest does not match the persisted Manifest', () => {
    const fx = prepareFixture();
    const wrongDigest = fx.manifestDigest.startsWith('a') ? `b${fx.manifestDigest.slice(1)}` : `a${fx.manifestDigest.slice(1)}`;
    const result = admit(fx, closeRequest(fx, { manifestDigest: wrongDigest }));

    expect(result.accepted).toBe(false);
    expect(result.findings[0]?.message).toMatch(/manifestDigest/);
  });

  it('refuses when the Stage Plan/SPV admission authority is missing', () => {
    const fx = prepareFixture({ skipAuthority: true });
    const result = admit(fx, closeRequest(fx));

    expect(result.accepted).toBe(false);
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0]?.message).toMatch(/authority/);
  });

  it('refuses when the request snapshotDigest does not match the current Git HEAD', () => {
    const fx = prepareFixture();
    const result = admit(fx, closeRequest(fx, { snapshotDigest: FAKE_SHA256.slice(0, 40) }));

    expect(result.accepted).toBe(false);
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    // The SPV authority is bound to the real HEAD; the requested snapshot is a
    // foreign commit, so the snapshot/boundary binding fails closed.
    expect(result.findings[0]?.message).toMatch(/snapshot/);
  });

  it('refuses a second close (write-once)', () => {
    const fx = prepareFixture();
    const first = admit(fx, closeRequest(fx));
    expect(first.accepted).toBe(true);
    expectPersistedCloseReceipt(fx, first);

    const second = admit(fx, closeRequest(fx));
    expect(second.accepted).toBe(false);
    expect(second.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(second.findings[0]?.message).toMatch(/already closed/);
    // No second receipt: the directory still holds exactly the first envelope.
    const directory = path.join(fx.root, '.proofloop', 'receipts', 'stage-close', fx.stageId);
    expect(fs.readdirSync(directory).filter((name) => name.endsWith('.json'))).toEqual([
      `${first.receipt_ref}.json`,
    ]);
  });

  it('refuses when the authority receipts do not bind the Manifest/Plan tuple', () => {
    const fx = prepareFixture({ spvManifestDigestOverride: FAKE_SHA256 });
    const result = admit(fx, closeRequest(fx));

    expect(result.accepted).toBe(false);
    expect(result.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(result.findings[0]?.message).toMatch(/does not bind the Manifest\/Plan tuple/);
  });

  it('rejects malformed requests by the closed schema', () => {
    const fx = prepareFixture();
    const cases: Array<{ name: string; overrides: Record<string, unknown>; message: RegExp }> = [
      { name: 'wrong type', overrides: { type: 'stage_gate' }, message: /type must be stage_close/ },
      { name: 'non-canonical stageId', overrides: { stageId: 'S10-X' }, message: /canonical Stage ID/ },
      { name: 'legacy label stageId', overrides: { stageId: 'S08B0' }, message: /canonical Stage ID/ },
      { name: 'unknown closeType', overrides: { closeType: 'COMPLETED' }, message: /closeType/ },
      { name: 'empty reason', overrides: { reason: '' }, message: /reason/ },
      { name: 'missing manifestDigest', overrides: { manifestDigest: undefined }, message: /manifestDigest/ },
      { name: 'malformed manifestDigest', overrides: { manifestDigest: 'not-a-digest' }, message: /manifestDigest/ },
      { name: 'malformed snapshotDigest', overrides: { snapshotDigest: 'xyz' }, message: /snapshotDigest/ },
      { name: 'unknown field', overrides: { extra: true }, message: /unknown field/ },
    ];
    for (const { overrides, message } of cases) {
      const result = admit(fx, closeRequest(fx, overrides));
      expect(result.accepted).toBe(false);
      expect(result.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(result.findings[0]?.message).toMatch(/request rejected by closed schema/);
      expect(result.findings[0]?.message).toMatch(message);
    }
    expect(fs.existsSync(path.join(fx.root, '.proofloop', 'receipts', 'stage-close'))).toBe(false);
  });
});
