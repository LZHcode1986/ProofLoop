/**
 * update-current-cv-status.ts
 *
 * Updates the `## Current CV Status` section in a Slice Evidence markdown file
 * based on the current CV lifecycle state.
 *
 * Rules:
 * - Only modifies the `## Current CV Status` section (and its subsection lines).
 * - Refuses to operate if the section is missing (fail-closed).
 * - Does NOT modify Task Evidence, Slice Context, or any other section.
 * - CV REPAIR → sets open finding + status
 * - Repair → PENDING_RECHECK → clears old finding
 * - PASS → clears finding and points to latest receipt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CvReceipt, CvLifecycleState, CvVerdict } from './schemas.js';
import { CvReceipt as CvReceiptSchema } from './schemas.js';

// ── CV lifecycle status enum ──────────────────────────────────────────────────

/**
 * The only valid CV statuses for the `## Current CV Status` section.
 * All other values are rejected.
 */
export const VALID_CV_LIFECYCLE_STATUSES = [
  'NOT_RUN', 'READY_FOR_CV', 'CV_VERIFYING', 'CV_REPAIR_REQUIRED',
  'CV_REPLAN_REQUIRED', 'CV_BLOCKED', 'CV_ESCALATION_REQUIRED', 'CV_PASS',
  'SLICE_COMPLETE',
  // Compatibility values accepted when migrating old evidence. Legacy routed
  // verdict strings are intentionally rejected.
  'PENDING_RECHECK', 'PASS', 'REPAIR',
] as const;

export type CvLifecycleStatus = typeof VALID_CV_LIFECYCLE_STATUSES[number];

const LIFECYCLE_VERDICT: Partial<Record<CvLifecycleStatus, CvVerdict>> = {
  CV_PASS: 'PASS', CV_REPAIR_REQUIRED: 'REPAIR', CV_REPLAN_REQUIRED: 'REPLAN',
  CV_BLOCKED: 'BLOCKED', CV_ESCALATION_REQUIRED: 'ESCALATION_REQUIRED',
  PASS: 'PASS', REPAIR: 'REPAIR', PENDING_RECHECK: 'REPAIR',
};
const isCanonicalRoutedStatus = (status: CvLifecycleStatus): boolean =>
  status.startsWith('CV_') && status !== 'CV_VERIFYING';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UpdateCvStatusOptions {
  /** Path to the Slice Evidence markdown file. */
  evidencePath: string;
  /** The new CV status value (must be a valid CV lifecycle status). */
  status: CvLifecycleStatus;
  /** The stage ID for canonical evidence path verification. */
  stageId: string;
  /** The slice ID for canonical evidence path verification. */
  sliceId: string;
  /** The project/delivery root directory for canonical path resolution. */
  deliveryRoot: string;
  /** The CV level (lite/standard/enhanced) — required for PASS/REPAIR/PENDING_RECHECK. */
  cvLevel?: string;
  /** Path to the latest CV receipt (required for PASS/REPAIR/PENDING_RECHECK). */
  latestReceiptPath?: string;
  /** Open finding description, if any (e.g. for REPAIR). */
  openFinding?: string;
}

export interface UpdateCvStatusResult {
  /** Whether the update succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
  /** Whether the file was modified. */
  modified: boolean;
}

// ── CV Status section parsing ────────────────────────────────────────────────

/**
 * Find the start and end indices of the `## Current CV Status` section.
 *
 * The section starts at the `## Current CV Status` heading (start of line)
 * and ends at the next `## ` heading or end of file, whichever comes first.
 * Returns null if the heading is not found.
 */
function findCvStatusSection(content: string): { start: number; end: number; body: string } | null {
  const lines = content.split('\n');
  let headingIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '## Current CV Status') {
      headingIdx = i;
      break;
    }
  }

  if (headingIdx === -1) return null;

  // Find end: next `## ` heading or end of file
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) {
      endIdx = i;
      break;
    }
  }

  // Calculate character positions
  let start = 0;
  for (let i = 0; i < headingIdx; i++) {
    start += lines[i].length + 1; // +1 for the newline
  }

  let end = start;
  for (let i = headingIdx; i < endIdx; i++) {
    end += lines[i].length + 1;
  }

  // Body is lines after heading (headingIdx+1 to endIdx-1), joined
  const bodyLines = lines.slice(headingIdx + 1, endIdx);
  const body = bodyLines.join('\n');

  return { start, end, body };
}

