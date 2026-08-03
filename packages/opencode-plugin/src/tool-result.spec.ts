/**
 * @proofloop/opencode-plugin — unified ToolResult contract spec (AWI-003).
 *
 * PO: PO-S01-C-04
 *
 * S01-C-T01 locks the canonical result shape shared by every plugin tool:
 * `{ ok, data?, findings, refs, runtime }`. Findings reuse the kernel Finding
 * shape and are verified against the REAL kernel validator re-exported by
 * `@proofloop/runtime` (`validateFinding`) — the kernel closed set of Finding
 * codes is the authoritative oracle. refs are a `{ ref, digest }` projection
 * that never leaks the full Receipt payload. The fail-closed error mapping
 * boundary turns any thrown error or structured condition into `ok:false`
 * plus a canonical Finding — a bare exception must never leak into a
 * ToolResult.
 *
 * The compact budget enforcement (status ≤ 1000 / next ≤ 1500 / findings ≤ 20)
 * is S01-C-T02 scope and intentionally not asserted here.
 *
 * S01-C-T02 additions: the compact renderer (`compact.ts`) projects the T01
 * ToolResult into a budgeted view. Hard budgets are the independent PRD FR-012
 * constants (status ≤ 1000 / next ≤ 1500 / findings ≤ 20); overlong input is
 * truncated with a truncation marker + traceable log ref, findings are capped
 * at 20, Receipts stay a { ref, digest } projection, and the full diagnostics
 * are emitted through the logger adapter (never stuffed back into the compact
 * result).
 */

import { describe, expect, it } from 'vitest';
import { SchemaValidationError, validateFinding } from '@proofloop/runtime';
import type { Finding, Receipt } from '@proofloop/kernel';
import type { ValidatedFinding } from '@proofloop/runtime';
import {
  UNKNOWN_RUNTIME_METADATA,
  projectReceiptRef,
  successResult,
  toErrorResult,
} from './tool-result.js';
import {
  FINDINGS_BUDGET,
  NEXT_BUDGET,
  STATUS_BUDGET,
  TRUNCATION_MARKER,
  diagnosticLogRef,
  renderCompact,
} from './compact.js';
import {
  createLoggerAdapter,
  type HostLogBody,
} from './adapters/logger.js';

describe('ToolResult shape (PO-S01-C-04)', () => {
  it('exposes the fixed envelope { ok, data?, findings, refs, runtime }', () => {
    const result = successResult({
      data: { version: { runtime: '0.1.0', plugin: '0.1.0' } },
      findings: [
        { code: 'RUNTIME.VERSION_MISMATCH', severity: 'warn', message: 'stale' },
      ],
      refs: [
        { ref: '.proofloop/receipts/cv/S1/latest.json', digest: 'abc123' },
      ],
      runtime: { runtimeVersion: '0.1.0', pluginVersion: '0.1.0', schemaVersion: 1 },
    });

    expect(result.ok).toBe(true);
    expect(typeof result.ok).toBe('boolean');
    expect(result.data).toEqual({ version: { runtime: '0.1.0', plugin: '0.1.0' } });
    expect(Array.isArray(result.findings)).toBe(true);
    expect(Array.isArray(result.refs)).toBe(true);
    expect(result.runtime).toEqual({
      runtimeVersion: '0.1.0',
      pluginVersion: '0.1.0',
      schemaVersion: 1,
    });
  });

  it('makes data optional and absent when not provided', () => {
    const result = successResult({ runtime: UNKNOWN_RUNTIME_METADATA });
    expect(result.ok).toBe(true);
    expect('data' in result).toBe(false);
  });

  it('findings elements conform to the kernel Finding shape (real validateFinding oracle)', () => {
    const result = successResult({
      findings: [
        { code: 'HOST.PROJECT_NOT_TRUSTED', severity: 'error', message: 'not a proofloop project' },
        { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'warn', message: 'field missing' },
      ],
      runtime: UNKNOWN_RUNTIME_METADATA,
    });

    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      // The REAL kernel validator is the oracle: a Finding that fails it is
      // not a canonical Finding (closed code set / closed severity / non-empty
      // message).
      expect(() => validateFinding(finding)).not.toThrow();
      expect(finding.message.length).toBeGreaterThan(0);
    }
  });

  it('refuses to build a result carrying a non-kernel Finding code', () => {
    const bogus = {
      code: 'NOT.A.KERNEL.CODE',
      severity: 'error',
      message: 'x',
    } as unknown as ValidatedFinding;

    expect(() =>
      successResult({ findings: [bogus], runtime: UNKNOWN_RUNTIME_METADATA }),
    ).toThrow(SchemaValidationError);
  });
});

