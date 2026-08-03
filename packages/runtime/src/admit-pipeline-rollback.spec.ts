/**
 * admit-pipeline-rollback.spec.ts — S3-REVIEW-002 (runtime minimal hardening)
 *
 * Review finding (major): after `writer.write` persists the Receipt, a
 * post-write `verifyChain` failure returned `{ accepted:false, receipt_ref:
 * null }` but the Receipt FILE ALREADY EXISTED on disk — violating OUT-S3-04
 * "chain failure → 不写 Receipt".
 *
 * Brain-approved fix: in `runAdmitPipeline` step 7, when the post-write chain
 * verification fails, ROLL BACK the just-written Receipt file ONLY:
 *
 *   1. containment — the file is deleted only when its canonical realpath
 *      stays inside the trust boundary (S03-A parent-chain realpath
 *      discipline, `canonicalPathWithinRoot`);
 *   2. identity — the file is deleted only when it is a self-consistent
 *      receipt whose stored digest equals `writeResult.digest` (never delete
 *      someone else's file);
 *   3. rollback success → return the ORIGINAL reject (accepted:false,
 *      receipt_ref:null, RUNTIME.RECEIPT_CHAIN_BROKEN) — semantically
 *      equivalent to "no Receipt written";
 *   4. rollback failure (IO/permission/race/identity) → STILL return the
 *      reject, but the findings MUST honestly declare "receipt persisted but
 *      chain verify failed and rollback incomplete" naming the persisted
 *      receipt digest + the rollback failure reason (fail-closed + honest
 *      residual-window recording).
 *
 * Recheck round-2 (failure signature S3-B-RECHECK-ROLLBACK-TOCTOU-SCOPE-001)
 * closes two concrete counterexamples:
 *
 *   R2-1 (deletion TOCTOU): the deletion is bound to the VERIFIED category
 *        directory inode (S03-A dirfd precedent) — `O_RDONLY|O_DIRECTORY|
 *        O_NOFOLLOW` dirfd + fstat dev/ino cross-check + `/proc/self/fd/<fd>/`
 *        relative read/unlink, so a parent swap AFTER the open cannot redirect
 *        the unlink outside the trust boundary.
 *   R2-2 (concurrent successor): the file is deleted ONLY when this run's
 *        receipt is STILL the current category chain tip — no successor
 *        references it as predecessor; otherwise the rollback SKIPS the delete
 *        and the reject honestly declares "rollback skipped because a
 *        successor receipt now references the chain".
 *
 * Recheck round-3 (failure signature S3-B-RECHECK-ROLLBACK-TIP-TOCTOU-001)
 * closes the tip-check→unlink window:
 *
 *   R3-1 (successor between tip check and unlink): a successor can be appended
 *        AFTER `isStillChainTip()` returns true but BEFORE `fs.unlinkSync()`.
 *        A LAST-MOMENT re-validation (`revalidateRollbackTarget`), run
 *        THROUGH THE SAME BOUND DIRFD immediately before the unlink,
 *        re-confirms (a) our receipt is still the chain tip and (b) our file
 *        still exists with our digest; if either changed the delete is SKIPPED
 *        with the honest declaration. The double-check narrows the window to
 *        the microsecond between the final re-validation and the unlink
 *        (recorded as a Node/OS inherent residual window under a
 *        malicious-concurrency attacker model — same convergence precedent as
 *        S03-A PO-S03-A-03).
 *
 * Mutation-sensitive: removing the rollback (restoring the old behavior —
 * a bare reject after a post-write verify failure) MUST fail these tests;
 * removing the tip check fails the successor test; removing the dirfd/no-follow
 * binding fails the deletion-TOCTOU test; removing the last-moment re-validation
 * fails the R3-1 successor-between-check-and-unlink test.
 *
 * Public seam: `@proofloop/runtime` — `runAdmitPipeline` post-write chain
 * failure behavior over real temp fixtures and the injected
 * `ReceiptWriterPort` (kernel `writeReceipt` does the real write; the port's
 * `verifyChain` seam injects the post-write failure or the test tampers the
 * chain on disk between write and verify).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeReceipt, verifyReceiptChain, verifyReceiptDigest, StageState, ProjectState } from '@proofloop/kernel';
import type { ReceiptWriterOptions } from '@proofloop/kernel';
import { runAdmitPipeline } from '@proofloop/runtime';
import type {
  ReconcileStageResult,
  ReceiptWriterPort,
  AdmitPipelineSteps,
  AdmitResult,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S03-B';
const FIXED_TIMESTAMP = '2025-01-01T00:00:00.000Z';

/** Deterministic reconciled stage state used as the fake reconcile output. */
function fakeReconciledState(): ReconcileStageResult {
  return {
    stage_id: STAGE_ID,
    slices: [],
    stage_state: StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
    receipt_chain_valid: true,
    receipt_categories: [],
  };
}

