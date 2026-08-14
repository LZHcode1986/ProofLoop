import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ReceiptChainError,
  writeReceipt,
} from '@proofloop/kernel';
import type { WriteReceiptResult } from '@proofloop/kernel';
import {
  defaultReceiptWriter,
  readReceiptCategory,
  runReceiptAdmission,
  tasksReceiptDir,
} from '../index';
import type {
  AdmitResult,
  ReceiptAdmissionInput,
  ReceiptBuild,
  ReceiptWriterPort,
  VNextWorkerAdmissionState,
} from '../index';

const cleanups: string[] = [];

interface BoundedFault {
  readonly mode:
    | 'writer-time-competitor'
    | 'malformed-successor'
    | 'symlink-successor'
    | 'post-install-competitor';
  readonly targetDir: string;
  readonly outside?: string;
  finalPath?: string;
  movedPath?: string;
  injected: boolean;
}

let boundedFault: BoundedFault | undefined;

// The bounded default has no injected ReceiptWriterPort seam.  Wrap only the
// K1 function for deterministic post-return race fixtures; every wrapper first
// executes the real writer and then mutates the fixture exactly at the
// Runtime/K1 boundary.
vi.mock('@proofloop/kernel', async () => {
  const actual = await vi.importActual<typeof import('@proofloop/kernel')>('@proofloop/kernel');
  return {
    ...actual,
    writeReceiptBounded: vi.fn((
      ...args: Parameters<typeof actual.writeReceiptBounded>
    ) => {
      const result = actual.writeReceiptBounded(...args);
      const fault = boundedFault;
      if (fault === undefined) return result;

      fault.finalPath = result.path;
      if (fault.mode === 'writer-time-competitor') {
        fault.injected = true;
        fault.movedPath = path.join(path.dirname(fault.targetDir), 'writer-time-original.json');
        fs.renameSync(result.path, fault.movedPath);
        fs.copyFileSync(fault.movedPath, result.path);
        fs.writeFileSync(
          path.join(fault.targetDir, 'malformed-successor.json'),
          '{malformed-successor',
          'utf8',
        );
        return result;
      }

      if (fault.mode === 'malformed-successor') {
        fault.injected = true;
        fs.writeFileSync(
          path.join(fault.targetDir, 'malformed-successor.json'),
          '{malformed-successor',
          'utf8',
        );
        return result;
      }

      if (fault.mode === 'symlink-successor') {
        fault.injected = true;
        const outside = fault.outside as string;
        const bait = path.join(outside, 'symlink-successor-bait');
        fs.writeFileSync(bait, 'outside-bait\n', 'utf8');
        fs.symlinkSync(bait, path.join(fault.targetDir, 'symlink-successor.json'));
        return result;
      }

      fault.injected = true;
      fault.movedPath = path.join(path.dirname(fault.targetDir), 'writer-time-original.json');
      fs.renameSync(result.path, fault.movedPath);
      fs.writeFileSync(result.path, 'bounded-competitor-entry\n', 'utf8');
      throw new actual.ReceiptChainError(
        'writeReceiptBounded: injected post-install failure; Receipt persisted after install, but cleanup was not completed',
        'self_digest',
        result.digest,
      );
    }),
  };
});