// ── Main function ──────────────────────────────────────────────────────────────

/**
 * Update the `## Current CV Status` section in a Slice Evidence file.
 *
 * If the section is missing, returns an error (fail-closed).
 * Only modifies lines that have a matching prefix; other lines are preserved.
 *
 * Security: Requires stageId, sliceId, and deliveryRoot to verify the evidence
 * path resolves to the canonical Manifest-declared location. Rejects arbitrary
 * filesystem targets and symlink-based traversal.
 */
export function updateCurrentCvStatus(options: UpdateCvStatusOptions): UpdateCvStatusResult {
  const { evidencePath, status, stageId, sliceId, deliveryRoot, cvLevel, latestReceiptPath, openFinding } = options;

  // ── Validate status is a known lifecycle status ──
  if (!(VALID_CV_LIFECYCLE_STATUSES as readonly string[]).includes(status)) {
    return {
      success: false,
      error: `Invalid CV status: "${status}". Must be one of: ${VALID_CV_LIFECYCLE_STATUSES.join(', ')}`,
      modified: false,
    };
  }

  // ── Canonical path verification ──
  // Verify the evidence path resolves to the expected canonical location
  // delivery/stages/<stageId>/evidence/<sliceId>.md
  //
  // The deliveryRoot parameter is a trusted boundary; system symlinks that
  // resolve at or above it (e.g. macOS /var -> /private/var) are accepted.
  // Any symlink strictly below the deliveryRoot remains forbidden.
  const resolvedDeliveryRoot = path.resolve(deliveryRoot);
  const realRoot = fs.realpathSync(resolvedDeliveryRoot);
  const canonicalEvidencePath = path.resolve(
    resolvedDeliveryRoot,
    'delivery',
    'stages',
    stageId,
    'evidence',
    `${sliceId}.md`,
  );
  const realCanonicalEvidencePath = path.resolve(
    realRoot,
    'delivery',
    'stages',
    stageId,
    'evidence',
    `${sliceId}.md`,
  );
  const resolvedEvidencePath = path.resolve(evidencePath);

  // Check every existing ancestor directory for symlinks that are strictly
  // *below* the deliveryRoot.  Any symlink below the trusted boundary is
  // rejected regardless of where its target resolves.  Symlinks at or above
  // the trusted deliveryRoot boundary (e.g. macOS /var -> /private/var) are
  // accepted because the ancestor walk stops at the deliveryRoot.
  let current = resolvedEvidencePath;
  while (current.length > resolvedDeliveryRoot.length) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        return {
          success: false,
          error: `Evidence path component "${current}" is a symlink below the trusted delivery root. Rejected.`,
          modified: false,
        };
      }
    } catch {
      // Path component doesn't exist — continue checking existing parents
    }
    const parent = path.dirname(current);
    if (parent === current || parent.length <= resolvedDeliveryRoot.length) break;
    current = parent;
  }

  // Compare paths in their real-root-resolved form so that a trusted
  // deliveryRoot that goes through a system symlink (e.g. /var -> /private/var
  // on macOS) is accepted, while any symlink below the root is still caught
  // above or by the real-path mismatch below.
  let realEvidencePath: string;
  try {
    realEvidencePath = fs.realpathSync(evidencePath);
  } catch {
    realEvidencePath = resolvedEvidencePath;
  }

  if (realEvidencePath !== realCanonicalEvidencePath && resolvedEvidencePath !== canonicalEvidencePath) {
    return {
      success: false,
      error: `Evidence path "${evidencePath}" (resolved: "${resolvedEvidencePath}") ` +
        `does not match the canonical Manifest-declared path "${canonicalEvidencePath}". ` +
        `Arbitrary filesystem targets and symlinks are rejected.`,
      modified: false,
    };
  }

  // ── Receipt path validation ──
  // A lifecycle update is authorized only by an actual immutable receipt. A
  // caller-provided path (or volatile boolean) is never sufficient.
  if (latestReceiptPath) {
    const resolvedReceiptPath = path.resolve(latestReceiptPath);
    const resolvedDeliveryRoot = path.resolve(deliveryRoot);
    const realRoot = fs.realpathSync(resolvedDeliveryRoot);
    const expectedReceiptDir = path.resolve(resolvedDeliveryRoot, '.proofloop', 'receipts', 'cv', stageId, sliceId);
    const realExpectedReceiptDir = path.resolve(realRoot, '.proofloop', 'receipts', 'cv', stageId, sliceId);
    const receiptDir = path.dirname(resolvedReceiptPath);
    // Accept either the lexical canonical receipt dir or its real-root
    // canonical equivalent.  This permits a deliveryRoot that is a system
    // symlink alias (e.g. macOS /var -> /private/var) while the caller's
    // receipt path uses the real or aliased root — whichever is natural
    // for the environment.
    if (receiptDir !== expectedReceiptDir && receiptDir !== realExpectedReceiptDir) {
      return { success: false, error: `Receipt path must reside in canonical CV receipt root "${expectedReceiptDir}".`, modified: false };
    }
    const name = path.basename(resolvedReceiptPath);
    const match = /^(initial|recheck)-\d{3}\.json$/.exec(name);
    if (!match) return { success: false, error: 'CV receipt must use immutable initial-NNN.json or recheck-NNN.json naming.', modified: false };
    if (!fs.existsSync(resolvedReceiptPath)) return { success: false, error: `CV receipt does not exist: "${resolvedReceiptPath}".`, modified: false };
    try {
      // Reject symlinks in the receipt itself and in any existing parent
      // *strictly below* the deliveryRoot.  System symlinks at or above the
      // trusted deliveryRoot boundary (e.g. macOS /var -> /private/var) are
      // accepted.
      let current = resolvedReceiptPath;
      while (current.length > resolvedDeliveryRoot.length) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) return { success: false, error: 'CV receipt must be a regular immutable file, not a symlink.', modified: false };
        if (current.length <= resolvedDeliveryRoot.length) break;
        const parent = path.dirname(current);
        if (parent === current || parent.length <= resolvedDeliveryRoot.length) break;
        current = parent;
      }
      const realReceiptPath = fs.realpathSync(resolvedReceiptPath);
      const realReceiptDir = path.dirname(realReceiptPath);
      if (realReceiptDir !== realExpectedReceiptDir) {
        return { success: false, error: 'CV receipt path resolves through a symlink escaping the canonical receipt root.', modified: false };
      }
      const stat = fs.lstatSync(resolvedReceiptPath);
      if (!stat.isFile()) return { success: false, error: 'CV receipt must be a regular immutable file, not a symlink.', modified: false };
      const receipt = CvReceiptSchema.parse(JSON.parse(fs.readFileSync(resolvedReceiptPath, 'utf-8')));
      if (receipt.stage_id !== stageId) return { success: false, error: `Receipt stage_id "${receipt.stage_id}" does not match expected stage_id "${stageId}".`, modified: false };
      if (receipt.slice_id !== sliceId) return { success: false, error: `Receipt slice_id "${receipt.slice_id}" does not match expected slice_id "${sliceId}".`, modified: false };
      if (receipt.verification_type !== match[1]) return { success: false, error: `Receipt verification_type does not match filename prefix.`, modified: false };
      if (cvLevel && receipt.cv_level !== cvLevel) return { success: false, error: `Receipt cv_level "${receipt.cv_level}" does not match requested cvLevel "${cvLevel}".`, modified: false };
      const expectedVerdict = LIFECYCLE_VERDICT[status];
      if (expectedVerdict && receipt.verdict !== expectedVerdict) {
        return { success: false, error: `Receipt verdict "${receipt.verdict}" does not authorize requested status "${status}".`, modified: false };
      }
      if ((status === 'PASS' || status === 'CV_PASS') && receipt.scope_violations.length > 0) return { success: false, error: 'PASS receipt contains scope violations.', modified: false };
    } catch (err) {
      return { success: false, error: `Cannot validate CV receipt at "${resolvedReceiptPath}": ${err instanceof Error ? err.message : String(err)}`, modified: false };
    }
  }

  // ── Enforce required fields per status ──
  if (status === 'PASS' || status === 'CV_PASS') {
    if (!cvLevel) {
      return { success: false, error: 'PASS status requires cvLevel (lite/standard/enhanced).', modified: false };
    }
    if (!latestReceiptPath) {
      return { success: false, error: 'PASS status requires latestReceiptPath.', modified: false };
    }
  }
  if (status === 'REPAIR' || status === 'CV_REPAIR_REQUIRED') {
    if (!cvLevel) {
      return { success: false, error: 'REPAIR status requires cvLevel.', modified: false };
    }
    if (!latestReceiptPath) {
      return { success: false, error: 'REPAIR status requires latestReceiptPath.', modified: false };
    }
    if (!openFinding) {
      return { success: false, error: 'REPAIR status requires openFinding.', modified: false };
    }
  }
  if (status === 'PENDING_RECHECK') {
    if (!cvLevel) {
      return { success: false, error: 'PENDING_RECHECK status requires cvLevel.', modified: false };
    }
    if (!latestReceiptPath) {
      return { success: false, error: 'PENDING_RECHECK status requires latestReceiptPath.', modified: false };
    }
  }
  if (isCanonicalRoutedStatus(status)) {
    if (!cvLevel) return { success: false, error: `${status} requires cvLevel.`, modified: false };
    if (!latestReceiptPath) return { success: false, error: `${status} requires latestReceiptPath.`, modified: false };
  }

  // ── Read file ──
  let content: string;
  try {
    content = fs.readFileSync(evidencePath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: `Cannot read evidence file "${evidencePath}": ${err instanceof Error ? err.message : String(err)}`,
      modified: false,
    };
  }

  // ── Find the section ──
  const section = findCvStatusSection(content);
  if (!section) {
    return {
      success: false,
      error: `Evidence file "${evidencePath}" is missing the "## Current CV Status" section. ` +
        `Refusing to update. Initialize the evidence skeleton first.`,
      modified: false,
    };
  }

  // ── Validate required lines exist in section body ──
  // Fail closed: if caller provides a value for a field but the corresponding
  // line is missing from the section, reject the update.
  const bodyLines = section.body === '' ? [] : section.body.split('\n');

  const hasStatusLine = bodyLines.some(l => /^- Status:/.test(l));
  const hasLevelLine = bodyLines.some(l => /^- Level:/.test(l));
  const hasReceiptLine = bodyLines.some(l => /^- Latest CV Receipt:/.test(l));
  const hasFindingLine = bodyLines.some(l => /^- Open Finding:/.test(l));

  if (!hasStatusLine) {
    return {
      success: false,
      error: `Evidence file "${evidencePath}" "## Current CV Status" section is missing the "- Status:" line. ` +
        `Cannot update status to "${status}".`,
      modified: false,
    };
  }

  if (cvLevel !== undefined && !hasLevelLine) {
    return {
      success: false,
      error: `Evidence file "${evidencePath}" "## Current CV Status" section is missing the "- Level:" line. ` +
        `Cannot update level to "${cvLevel}".`,
      modified: false,
    };
  }

  if (latestReceiptPath !== undefined && !hasReceiptLine) {
    return {
      success: false,
      error: `Evidence file "${evidencePath}" "## Current CV Status" section is missing the "- Latest CV Receipt:" line. ` +
        `Cannot update receipt path.`,
      modified: false,
    };
  }

  if (openFinding !== undefined && !hasFindingLine) {
    return {
      success: false,
      error: `Evidence file "${evidencePath}" "## Current CV Status" section is missing the "- Open Finding:" line. ` +
        `Cannot update open finding.`,
      modified: false,
    };
  }

  // ── Build replacement lines ──
  const newLines: string[] = [];
  let anyChange = false;

  for (const line of bodyLines) {
    let newLine = line;

    if (/^- Status:/.test(line)) {
      const replacement = `- Status: ${status}`;
      if (newLine !== replacement) {
        newLine = replacement;
        anyChange = true;
      }
    } else if (cvLevel !== undefined && /^- Level:/.test(line)) {
      const replacement = `- Level: ${cvLevel}`;
      if (newLine !== replacement) {
        newLine = replacement;
        anyChange = true;
      }
    } else if (latestReceiptPath !== undefined && /^- Latest CV Receipt:/.test(line)) {
      const replacement = `- Latest CV Receipt: ${latestReceiptPath}`;
      if (newLine !== replacement) {
        newLine = replacement;
        anyChange = true;
      }
    } else if (openFinding !== undefined && /^- Open Finding:/.test(line)) {
      let replacement: string;
      if (openFinding === '' || openFinding === null) {
        replacement = '- Open Finding: *None*';
      } else {
        replacement = `- Open Finding: ${openFinding}`;
      }
      if (newLine !== replacement) {
        newLine = replacement;
        anyChange = true;
      }
    }

    newLines.push(newLine);
  }

  if (!anyChange) {
    return {
      success: true,
      modified: false,
    };
  }

  // ── Reconstruct the file ──
  const newBody = newLines.join('\n');
  const beforeSection = content.slice(0, section.start);
  const afterSection = content.slice(section.end);
  const newContent = beforeSection + `## Current CV Status\n` + newBody + afterSection;

  // ── Write back ──
  try {
    fs.writeFileSync(evidencePath, newContent, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: `Cannot write updated evidence file "${evidencePath}": ${err instanceof Error ? err.message : String(err)}`,
      modified: false,
    };
  }

  return {
    success: true,
    modified: true,
  };
}