// ============================================================
// Fixture helpers (real temp dir + canonical category layout)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    try {
      fn?.();
    } catch {
      // best-effort — the fixture teardown must never mask a test result
    }
  }
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rollback-'));
  cleanups.push(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  return root;
}

/** Canonical category dir for the pipeline fixture (plan/<stage>/). */
function planDir(root: string): string {
  return path.join(root, 'plan', STAGE_ID);
}

function makePlanSteps(root: string): AdmitPipelineSteps {
  return {
    precheck: () => ({ accepted: true, nextState: fakeReconciledState() }),
    buildReceipt: () => ({
      type: 'STAGE_PLAN',
      stage_id: STAGE_ID,
      timestamp: FIXED_TIMESTAMP,
      payload: { request_type: 'stage_plan' },
    }),
    targetDir: () => planDir(root),
  };
}

/** Valid schema-legal stage_plan request (bindings are precheck-owned here). */
function stagePlanRequest() {
  return { type: 'stage_plan' as const, stageId: STAGE_ID, manifestDigest: 'd' };
}

/** Test-only rollback hook shape (matches the documented `RollbackTestHooks` seam). */
interface RollbackHooks {
  beforeDirOpen?: () => void;
  beforeUnlink?: () => void;
}

/** Run the pipeline against a real fixture with the injected writer. */
function runFixture(
  root: string,
  writer: ReceiptWriterPort,
  projectRoot?: string,
  hooks?: RollbackHooks,
): AdmitResult {
  return runAdmitPipeline(
    {
      request: stagePlanRequest(),
      reconcile: () => fakeReconciledState(),
      steps: makePlanSteps(root),
      writer,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    },
    hooks,
  );
}

/**
 * Writer whose `write` is the REAL kernel `writeReceipt` and whose
 * `verifyChain` reports INVALID on the second call (the post-write verify)
 * after a valid pre-write verify — the S3-REVIEW-002 injection seam.
 */
function makePostWriteFailWriter(): ReceiptWriterPort {
  let verifyCount = 0;
  return {
    write: (data, options) => writeReceipt(data, options),
    verifyChain: (receiptDir) => {
      verifyCount += 1;
      if (verifyCount >= 2) {
        return {
          valid: false,
          receipts: [],
          brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
        };
      }
      return verifyReceiptChain(receiptDir);
    },
  };
}

function jsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

// ============================================================
// 1. Rollback success — post-write verify failure deletes the write
// ============================================================