describe('fail-closed error mapping boundary (PO-S01-C-04 / PO-S01-C-03)', () => {
  it('maps a kernel SchemaValidationError to ok:false with a canonical Finding (no bare throw)', () => {
    const error = new SchemaValidationError('bad finding', [
      { path: '.code', message: 'not a known code' },
    ]);

    const result = toErrorResult(error);

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(finding.severity).toBe('error');
    expect(finding.message.length).toBeGreaterThan(0);
    expect(() => validateFinding(finding)).not.toThrow();
  });

  it('maps a generic thrown Error to ok:false with a canonical Finding', () => {
    const result = toErrorResult(new Error('boom'));

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(() => validateFinding(result.findings[0])).not.toThrow();
  });

  it('maps a non-Error thrown value to ok:false with a canonical Finding', () => {
    const result = toErrorResult('not an error object');

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(() => validateFinding(result.findings[0])).not.toThrow();
  });

  it('never invents a Finding code outside the kernel closed set', () => {
    const kernelClosedSet = [
      'HOST.PROJECT_NOT_TRUSTED',
      'HOST.PATH_PROTECTED',
      'HOST.TOOL_NOT_ACTIVE',
      'HOST.PATH_OUTSIDE_PROJECT',
      'RUNTIME.VERSION_MISMATCH',
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      'RUNTIME.SCHEMA_MISMATCH',
      'DOMAIN.STAGE_NOT_FOUND',
      'DOMAIN.INVALID_TRANSITION',
    ];

    for (const failure of [new Error('a'), new SchemaValidationError('b', []), 'c', 42]) {
      const code = toErrorResult(failure).findings[0].code;
      expect(kernelClosedSet).toContain(code);
    }
  });

  it('maps a structured condition (canonical findings) to ok:false without inventing codes', () => {
    const findings: Finding[] = [
      { code: 'RUNTIME.VERSION_MISMATCH', severity: 'error', message: 'runtime 0.2.0 != 0.1.0' },
    ];

    const result = toErrorResult(findings);

    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(findings);
    for (const finding of result.findings) {
      expect(() => validateFinding(finding)).not.toThrow();
    }
  });

  it('fails a structured condition closed when it contains a non-canonical Finding (kernel oracle)', () => {
    const bogus = [
      {
        code: 'NOT.A.KERNEL.CODE',
        severity: 'error',
        message: 'x',
      } as unknown as ValidatedFinding,
    ];

    const result = toErrorResult(bogus);

    // The kernel closed set is authoritative: a malformed condition must never
    // surface raw — it fails closed to a canonical Finding.
    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(() => validateFinding(result.findings[0])).not.toThrow();
  });

  it('fails an empty structured condition closed to a canonical Finding', () => {
    const result = toErrorResult([]);

    expect(result.ok).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(() => validateFinding(result.findings[0])).not.toThrow();
  });

  it('defaults error results to empty refs and the unknown runtime metadata sentinel', () => {
    const result = toErrorResult(new Error('x'));

    expect(result.ok).toBe(false);
    expect(result.refs).toEqual([]);
    expect(result.runtime).toEqual(UNKNOWN_RUNTIME_METADATA);
  });

  it('accepts refs/runtime context on the error boundary when known', () => {
    const result = toErrorResult(new Error('x'), {
      refs: [{ ref: 'r', digest: 'd' }],
      runtime: { runtimeVersion: '0.1.0', pluginVersion: '0.1.0', schemaVersion: 1 },
    });

    expect(result.ok).toBe(false);
    expect(result.refs).toEqual([{ ref: 'r', digest: 'd' }]);
    expect(result.runtime.schemaVersion).toBe(1);
  });
});

