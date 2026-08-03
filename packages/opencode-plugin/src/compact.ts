/**
 * @proofloop/opencode-plugin — compact renderer (AWI-003 / FR-012).
 *
 * S01-C-T02: projects a T01 ToolResult into the budgeted compact view.
 *
 * Hard budgets are the independent PRD FR-012 constants:
 *   - status  ≤ 1000 UTF-16 characters (STATUS_BUDGET)
 *   - next    ≤ 1500 UTF-16 characters (NEXT_BUDGET)
 *   - findings ≤ 20 canonical Findings   (FINDINGS_BUDGET)
 *   - Receipt projection is exactly { ref, digest }
 *
 * Overlong input is truncated with a truncation marker plus a traceable
 * reference to the diagnostic log channel (logRef = `log:<service>`), where
 * the FULL diagnostics are always emitted through the injected logger adapter.
 * The log body never leaks back into the compact result. Receipt refs are
 * re-projected through T01's `projectReceiptRef`, so every ref keeps exactly
 * the { ref, digest } keys and the full Receipt payload never surfaces.
 *
 * No new Finding codes, Receipt semantics, or flow state are introduced.
 */

import type { ValidatedFinding } from '@proofloop/runtime';
import type { LoggerAdapter } from './adapters/logger.js';
import type { ReceiptRef, ToolResult } from './tool-result.js';
import { projectReceiptRef } from './tool-result.js';

/** Status summary budget (PRD FR-012: ≤ 1000 UTF-16 characters). */
export const STATUS_BUDGET = 1000;

/** Next-action budget (PRD FR-012: ≤ 1500 UTF-16 characters). */
export const NEXT_BUDGET = 1500;

/** Findings count budget (PRD FR-012: ≤ 20). */
export const FINDINGS_BUDGET = 20;

/**
 * Serialize `data` for a stable single-line `Data:` output (CV
 * S02-B-RECHECK-PO02-DATA-LINE).
 *
 * `JSON.stringify` emits U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
 * SEPARATOR) RAW — they are legal JSON string characters but are line
 * terminators for JS regex `.`/`$`, so a single-line regex extractor
 * (`/^Data: (.+)$/m`) truncates at them and `JSON.parse` fails on the
 * truncated fragment. Escaping them as `\u2028` / `\u2029` keeps the output
 * on one line AND round-trips: `JSON.parse` decodes the escape back to the
 * original character, so a parity deep-equal is unaffected.
 */
export function serializeStructuredData(data: unknown): string {
  return JSON.stringify(data)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Marker appended to a field that hit its budget and was truncated. */
export const TRUNCATION_MARKER = '…[truncated]';

/** Fields that can hit a compact budget. */
export type CompactField = 'status' | 'next' | 'findings';

/** Input to the compact renderer: the T01 ToolResult + full render text. */
export interface CompactRenderInput {
  /** The T01-shaped ToolResult (findings/refs/runtime come from here). */
  result: ToolResult;
  /** Full status text before compact budgeting. */
  status: string;
  /** Full next-action text before compact budgeting. */
  next: string;
}

/** Renderer dependencies. */
export interface CompactRenderDeps {
  /** Logger adapter; the renderer emits full diagnostics here. */
  logger: LoggerAdapter;
}

/** Budgeted compact view produced by the public renderer. */
export interface CompactView {
  /** Status summary, ≤ STATUS_BUDGET UTF-16 characters. */
  status: string;
  /** Next-action text, ≤ NEXT_BUDGET UTF-16 characters. */
  next: string;
  /** Canonical Findings, ≤ FINDINGS_BUDGET entries. */
  findings: readonly ValidatedFinding[];
  /** Receipt projections, exactly { ref, digest } each. */
  refs: readonly ReceiptRef[];
  /** Fields that hit a budget and were truncated. */
  truncated: readonly CompactField[];
  /** Traceable reference to the diagnostic log channel (full content lives there). */
  logRef: string;
}

/**
 * Traceable reference to the diagnostic log channel.
 *
 * The renderer always emits the FULL diagnostics through the logger adapter;
 * any truncated field points back to this channel so the full content remains
 * recoverable (FR-012 traceability).
 *
 * S1-F-002 (OUT-S1-05): when the logger persists diagnostics to
 * `.proofloop/logs/` (`LoggerAdapter.logRef`), the returned ref is that
 * traceable FILE ref (e.g. `.proofloop/logs/doctor-<timestamp>.log`) so the
 * compact output can point at the persisted full log. Without file persistence
 * the ref falls back to the host log channel `log:<service>`.
 *
 * Accepts either the service name string (legacy call shape) or the whole
 * logger adapter (preferred — carries the persisted file ref when available).
 */
export function diagnosticLogRef(ref: string | LoggerAdapter): string {
  if (typeof ref === 'string') {
    return `log:${ref}`;
  }
  return ref.logRef ?? `log:${ref.service}`;
}

/**
 * Truncate `text` to at most `maxUnits` UTF-16 code units without splitting a
 * surrogate pair. A returned string therefore has length ≤ `maxUnits` and
 * never ends with a dangling high surrogate.
 */
function truncateUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) {
    return text;
  }
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    // `end - 1` is the high surrogate of a pair; back up so the pair is
    // dropped whole instead of leaving a lone high surrogate.
    end -= 1;
  }
  return text.slice(0, end);
}