describe('post-write chain failure rollback (S3-REVIEW-002 / OUT-S3-04)', () => {
  it('rolls back the just-written receipt when the post-write verify fails (no file remains, original reject preserved)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);

    const result = runFixture(root, makePostWriteFailWriter());

    // Fail closed with the ORIGINAL reject semantics — no receipt ref, the
    // canonical chain-broken finding, and NO residual-window finding (the
    // rollback succeeded, so this is equivalent to "no Receipt written").
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.findings[0].message).toContain('after admit');
    expect(result.findings).toHaveLength(1);

    // The just-written receipt file is GONE after the reject.
    expect(jsonFiles(dir)).toHaveLength(0);
  });

  it('deletes ONLY the digest-verified file from THIS run and never another receipt (tamper seam)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    // Seed a valid genesis receipt (the pre-existing chain).
    const genesis = writeReceipt(
      {
        version: 1,
        type: 'STAGE_PLAN',
        stage_id: STAGE_ID,
        timestamp: '2024-12-31T00:00:00.000Z',
        payload: { status: 'planned' },
      },
      { receiptDir: dir, tempDir: dir },
    );

    // Writer: real write, then tamper the GENESIS on disk between the write
    // and the (real) post-write verify — the chain is now broken, but the
    // just-written receipt is intact.
    let writes = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options) => {
        writes += 1;
        const result = writeReceipt(data, options);
        const genesisPath = path.join(dir, `${genesis.digest}.json`);
        const parsed = JSON.parse(fs.readFileSync(genesisPath, 'utf-8')) as Record<string, unknown>;
        parsed['payload'] = { ...(parsed['payload'] as Record<string, unknown>), tampered: true };
        fs.writeFileSync(genesisPath, JSON.stringify(parsed), 'utf-8');
        return result;
      },
      verifyChain: (receiptDir) => verifyReceiptChain(receiptDir),
    };

    const result = runFixture(root, writer);

    expect(writes).toBe(1);
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    // The just-written receipt was rolled back …
    const names = jsonFiles(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${genesis.digest}.json`);
    // … and the pre-existing genesis was NOT deleted (the rollback targets
    // only the digest-verified file from this run).
    expect(fs.existsSync(path.join(dir, `${genesis.digest}.json`))).toBe(true);
  });

  it('success path is unchanged: a chain-valid admit writes exactly one receipt and never triggers rollback', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options) => writeReceipt(data, options),
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        return verifyReceiptChain(receiptDir);
      },
    };

    const result = runFixture(root, writer);

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    expect(result.findings).toEqual([]);
    expect(verifyCount).toBe(2); // pre-write + post-write, both real
    const names = jsonFiles(dir);
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${result.receipt_ref}.json`);
    expect(verifyReceiptChain(dir).valid).toBe(true);
    expect(verifyReceiptDigest(path.join(dir, names[0]))).toBe(true);
  });

  it('honors the stronger caller-supplied project root as the rollback containment boundary', () => {
    const root = makeTempRoot();
    const dir = planDir(root);

    const result = runFixture(root, makePostWriteFailWriter(), root);

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(jsonFiles(dir)).toHaveLength(0);
  });
});

// ============================================================
// 2. Rollback failure — honest residual-window declaration
// ============================================================

describe('rollback failure honesty (S3-REVIEW-002 residual window)', () => {
  it('declares the persisted receipt when the rollback delete fails (IO/permission) and still rejects', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        // Make the parent read-only AFTER the write so the rollback unlink
        // fails with an IO/permission error (0o555 = read + execute, no write).
        fs.chmodSync(dir, 0o555);
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount >= 2) {
          return {
            valid: false,
            receipts: [],
            brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
          };
        }
        return verifyReceiptChain(receiptDir);
      },
    };

    try {
      const result = runFixture(root, writer);

      // Still a fail-closed reject …
      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
      // … AND the honest residual-window declaration names the persisted
      // receipt digest + the rollback failure reason.
      expect(result.findings).toHaveLength(2);
      const honest = result.findings[1];
      expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
      expect(honest.message).toContain('receipt digest');
      expect(writtenDigest).toBeTruthy();
      expect(honest.message).toContain(String(writtenDigest));
      expect(honest.message).toMatch(/rollback failed:/);
      // The receipt file is still on disk (rollback could not complete).
      expect(jsonFiles(dir)).toHaveLength(1);
      expect(jsonFiles(dir)[0]).toBe(`${String(writtenDigest)}.json`);
    } finally {
      // Restore the parent so the fixture teardown can remove the tree.
      fs.chmodSync(dir, 0o755);
    }
  });

  it('never deletes a file whose stored digest does not match the write result (identity guard → honest declaration)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        // Replace the file at OUR path with a DIFFERENT valid receipt (a
        // concurrent writer / race). Its stored digest no longer equals the
        // write result digest — the rollback must refuse to delete it.
        const foreign = writeReceipt(
          {
            version: 1,
            type: 'STAGE_PLAN',
            stage_id: STAGE_ID,
            timestamp: '2025-02-01T00:00:00.000Z',
            payload: { request_type: 'stage_plan', foreign: true },
          },
          { receiptDir: dir, tempDir: dir },
        );
        fs.copyFileSync(
          path.join(dir, `${foreign.digest}.json`),
          path.join(dir, `${result.digest}.json`),
        );
        fs.rmSync(path.join(dir, `${foreign.digest}.json`));
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount >= 2) {
          return {
            valid: false,
            receipts: [],
            brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
          };
        }
        return verifyReceiptChain(receiptDir);
      },
    };

    const result = runFixture(root, writer);

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.findings).toHaveLength(2);
    const honest = result.findings[1];
    expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
    expect(writtenDigest).toBeTruthy();
    expect(honest.message).toContain(String(writtenDigest));
    expect(honest.message).toMatch(/rollback failed:/);
    expect(honest.message).toMatch(/identity|not this run/);
    // The foreign file is NOT deleted — the pipeline never removes a receipt
    // whose digest does not match this run's write result.
    expect(jsonFiles(dir)).toHaveLength(1);
  });
});