/**
 * Convenience: update CV status to PASS after a successful CV run.
 */
export function updateCvStatusPass(
  evidencePath: string,
  stageId: string,
  sliceId: string,
  deliveryRoot: string,
  cvLevel: string,
  receiptPath: string,
): UpdateCvStatusResult {
  return updateCurrentCvStatus({
    evidencePath,
    status: 'PASS',
    stageId,
    sliceId,
    deliveryRoot,
    cvLevel,
    latestReceiptPath: receiptPath,
    openFinding: '', // clear finding
  });
}

/**
 * Convenience: update CV status to REPAIR after a CV failure.
 */
export function updateCvStatusRepair(
  evidencePath: string,
  stageId: string,
  sliceId: string,
  deliveryRoot: string,
  cvLevel: string,
  receiptPath: string,
  finding: string,
): UpdateCvStatusResult {
  return updateCurrentCvStatus({
    evidencePath,
    status: 'REPAIR',
    stageId,
    sliceId,
    deliveryRoot,
    cvLevel,
    latestReceiptPath: receiptPath,
    openFinding: finding,
  });
}

/**
 * Convenience: update CV status to PENDING_RECHECK before recheck.
 */
export function updateCvStatusPendingRecheck(
  evidencePath: string,
  stageId: string,
  sliceId: string,
  deliveryRoot: string,
  cvLevel: string,
  receiptPath: string,
): UpdateCvStatusResult {
  return updateCurrentCvStatus({
    evidencePath,
    status: 'PENDING_RECHECK',
    stageId,
    sliceId,
    deliveryRoot,
    cvLevel,
    latestReceiptPath: receiptPath,
    openFinding: '', // clear old finding for fresh recheck
  });
}