afterEach(() => {
  boundedFault = undefined;
  for (const root of cleanups.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-receipt-'));
  cleanups.push(root);
  return root;
}

function nextState(): VNextWorkerAdmissionState {
  return {
    schema_version: 2,
    action: 'TASK_COMPLETE',
    stage_id: 'S03',
    slice_id: 'S03-A',
    task_id: 'S03-A-T01',
    mode: 'implement-task',
    outcome: 'completed',
    manifest_digest: 'a'.repeat(64),
    plan_digest: 'b'.repeat(64),
    proof_index_digest: 'c'.repeat(64),
    snapshot_digest: 'd'.repeat(40),
    context_ref: '.proofloop/context/context.json',
    context_digest: 'e'.repeat(64),
    changed_files: ['packages/runtime/src/admit-pipeline.ts'],
    receipt_chain_valid: true,
  };
}

function inputFor(
  root: string,
  actionToken = 'r3-action-token',
  overrides: Partial<ReceiptAdmissionInput> = {},
): ReceiptAdmissionInput {
  const build: ReceiptBuild = {
    type: 'TASK_COMPLETE',
    stage_id: 'S03',
    slice_id: 'S03-A',
    timestamp: '2026-08-06T00:00:00.000Z',
    payload: {
      schema_version: 2,
      action_token: actionToken,
      mode: 'implement-task',
      outcome: 'completed',
      task_id: 'S03-A-T01',
      evidence_ref: 'delivery/stages/S03/evidence/S03-A.md',
      changed_files: ['packages/runtime/src/admit-pipeline.ts'],
      verification_runs: [{ command_id: 'runtime-test', exit_code: 0, log_ref: 'temp-log' }],
      summary: 'runtime receipt seam fixture',
      manifest_digest: 'a'.repeat(64),
      plan_digest: 'b'.repeat(64),
      proof_index_digest: 'c'.repeat(64),
      snapshot_digest: 'd'.repeat(40),
      context_ref: '.proofloop/context/context.json',
      context_digest: 'e'.repeat(64),
    },
  };
  return {
    build,
    targetDir: tasksReceiptDir(root, 'S03', 'S03-A'),
    nextState: nextState(),
    projectRoot: root,
    admissionKey: actionToken,
    ...overrides,
  };
}

function seedBrokenReceipt(root: string): string {
  const dir = tasksReceiptDir(root, 'S03', 'S03-A');
  fs.mkdirSync(dir, { recursive: true });
  const written = writeReceipt(
    {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: 'S03',
      slice_id: 'S03-A',
      timestamp: '2026-08-05T00:00:00.000Z',
      payload: { action_token: 'seed' },
    },
    { receiptDir: dir, tempDir: dir },
  );
  const parsed = JSON.parse(fs.readFileSync(written.path, 'utf8')) as Record<string, unknown>;
  parsed.payload = { action_token: 'tampered' };
  fs.writeFileSync(written.path, `${JSON.stringify(parsed)}\n`, 'utf8');
  return written.path;
}

describe('vNext Worker-result Receipt seam', () => {
  it('writes through the shared writer and returns the canonical digest with readback bindings', () => {
    const root = fixtureRoot();
    const result = runReceiptAdmission(inputFor(root));

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    const readback = readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S03',
      sliceId: 'S03-A',
    });
    expect(readback.chainValid).toBe(true);
    expect(readback.receipts).toHaveLength(1);
    expect(readback.receipts[0]?.receipt.digest).toBe(result.receipt_ref);
    expect(readback.receipts[0]?.receipt.payload).toMatchObject({
      schema_version: 2,
      action_token: 'r3-action-token',
      manifest_digest: 'a'.repeat(64),
      plan_digest: 'b'.repeat(64),
      proof_index_digest: 'c'.repeat(64),
      snapshot_digest: 'd'.repeat(40),
      context_ref: '.proofloop/context/context.json',
      context_digest: 'e'.repeat(64),
      changed_files: ['packages/runtime/src/admit-pipeline.ts'],
      verification_runs: [{ command_id: 'runtime-test', exit_code: 0, log_ref: 'temp-log' }],
    });
  });

  it('rejects TASK_COMPLETE when a required state/payload binding is absent', () => {
    const requiredFields = [
      'task_id',
      'mode',
      'outcome',
      'manifest_digest',
      'plan_digest',
      'proof_index_digest',
      'snapshot_digest',
      'context_ref',
      'context_digest',
      'changed_files',
    ] as const;

    for (const field of requiredFields) {
      const root = fixtureRoot();
      const input = inputFor(root, `missing-${field}`);
      const payload = { ...input.build.payload };
      const nextState = { ...input.nextState } as Record<string, unknown>;
      delete payload[field];
      delete nextState[field];

      let writeCalls = 0;
      let verifyCalls = 0;
      const writer: ReceiptWriterPort = {
        write: (data, options) => {
          writeCalls += 1;
          return defaultReceiptWriter.write(data, options);
        },
        verifyChain: (receiptDir) => {
          verifyCalls += 1;
          return defaultReceiptWriter.verifyChain(receiptDir);
        },
      };

      const result = runReceiptAdmission({
        ...input,
        build: { ...input.build, payload },
        nextState: nextState as unknown as VNextWorkerAdmissionState,
        writer,
      });

      expect(result.accepted, field).toBe(false);
      expect(result.receipt_ref, field).toBeNull();
      expect(result.findings[0]?.code, field).toBe('RUNTIME.SCHEMA_MISMATCH');
      expect(writeCalls, field).toBe(0);
      expect(verifyCalls, field).toBe(0);
      expect(fs.existsSync(input.targetDir), field).toBe(false);
    }
  });

  it('resolves the predecessor through the bounded directory binding for a second admission', () => {
    const root = fixtureRoot();
    const first = runReceiptAdmission(inputFor(root, 'bounded-chain-first'));
    const second = runReceiptAdmission(inputFor(root, 'bounded-chain-second'));

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    const readback = readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S03',
      sliceId: 'S03-A',
    });
    expect(readback.chainValid).toBe(true);
    expect(readback.receipts).toHaveLength(2);
    expect(
      readback.receipts.find((entry) => entry.receipt.digest === second.receipt_ref)?.receipt.previous_digest,
    ).toBe(first.receipt_ref);
  });

  it('rejects a broken pre-existing chain before writing a Receipt', () => {
    const root = fixtureRoot();
    const brokenPath = seedBrokenReceipt(root);

    const result = runReceiptAdmission(inputFor(root));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S03',
      sliceId: 'S03-A',
    }).receipts).toHaveLength(0);
    expect(fs.existsSync(brokenPath)).toBe(true);
  });

  it('rolls back a Receipt when post-write chain verification fails', () => {
    const root = fixtureRoot();
    let verifyCalls = 0;
    const writer: ReceiptWriterPort = {
      write: defaultReceiptWriter.write,
      verifyChain: (receiptDir) => {
        verifyCalls += 1;
        const actual = defaultReceiptWriter.verifyChain(receiptDir);
        if (verifyCalls === 2) {
          return {
            ...actual,
            valid: false,
            brokenLink: { index: 0, expected: 'expected', actual: 'injected failure' },
          };
        }
        return actual;
      },
    };

    const result = runReceiptAdmission(inputFor(root, 'rollback-chain', { writer }));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S03',
      sliceId: 'S03-A',
    }).receipts).toHaveLength(0);
    expect(verifyCalls).toBe(2);
  });

  it('rolls back a Receipt left behind by a post-write self-digest failure', () => {
    const root = fixtureRoot();
    const writer: ReceiptWriterPort = {
      verifyChain: defaultReceiptWriter.verifyChain,
      write: (data, options): WriteReceiptResult => {
        const written = defaultReceiptWriter.write(data, options);
        throw new ReceiptChainError(
          'injected post-write self-digest failure',
          'self_digest',
          written.digest,
        );
      },
    };

    const result = runReceiptAdmission(inputFor(root, 'post-write-digest', { writer }));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S03',
      sliceId: 'S03-A',
    }).receipts).toHaveLength(0);
  });

  it('allows at most one concurrent admission for the same action key', () => {
    const root = fixtureRoot();
    let nested: AdmitResult | undefined;
    let input: ReceiptAdmissionInput;
    const writer: ReceiptWriterPort = {
      verifyChain: defaultReceiptWriter.verifyChain,
      write: (data, options) => {
        nested = runReceiptAdmission({ ...input, writer });
        return defaultReceiptWriter.write(data, options);
      },
    };
    input = inputFor(root, 'concurrent-action', { writer });

    const first = runReceiptAdmission(input);
    const readback = readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: 'S03',
      sliceId: 'S03-A',
    });

    expect(first.accepted).toBe(true);
    expect(nested?.accepted).toBe(false);
    expect(nested?.receipt_ref).toBeNull();
    expect(readback.receipts).toHaveLength(1);
  });

  it('rejects a Receipt directory lexical escape and an external symlink', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-outside-'));
    cleanups.push(outside);
    const escaped = runReceiptAdmission({
      ...inputFor(root, 'escaped-action'),
      targetDir: outside,
    });

    const parent = path.dirname(tasksReceiptDir(root, 'S03', 'S03-A'));
    fs.mkdirSync(parent, { recursive: true });
    const linkedTarget = tasksReceiptDir(root, 'S03', 'S03-A');
    fs.symlinkSync(outside, linkedTarget, 'dir');
    const linked = runReceiptAdmission(inputFor(root, 'symlink-action'));

    expect(escaped.accepted).toBe(false);
    expect(escaped.receipt_ref).toBeNull();
    expect(linked.accepted).toBe(false);
    expect(linked.receipt_ref).toBeNull();
    expect(fs.readdirSync(outside).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('fails closed before K2 for a non-canonical nested target without writing a Receipt', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-nested-outside-'));
    cleanups.push(outside);
    const targetDir = path.join(root, '.proofloop', 'receipts', 'nested', 'S03', 'S03-A');

    expect(fs.existsSync(targetDir)).toBe(false);
    const result = runReceiptAdmission(
      inputFor(root, 'nested-action', { targetDir }),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(result.findings[0]?.message).toContain('canonical tasks/S03/S03-A directory');
    expect(fs.existsSync(targetDir)).toBe(false);
    expect(fs.existsSync(path.join(root, '.proofloop'))).toBe(false);
    expect(fs.readdirSync(outside).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('fails closed before scaffolding when projectRoot is missing', () => {
    const root = fixtureRoot();
    const targetDir = tasksReceiptDir(root, 'S03', 'S03-A');

    const result = runReceiptAdmission({
      ...inputFor(root, 'missing-project-root'),
      projectRoot: undefined,
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('fails closed when K2 directory capability is unsupported, without an outside Receipt', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-capability-outside-'));
    cleanups.push(outside);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'unsupported' });
    try {
      const result = runReceiptAdmission(
        inputFor(root, 'unsupported-capability', {
          targetDir: tasksReceiptDir(root, 'S03', 'S03-A'),
        }),
      );

      expect(result.accepted).toBe(false);
      expect(result.receipt_ref).toBeNull();
      expect(result.findings[0]?.message).toContain('unsupported platform');
      expect(fs.readdirSync(outside).filter((name) => name.endsWith('.json'))).toHaveLength(0);
      expect(fs.existsSync(path.join(root, '.proofloop'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('rejects a tempDir outside the root before any Receipt write', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-temp-outside-'));
    cleanups.push(outside);

    const result = runReceiptAdmission(
      inputFor(root, 'temp-outside', { tempDir: outside }),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(fs.readdirSync(outside).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('rejects a tempDir symlink alias and a different-directory identity before writing', () => {
    const root = fixtureRoot();
    const targetDir = tasksReceiptDir(root, 'S03', 'S03-A');
    fs.mkdirSync(targetDir, { recursive: true });
    const tempAlias = path.join(root, 'temp-alias');
    const otherDir = path.join(root, 'other-temp');
    fs.symlinkSync(targetDir, tempAlias, 'dir');
    fs.mkdirSync(otherDir);

    const linked = runReceiptAdmission(
      inputFor(root, 'temp-symlink', { tempDir: tempAlias }),
    );
    const different = runReceiptAdmission(
      inputFor(root, 'temp-identity', { tempDir: otherDir }),
    );

    expect(linked.accepted).toBe(false);
    expect(different.accepted).toBe(false);
    expect(fs.readdirSync(targetDir).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('rejects a target-directory symlink swap after K2 binding without writing outside', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-target-swap-outside-'));
    cleanups.push(outside);
    const targetDir = tasksReceiptDir(root, 'S03', 'S03-A');
    const savedTarget = `${targetDir}.saved`;
    let swapped = false;

    let result: AdmitResult;
    try {
      result = runReceiptAdmission(
        inputFor(root, 'target-swap', {
          beforeWrite: () => {
            fs.renameSync(targetDir, savedTarget);
            fs.symlinkSync(outside, targetDir, 'dir');
            swapped = true;
          },
        }),
      );
    } finally {
      try { fs.unlinkSync(targetDir); } catch { /* best-effort */ }
      try { fs.renameSync(savedTarget, targetDir); } catch { /* best-effort */ }
    }

    expect(swapped).toBe(true);
    expect(result!.accepted).toBe(false);
    expect(result!.receipt_ref).toBeNull();
    expect(fs.readdirSync(outside).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('rejects a parent-directory symlink swap after K2 binding without writing outside', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-parent-swap-outside-'));
    cleanups.push(outside);
    const targetDir = tasksReceiptDir(root, 'S03', 'S03-A');
    const parentDir = path.dirname(targetDir);
    const savedParent = `${parentDir}.saved`;
    let swapped = false;

    let result: AdmitResult;
    try {
      result = runReceiptAdmission(
        inputFor(root, 'parent-swap', {
          beforeWrite: () => {
            fs.renameSync(parentDir, savedParent);
            fs.symlinkSync(outside, parentDir, 'dir');
            swapped = true;
          },
        }),
      );
    } finally {
      try { fs.unlinkSync(parentDir); } catch { /* best-effort */ }
      try { fs.renameSync(savedParent, parentDir); } catch { /* best-effort */ }
    }

    expect(swapped).toBe(true);
    expect(result!.accepted).toBe(false);
    expect(result!.receipt_ref).toBeNull();
    expect(fs.readdirSync(outside).filter((name) => name.endsWith('.json'))).toHaveLength(0);
  });

  it('uses the writer-time file binding and never deletes a content-identical competitor replacement', () => {
    const root = fixtureRoot();
    const input = inputFor(root, 'writer-time-competitor');
    const fault: BoundedFault = {
      mode: 'writer-time-competitor',
      targetDir: input.targetDir,
      injected: false,
    };
    boundedFault = fault;

    const result = runReceiptAdmission(input);

    expect(fault.injected).toBe(true);
    expect(fault.finalPath).toBeDefined();
    expect(fault.movedPath).toBeDefined();
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.message).toMatch(/writer-time|identity/i);
    expect(fs.existsSync(fault.finalPath as string)).toBe(true);
    expect(fs.existsSync(fault.movedPath as string)).toBe(true);
  });

  it('fails closed and retains the Receipt when a malformed successor blocks tip verification', () => {
    const root = fixtureRoot();
    const input = inputFor(root, 'malformed-successor');
    const fault: BoundedFault = {
      mode: 'malformed-successor',
      targetDir: input.targetDir,
      injected: false,
    };
    boundedFault = fault;

    const result = runReceiptAdmission(input);
    const malformed = path.join(input.targetDir, 'malformed-successor.json');

    expect(fault.injected).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.message).toMatch(/safely read|residual|malformed|JSON/i);
    expect(fs.existsSync(fault.finalPath as string)).toBe(true);
    expect(fs.existsSync(malformed)).toBe(true);
  });

  it('fails closed and retains the Receipt when a symlink successor is present', () => {
    const root = fixtureRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-worker-symlink-successor-'));
    cleanups.push(outside);
    const input = inputFor(root, 'symlink-successor');
    const fault: BoundedFault = {
      mode: 'symlink-successor',
      targetDir: input.targetDir,
      outside,
      injected: false,
    };
    boundedFault = fault;

    const result = runReceiptAdmission(input);
    const successor = path.join(input.targetDir, 'symlink-successor.json');
    const bait = path.join(outside, 'symlink-successor-bait');

    expect(fault.injected).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings).toHaveLength(2);
    expect(result.findings[1]?.message).toMatch(/symlink|safely|residual/i);
    expect(fs.lstatSync(successor).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(bait, 'utf8')).toBe('outside-bait\n');
    expect(fs.existsSync(fault.finalPath as string)).toBe(true);
  });

  it('preserves K1 post-install failure honesty and does not guess-delete its residual competitor', () => {
    const root = fixtureRoot();
    const input = inputFor(root, 'post-install-failure');
    const fault: BoundedFault = {
      mode: 'post-install-competitor',
      targetDir: input.targetDir,
      injected: false,
    };
    boundedFault = fault;

    const result = runReceiptAdmission(input);

    expect(fault.injected).toBe(true);
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.message).toMatch(/persisted|cleanup|post-install/i);
    expect(fs.readFileSync(fault.finalPath as string, 'utf8')).toBe(
      'bounded-competitor-entry\n',
    );
    expect(fs.existsSync(fault.movedPath as string)).toBe(true);
  });
});