describe('receipt ref projection (PO-S01-C-04)', () => {
  it('projects a full kernel Receipt to { ref, digest } only — no payload leakage', () => {
    const fullReceipt: Receipt = {
      version: 1,
      type: 'CV_PASS',
      stage_id: 'S1',
      slice_id: 'S01-C',
      timestamp: '2026-08-02T00:00:00.000Z',
      digest: '0123456789abcdef',
      previous_digest: 'fedcba9876543210',
      payload: { verdict: 'PASS', notes: 'secret log body must not leak' },
      signature: 'sig',
    };

    const projected = projectReceiptRef(
      '.proofloop/receipts/cv/S1/cv-pass.json',
      fullReceipt,
    );

    expect(projected).toEqual({
      ref: '.proofloop/receipts/cv/S1/cv-pass.json',
      digest: '0123456789abcdef',
    });
    expect(Object.keys(projected)).toEqual(['ref', 'digest']);
  });

  it('keeps every ref in a ToolResult to exactly ref+digest keys', () => {
    const result = successResult({
      refs: [
        projectReceiptRef('r1', { digest: 'd1' }),
        projectReceiptRef('r2', { digest: 'd2' }),
      ],
      runtime: UNKNOWN_RUNTIME_METADATA,
    });

    expect(result.refs).toEqual([
      { ref: 'r1', digest: 'd1' },
      { ref: 'r2', digest: 'd2' },
    ]);
    for (const ref of result.refs) {
      expect(Object.keys(ref).sort()).toEqual(['digest', 'ref']);
    }
  });
});