/**
 * Convenience: update CV status to READY_FOR_CV (when all tasks done, ready for CV).
 */
export function updateCvStatusReadyForCv(
  evidencePath: string,
  stageId: string,
  sliceId: string,
  deliveryRoot: string,
): UpdateCvStatusResult {
  return updateCurrentCvStatus({
    evidencePath,
    status: 'READY_FOR_CV',
    stageId,
    sliceId,
    deliveryRoot,
  });
}

// ── CLI runtime validation ──────────────────────────────────────────────────────

interface OptionsValidationSuccess {
  valid: true;
  options: UpdateCvStatusOptions;
}

interface OptionsValidationFailure {
  valid: false;
  error: string;
}

/**
 * Perform minimal strict type validation of CLI-supplied options.
 * Checks evidencePath (string), status (string), and optional field types.
 */
function validateOptionsInput(data: unknown): OptionsValidationSuccess | OptionsValidationFailure {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Options must be a JSON object.' };
  }
  const obj = data as Record<string, unknown>;

  if (typeof obj.evidencePath !== 'string' || obj.evidencePath === '') {
    return { valid: false, error: '"evidencePath" must be a non-empty string.' };
  }
  if (typeof obj.status !== 'string' || obj.status === '') {
    return { valid: false, error: '"status" must be a non-empty string.' };
  }
  if (typeof obj.stageId !== 'string' || obj.stageId === '') {
    return { valid: false, error: '"stageId" must be a non-empty string.' };
  }
  if (typeof obj.sliceId !== 'string' || obj.sliceId === '') {
    return { valid: false, error: '"sliceId" must be a non-empty string.' };
  }
  if (typeof obj.deliveryRoot !== 'string' || obj.deliveryRoot === '') {
    return { valid: false, error: '"deliveryRoot" must be a non-empty string.' };
  }

  // Optional fields - check type if present
  if (obj.cvLevel !== undefined && typeof obj.cvLevel !== 'string') {
    return { valid: false, error: '"cvLevel" must be a string if provided.' };
  }
  if (obj.latestReceiptPath !== undefined && typeof obj.latestReceiptPath !== 'string') {
    return { valid: false, error: '"latestReceiptPath" must be a string if provided.' };
  }
  if (obj.openFinding !== undefined && typeof obj.openFinding !== 'string') {
    return { valid: false, error: '"openFinding" must be a string if provided.' };
  }

  return { valid: true, options: data as UpdateCvStatusOptions };
}