/** Result of applying a character budget to a text field. */
interface CappedText {
  value: string;
  truncated: boolean;
}

/**
 * Cap `text` to `budget` UTF-16 characters. When the text exceeds the budget,
 * keep the longest prefix that fits together with the truncation marker and
 * the traceable log ref; the total is guaranteed ≤ `budget`.
 */
function capText(text: string, budget: number, logRef: string): CappedText {
  if (text.length <= budget) {
    return { value: text, truncated: false };
  }
  const suffix = `${TRUNCATION_MARKER} (full: ${logRef})`;
  const keptUnits = Math.max(0, budget - suffix.length);
  const kept = truncateUtf16(text, keptUnits);
  return { value: `${kept}${suffix}`, truncated: true };
}

/**
 * Project a T01 ToolResult into the budgeted compact view.
 *
 * Budgets are enforced on the public output: status/next are capped, findings
 * are capped at FINDINGS_BUDGET, and every Receipt ref is re-projected to
 * exactly { ref, digest }. The full diagnostics (full status/next and ALL
 * findings) are always emitted through the injected logger adapter; the
 * compact view never carries the log body back.
 */
export function renderCompact(
  input: CompactRenderInput,
  deps: CompactRenderDeps,
): CompactView {
  const logRef = diagnosticLogRef(deps.logger);
  const status = capText(input.status, STATUS_BUDGET, logRef);
  const next = capText(input.next, NEXT_BUDGET, logRef);

  const truncated: CompactField[] = [];
  if (status.truncated) truncated.push('status');
  if (next.truncated) truncated.push('next');

  const allFindings = input.result.findings;
  const findings =
    allFindings.length > FINDINGS_BUDGET
      ? allFindings.slice(0, FINDINGS_BUDGET)
      : allFindings;
  if (allFindings.length > FINDINGS_BUDGET) truncated.push('findings');

  // Defensive re-projection through T01's projectReceiptRef: even if a ref
  // carried extra keys, the compact output is exactly { ref, digest }.
  const refs = input.result.refs.map((r) =>
    projectReceiptRef(r.ref, { digest: r.digest }),
  );

  // Full diagnostics always go to the logger — never back into the compact
  // result (PO-S01-C-05 logging separation, FR-012 traceability).
  deps.logger.info('compact render: full diagnostics', {
    ok: input.result.ok,
    status: input.status,
    next: input.next,
    findings: allFindings,
    refs: input.result.refs,
    truncated,
  });

  return {
    status: status.value,
    next: next.value,
    findings,
    refs,
    truncated,
    logRef,
  };
}