describe('compact renderer budgets (PO-S01-C-04)', () => {
  function spyLogger() {
    const bodies: HostLogBody[] = [];
    const logger = createLoggerAdapter((options) => {
      bodies.push(options.body);
      return undefined;
    }, 'test-service');
    return { logger, bodies };
  }

  it('binds the hard budgets to the independent PRD FR-012 constants', () => {
    // Oracle: PRD FR-012 / AWI-003 declare status ≤1000, next ≤1500, findings ≤20.
    expect(STATUS_BUDGET).toBe(1000);
    expect(NEXT_BUDGET).toBe(1500);
    expect(FINDINGS_BUDGET).toBe(20);
  });

  it('keeps within-budget status/next unchanged and reports no truncation', () => {
    const { logger } = spyLogger();
    const result = successResult({ runtime: UNKNOWN_RUNTIME_METADATA });

    const view = renderCompact({ result, status: 'all good', next: 'run CV' }, { logger });

    expect(view.status).toBe('all good');
    expect(view.next).toBe('run CV');
    expect(view.truncated).toEqual([]);
  });

  it('truncates an overlong status to ≤1000 UTF-16 chars and keeps a traceable log ref', () => {
    const { logger } = spyLogger();
    const overlong = 'status '.repeat(300); // 1800 UTF-16 code units > 1000
    const result = successResult({ runtime: UNKNOWN_RUNTIME_METADATA });

    const view = renderCompact({ result, status: overlong, next: 'short' }, { logger });

    expect(view.status.length).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(view.status).toContain(TRUNCATION_MARKER);
    expect(view.status).toContain(diagnosticLogRef(logger.service));
    expect(view.truncated).toContain('status');
    // The compact result must not carry the full original text.
    expect(view.status).not.toContain(overlong.slice(0, 1200));
  });

  it('truncates an overlong next to ≤1500 UTF-16 chars and keeps a traceable log ref', () => {
    const { logger } = spyLogger();
    const overlong = 'next '.repeat(400); // 2000 UTF-16 code units > 1500
    const result = successResult({ runtime: UNKNOWN_RUNTIME_METADATA });

    const view = renderCompact({ result, status: 'short', next: overlong }, { logger });

    expect(view.next.length).toBeLessThanOrEqual(NEXT_BUDGET);
    expect(view.next).toContain(TRUNCATION_MARKER);
    expect(view.next).toContain(diagnosticLogRef(logger.service));
    expect(view.truncated).toContain('next');
  });

  it('measures length in UTF-16 code units and never splits a surrogate pair', () => {
    const { logger } = spyLogger();
    const emoji = '😀'; // 2 UTF-16 code units
    const overlong = emoji.repeat(600); // 1200 units > 1000
    const result = successResult({ runtime: UNKNOWN_RUNTIME_METADATA });

    const view = renderCompact({ result, status: overlong, next: 'n' }, { logger });

    expect(view.status.length).toBeLessThanOrEqual(STATUS_BUDGET);
    for (let i = 0; i < view.status.length; i += 1) {
      const unit = view.status.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const nextUnit = view.status.charCodeAt(i + 1);
        expect(nextUnit).toBeGreaterThanOrEqual(0xdc00);
        expect(nextUnit).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  it('caps findings at 20 and preserves the log ref for the truncated tail', () => {
    const { logger } = spyLogger();
    const codes: ValidatedFinding['code'][] = [
      'HOST.TOOL_NOT_ACTIVE',
      'RUNTIME.VERSION_MISMATCH',
      'RUNTIME.SCHEMA_MISMATCH',
      'HOST.PATH_PROTECTED',
      'DOMAIN.STAGE_NOT_FOUND',
    ];
    const manyFindings = Array.from({ length: 25 }, (_, i) => ({
      code: codes[i % codes.length]!,
      severity: 'warn' as const,
      message: `finding ${i}`,
    }));
    const result = successResult({
      findings: manyFindings,
      runtime: UNKNOWN_RUNTIME_METADATA,
    });

    const view = renderCompact({ result, status: 's', next: 'n' }, { logger });

    expect(view.findings.length).toBe(FINDINGS_BUDGET);
    expect(view.findings[0].message).toBe('finding 0');
    expect(view.findings[19].message).toBe('finding 19');
    expect(view.findings.some((f) => f.message === 'finding 24')).toBe(false);
    expect(view.truncated).toContain('findings');
  });

  it('preserves every receipt ref+digest through truncation and never leaks the payload', () => {
    const { logger } = spyLogger();
    const fullReceipt: Receipt = {
      version: 1,
      type: 'CV_PASS',
      stage_id: 'S1',
      slice_id: 'S01-C',
      timestamp: '2026-08-02T00:00:00.000Z',
      digest: 'aa11bb22cc33',
      payload: { verdict: 'PASS', notes: 'must not leak' },
    };
    const result = successResult({
      refs: [
        projectReceiptRef('.proofloop/receipts/cv/S1/a.json', fullReceipt),
        { ref: '.proofloop/receipts/cv/S1/b.json', digest: 'dd44ee55ff66' },
      ],
      runtime: UNKNOWN_RUNTIME_METADATA,
    });
    const overlong = 'x'.repeat(2000);

    const view = renderCompact({ result, status: overlong, next: overlong }, { logger });

    expect(view.refs).toEqual([
      { ref: '.proofloop/receipts/cv/S1/a.json', digest: 'aa11bb22cc33' },
      { ref: '.proofloop/receipts/cv/S1/b.json', digest: 'dd44ee55ff66' },
    ]);
    for (const ref of view.refs) {
      expect(Object.keys(ref).sort()).toEqual(['digest', 'ref']);
    }
  });

  it('emits the full diagnostics to the logger while keeping the log body out of the compact result', () => {
    const { logger, bodies } = spyLogger();
    const overlongStatus = 'diagnostic line '.repeat(150); // 2550 UTF-16 units
    const manyFindings = Array.from({ length: 25 }, (_, i) => ({
      code: 'RUNTIME.SCHEMA_MISMATCH' as const,
      severity: 'warn' as const,
      message: `finding ${i}`,
    }));
    const result = successResult({
      findings: manyFindings,
      runtime: UNKNOWN_RUNTIME_METADATA,
    });

    const view = renderCompact({ result, status: overlongStatus, next: 'next' }, { logger });

    // The logger received the FULL status text and the full findings list.
    const logCall = bodies.find((b) => b.extra?.status === overlongStatus);
    expect(logCall).toBeDefined();
    expect(logCall?.extra?.findings).toHaveLength(25);
    expect(logCall?.extra?.next).toBe('next');

    // The compact result is truncated and never carries the log body.
    expect(view.status.length).toBeLessThanOrEqual(STATUS_BUDGET);
    expect(view.status).not.toContain(overlongStatus);
    expect(view.findings.some((f) => f.message === 'finding 24')).toBe(false);
  });
});