// ── CLI entry point ─────────────────────────────────────────────────────────────

function isScriptEntry(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  try {
    const resolved = path.resolve(scriptPath);
    const currentFile = fileURLToPath(import.meta.url);
    return resolved === currentFile;
  } catch {
    const base = path.basename(scriptPath);
    return base === 'update-current-cv-status.js' || base === 'update-current-cv-status.ts';
  }
}

if (isScriptEntry()) {
  const arg1 = process.argv[2];
  const arg2 = process.argv[3];

  // Support --json flag for inline JSON input
  let raw: string;
  if (arg1 === '--json') {
    raw = arg2 || '';
  } else if (arg1) {
    raw = fs.readFileSync(arg1, 'utf-8');
  } else {
    raw = '';
  }

  if (!raw) {
    console.error('Usage: node dist/update-current-cv-status.js <options.json>');
    console.error('       node dist/update-current-cv-status.js --json \'<json>\'');
    console.error('');
    console.error('Reads a JSON options file (or inline JSON with --json flag) and updates');
    console.error('the ## Current CV Status section in a Slice Evidence markdown file.');
    console.error('Outputs the result as JSON to stdout.');
    console.error('');
    console.error('Options JSON schema:');
    console.error('  { "evidencePath": "delivery/stages/S01/evidence/S01-A.md",');
    console.error('    "status": "PASS|REPAIR|...",');
    console.error('    "stageId": "S01",');
    console.error('    "sliceId": "S01-A",');
    console.error('    "deliveryRoot": ".",');
    console.error('    "cvLevel": "lite|standard|enhanced",        // optional');
    console.error('    "latestReceiptPath": "path/to/receipt.json", // optional');
    console.error('    "openFinding": "description"                 // optional');
    console.error('  }');
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const validation = validateOptionsInput(data);
  if (!validation.valid) {
    console.error(`Validation Error: ${validation.error}`);
    process.exit(1);
  }

  try {
    const result = updateCurrentCvStatus(validation.options);
    console.log(JSON.stringify(result));
    if (!result.success) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`Error updating CV status: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