// ============================================================
// 3. Recheck round-2 counterexamples
//    (S3-B-RECHECK-ROLLBACK-TOCTOU-SCOPE-001)
// ============================================================

describe('rollback round-2: deletion TOCTOU + concurrent successor', () => {
  it('R2-1 deletion TOCTOU: a parent swapped to an outside symlink between verification and delete cannot redirect the unlink (dirfd dev/ino cross-check)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    // OUTSIDE category directory carrying the SAME receipt content (the
    // "bait"): a redirected delete would consume it — the test proves it never
    // happens.
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-rollback-outside-'));
    cleanups.push(() => {
      try {
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    let swapped = false;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        // Copy our receipt to the OUTSIDE category at the same relative path.
        const outsideCat = path.join(outsideRoot, 'plan', STAGE_ID);
        fs.mkdirSync(outsideCat, { recursive: true });
        fs.copyFileSync(
          path.join(dir, `${result.digest}.json`),
          path.join(outsideCat, `${result.digest}.json`),
        );
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount >= 2) {
          return {
            valid: false,
            receipts: [],
            brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
          };
        }
        return verifyReceiptChain(receiptDir);
      },
    };

    const hooks: RollbackHooks = {
      beforeDirOpen: () => {
        // The race: swap the intermediate parent `root/plan` to a symlink
        // pointing at the OUTSIDE plan dir AFTER the containment check and
        // expected dev/ino capture, IMMEDIATELY BEFORE the dirfd open. The
        // dirfd fstat must mismatch the captured inode → fail closed.
        swapped = true;
        fs.renameSync(path.join(root, 'plan'), path.join(root, 'plan-original'));
        fs.symlinkSync(path.join(outsideRoot, 'plan'), path.join(root, 'plan'));
      },
    };

    try {
      const result = runFixture(root, writer, root, hooks);

      expect(swapped).toBe(true);
      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
      // Honest residual-window declaration with the swap reason.
      expect(result.findings).toHaveLength(2);
      const honest = result.findings[1];
      expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
      expect(honest.message).toContain('dev/ino mismatch');
      // The OUTSIDE bait was NOT deleted — the deletion stayed bound to the
      // verified category directory inode (trust boundary held).
      expect(writtenDigest).toBeTruthy();
      expect(
        fs.existsSync(path.join(outsideRoot, 'plan', STAGE_ID, `${String(writtenDigest)}.json`)),
      ).toBe(true);
    } finally {
      // Restore the swap so the fixture teardown can remove the tree.
      try {
        fs.unlinkSync(path.join(root, 'plan'));
      } catch {
        // best-effort
      }
      try {
        fs.renameSync(path.join(root, 'plan-original'), path.join(root, 'plan'));
      } catch {
        // best-effort
      }
    }
  });

  it('R2-2 concurrent successor: a receipt appended after our write referencing ours prevents the rollback delete (honest declaration, successor chain intact)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        // Concurrent successor: a second receipt appended AFTER our write
        // (the writer lock was released) that references OUR receipt as
        // predecessor (previous_digest, exactly as a pipeline-concurrent
        // writer would link the new chain tip). Deleting our receipt now
        // would break its chain.
        writeReceipt(
          {
            version: 1,
            type: 'STAGE_PLAN',
            stage_id: STAGE_ID,
            timestamp: '2025-02-02T00:00:00.000Z',
            previous_digest: result.digest,
            payload: { request_type: 'stage_plan', successor: true },
          },
          { receiptDir: dir, tempDir: dir },
        );
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount >= 2) {
          return {
            valid: false,
            receipts: [],
            brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
          };
        }
        return verifyReceiptChain(receiptDir);
      },
    };

    const result = runFixture(root, writer, root);

    expect(writtenDigest).toBeTruthy();
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    // The rollback SKIPPED the delete (never break a successor chain) and the
    // reject honestly declares it.
    expect(result.findings).toHaveLength(2);
    const honest = result.findings[1];
    expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
    expect(honest.message).toContain('successor receipt now references the chain');
    expect(honest.message).toContain(String(writtenDigest));
    // BOTH receipts remain — the predecessor was NOT deleted.
    expect(jsonFiles(dir)).toHaveLength(2);
    // The successor chain is intact: our receipt exists and the successor
    // links it as predecessor; the on-disk chain verifies clean.
    const parsed = jsonFiles(dir).map(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
          digest: string;
          previous_digest?: string;
        },
    );
    const ourDigest = String(writtenDigest);
    const successor = parsed.find((r) => r.digest !== ourDigest);
    expect(successor?.previous_digest).toBe(ourDigest);
    expect(verifyReceiptChain(dir).valid).toBe(true);
  });

  it('R3-1 successor inserted between the tip check and the unlink is caught by the last-moment re-validation (delete skipped, successor chain intact)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount >= 2) {
          return {
            valid: false,
            receipts: [],
            brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
          };
        }
        return verifyReceiptChain(receiptDir);
      },
    };

    let injected = false;
    const hooks: RollbackHooks = {
      beforeUnlink: () => {
        injected = true;
        // The round-3 counterexample: a concurrent successor appended AFTER
        // the first chain-tip check returns true and BEFORE the unlink. It
        // references OUR receipt as predecessor — deleting ours now would
        // break its chain. The last-moment re-validation must catch it.
        expect(writtenDigest).toBeTruthy();
        writeReceipt(
          {
            version: 1,
            type: 'STAGE_PLAN',
            stage_id: STAGE_ID,
            timestamp: '2025-03-01T00:00:00.000Z',
            previous_digest: String(writtenDigest),
            payload: { request_type: 'stage_plan', successor: true },
          },
          { receiptDir: dir, tempDir: dir },
        );
      },
    };

    const result = runFixture(root, writer, root, hooks);

    expect(injected).toBe(true);
    expect(writtenDigest).toBeTruthy();
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    // The delete was SKIPPED and the reject honestly declares the successor.
    expect(result.findings).toHaveLength(2);
    const honest = result.findings[1];
    expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
    expect(honest.message).toContain('successor receipt now references the chain');
    // BOTH receipts remain — the predecessor was NOT deleted by the unlink.
    expect(jsonFiles(dir)).toHaveLength(2);
    // The successor chain is intact: our receipt exists and the successor
    // links it as predecessor; the on-disk chain verifies clean.
    const parsed = jsonFiles(dir).map(
      (f) =>
        JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
          digest: string;
          previous_digest?: string;
        },
    );
    const ourDigest = String(writtenDigest);
    const successor = parsed.find((r) => r.digest !== ourDigest);
    expect(successor?.previous_digest).toBe(ourDigest);
    expect(verifyReceiptChain(dir).valid).toBe(true);
  });

  it('R4-1 S3-REVIEW-004: a path replaced with a symlink to a PRE-EXISTING same-digest receipt is never deleted (original-identity preserved, honest declaration)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    // Pre-existing, content-identical, SAME-DIGEST receipt elsewhere INSIDE
    // the worktree (the kernel canonical receipt for the pipeline's exact
    // build — deterministic timestamp → identical digest).
    const preExistingDir = path.join(root, 'elsewhere');
    fs.mkdirSync(preExistingDir, { recursive: true });
    const preExisting = writeReceipt(
      {
        version: 1,
        type: 'STAGE_PLAN',
        stage_id: STAGE_ID,
        timestamp: FIXED_TIMESTAMP,
        payload: { request_type: 'stage_plan' },
      },
      { receiptDir: preExistingDir, tempDir: preExistingDir },
    );
    const preExistingPath = path.join(preExistingDir, `${preExisting.digest}.json`);
    const preExistingContent = fs.readFileSync(preExistingPath, 'utf-8');

    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => writeReceipt(data, options),
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount === 1) {
          return verifyReceiptChain(receiptDir);
        }
        // Post-write: the Receipt PARENT is replaced by a symlink pointing at
        // the pre-existing SAME-DIGEST receipt's directory. The write-time
        // identity capture already recorded THIS run's fresh inode; the
        // rollback must abandon rather than delete the pre-existing receipt.
        fs.renameSync(dir, path.join(root, 'plan', `${STAGE_ID}-orig`));
        fs.symlinkSync(preExistingDir, dir);
        return {
          valid: false,
          receipts: [],
          brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
        };
      },
    };

    const result = runFixture(root, writer, root);

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    // The delete was ABANDONED and the reject honestly declares the identity
    // mismatch (never delete a pre-existing receipt).
    expect(result.findings).toHaveLength(2);
    const honest = result.findings[1];
    expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
    expect(honest.message).toContain('target identity mismatch');
    expect(honest.message).toContain('pre-existing receipt may be present');
    // The pre-existing receipt SURVIVES byte-identical.
    expect(fs.existsSync(preExistingPath)).toBe(true);
    expect(fs.readFileSync(preExistingPath, 'utf-8')).toBe(preExistingContent);
  });

  it('R5-1 S3-REVIEW-004: a post-capture rename + SYMLINK to the SAME INODE under a DIFFERENT basename is never unlinked (basename check)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount === 1) {
          return verifyReceiptChain(receiptDir);
        }
        // Hostile same-inode/different-basename replacement: rename the
        // just-written entry to a DIFFERENT basename and put a SYMLINK under
        // the ORIGINAL basename pointing to the renamed same-inode entry. The
        // canonical-path basename now differs from the captured original
        // basename — the basename check must abandon the delete.
        expect(writtenDigest).toBeTruthy();
        const original = path.join(dir, `${String(writtenDigest)}.json`);
        const renamed = path.join(dir, `${String(writtenDigest)}.renamed`);
        fs.renameSync(original, renamed);
        fs.symlinkSync(path.basename(renamed), original);
        return {
          valid: false,
          receipts: [],
          brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
        };
      },
    };

    const result = runFixture(root, writer, root);

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.findings).toHaveLength(2);
    const honest = result.findings[1];
    expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
    expect(honest.message).toContain('target identity mismatch');
    // The entry under the ORIGINAL basename was NOT deleted (unlink abandoned)
    // and the same-inode file content survives under the different basename.
    expect(writtenDigest).toBeTruthy();
    expect(fs.existsSync(path.join(dir, `${String(writtenDigest)}.json`))).toBe(true);
    const renamedPath = path.join(dir, `${String(writtenDigest)}.renamed`);
    expect(fs.existsSync(renamedPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(renamedPath, 'utf-8')) as { digest: string };
    expect(content.digest).toBe(String(writtenDigest));
  });

  it('R5-2 S3-REVIEW-004: a post-capture rename + HARDLINK to the SAME INODE under a DIFFERENT basename is never unlinked (link-count check)', () => {
    const root = makeTempRoot();
    const dir = planDir(root);
    fs.mkdirSync(dir, { recursive: true });

    let writtenDigest: string | null = null;
    let verifyCount = 0;
    const writer: ReceiptWriterPort = {
      write: (data, options: ReceiptWriterOptions) => {
        const result = writeReceipt(data, options);
        writtenDigest = result.digest;
        return result;
      },
      verifyChain: (receiptDir) => {
        verifyCount += 1;
        if (verifyCount === 1) {
          return verifyReceiptChain(receiptDir);
        }
        // Hostile same-inode/different-basename replacement via a HARDLINK:
        // rename the just-written entry to a DIFFERENT basename and hardlink
        // the ORIGINAL basename to the same inode. lstat still reports the
        // captured dev/ino, but nlink is now 2 — the link-count check must
        // abandon the delete.
        expect(writtenDigest).toBeTruthy();
        const original = path.join(dir, `${String(writtenDigest)}.json`);
        const renamed = path.join(dir, `${String(writtenDigest)}.renamed`);
        fs.renameSync(original, renamed);
        fs.linkSync(renamed, original);
        return {
          valid: false,
          receipts: [],
          brokenLink: { index: 0, expected: '(expected digest)', actual: '(tampered digest)' },
        };
      },
    };

    const result = runFixture(root, writer, root);

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.findings).toHaveLength(2);
    const honest = result.findings[1];
    expect(honest.message).toContain('receipt persisted but chain verify failed and rollback incomplete');
    expect(honest.message).toContain('target identity mismatch');
    // The hardlink under the ORIGINAL basename was NOT deleted and the
    // same-inode file content survives under the different basename.
    expect(writtenDigest).toBeTruthy();
    expect(fs.existsSync(path.join(dir, `${String(writtenDigest)}.json`))).toBe(true);
    const renamedPath = path.join(dir, `${String(writtenDigest)}.renamed`);
    expect(fs.existsSync(renamedPath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(renamedPath, 'utf-8')) as { digest: string };
    expect(content.digest).toBe(String(writtenDigest));
  });
});
