import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ProjectState, StageState } from '@proofloop/kernel';
import { admitSliceCommit } from '@proofloop/runtime';
import { admitVNextSliceCommit } from './vnext/commit-admission';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('Slice Commit v1/vNext route selection', () => {
  it('keeps an explicit v1 Manifest on the legacy reconcile boundary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-slice-commit-route-'));
    roots.push(root);
    const manifestPath = path.join(root, '.proofloop', 'manifests', 'S04.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1 }), 'utf8');

    let reconcileCalls = 0;
    const result = admitSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: 'a'.repeat(40),
      cvReceiptDigest: 'b'.repeat(64),
    }, {
      projectRoot: root,
      reconcile: () => {
        reconcileCalls += 1;
        return {
          stage_id: 'S04',
          slices: [],
          stage_state: StageState.EXECUTING,
          project_state: ProjectState.IN_PROGRESS,
          receipt_chain: [],
          findings: [],
          receipt_chain_valid: true,
          receipt_categories: [],
        };
      },
    });

    expect(reconcileCalls).toBe(1);
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts'))).toBe(false);
  });

  it('rejects a non-vNext Manifest before the direct vNext writer seam', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'non-vnext-slice-commit-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    const manifestPath = path.join(root, '.proofloop', 'manifests', 'S04.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ version: 1 }), 'utf8');

    let writerCalls = 0;
    const result = admitVNextSliceCommit({
      type: 'slice_commit',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: 'a'.repeat(40),
      cvReceiptDigest: 'b'.repeat(64),
    }, {
      projectRoot: root,
      writer: {
        write: () => {
          writerCalls += 1;
          throw new Error('vNext writer must not be called for a v1 Manifest');
        },
        verifyChain: () => ({ valid: true, receipts: [] }),
      },
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(writerCalls).toBe(0);
    expect(fs.existsSync(path.join(root, '.proofloop', 'receipts'))).toBe(false);
  });
});
