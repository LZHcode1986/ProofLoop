/**
 * validate-stage — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Planner mechanical gatekeeper over a Stage tasks.md (optionally against a
 * previously compiled manifest and an evidence directory). Legacy-compatible
 * contract:
 *
 *   node packages/runtime/dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 *
 * Checks (all fail closed — a stage is valid only when every check passes):
 *  1. the tasks.md compiles into a kernel-`validateManifest`-valid Manifest
 *     (the compile seam is the shared compile-manifest logic);
 *  2. SLICE:BEGIN/END marker structure (unclosed / orphaned regions);
 *  3. id uniqueness — slice ids, PO ids (in PO sections), task ids (in
 *     Tasks sections);
 *  4. dependency DAG — no cycles AND every declared dependency references a
 *     slice declared in the same Stage (Referencing Slices appear in the
 *     Stage Closure);
 *  5. PO fields declared-but-empty (Behavior / Oracle Source / Success /
 *     Failure / Required Observation);
 *  6. every task id occurrence in the file belongs to a slice Tasks section;
 *  7. optional provided-manifest cross-check: stage_id match, bidirectional
 *     slice-set equality, duplicate slice_id / evidence_path, canonical
 *     evidence_path pattern;
 *  8. optional evidence-dir existence check (missing / orphaned files).
 *
 * Output: JSON `{ valid, stage_id, errors }` on stdout; exit 0 / 1.
 *
 * Zero host dependencies: Node builtins + `@proofloop/kernel` +
 * package-internal modules only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateManifest } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';
import {
  compileManifest,
  extractSection,
  extractListItems,
  parseSliceDependencies,
  normalizeRiskFact,
  ALL_KNOWN_RISK_FACTS,
} from './compile-manifest';

// ============================================================
// Shapes
// ============================================================

export interface ValidationError {
  readonly type: string;
  readonly message: string;
  readonly sliceId?: string;
}

export interface ValidateStageResult {
  readonly valid: boolean;
  readonly stage_id: string;
  readonly errors: readonly ValidationError[];
}

function error(type: string, message: string, sliceId?: string): ValidationError {
  return sliceId === undefined ? { type, message } : { type, message, sliceId };
}

// ============================================================
// Raw tasks.md structural checks
// ============================================================

interface SliceRegion {
  readonly sliceId: string;
  lines: string[];
}

/** Extract slice regions; structural marker errors are reported, not thrown. */
function scanSliceRegions(text: string): { regions: SliceRegion[]; errors: ValidationError[] } {
  const regions: SliceRegion[] = [];
  const errors: ValidationError[] = [];
  const lines = text.split('\n');
  let current: SliceRegion | null = null;
  for (const line of lines) {
    const begin = line.match(/<!--\s*SLICE:(\S+):BEGIN\s*-->/);
    const end = line.match(/<!--\s*SLICE:(\S+):END\s*-->/);
    if (begin) {
      if (current !== null) {
        errors.push(
          error(
            'UNCLOSED_SLICE',
            `Slice ${begin[1]} has BEGIN while ${current.sliceId} is still open`,
            current.sliceId,
          ),
        );
        continue;
      }
      current = { sliceId: begin[1], lines: [] };
      continue;
    }
    if (end) {
      if (current === null) {
        errors.push(
          error(
            'ORPHANED_SLICE_END',
            `Slice ${end[1]} has END but no BEGIN marker`,
            end[1],
          ),
        );
        continue;
      }
      if (current.sliceId !== end[1]) {
        errors.push(
          error(
            'MISMATCHED_SLICE_MARKER',
            `SLICE:END for ${end[1]} while ${current.sliceId} region is open`,
            current.sliceId,
          ),
        );
      } else {
        regions.push(current);
      }
      current = null;
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  if (current !== null) {
    errors.push(
      error('UNCLOSED_SLICE', `Slice ${current.sliceId} has BEGIN but no END marker`, current.sliceId),
    );
  }
  return { regions, errors };
}

const PO_ID_RE = /PO-S\d{2,}-[A-Z]-\d{2}/g;
const TASK_ID_RE = /S\d{2,}-[A-Z]-T\d+/g;

/**
 * Structural checks over the raw tasks.md (region markers, uniqueness,
 * PO declared-but-empty values, task-in-slice). The DAG checks run on the
 * compiled manifest below.
 */
function structuralChecks(text: string, stageId: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const { regions, errors: markerErrors } = scanSliceRegions(text);
  errors.push(...markerErrors);

  const seen = new Map<string, string>();
  const addUnique = (id: string, kind: string, sliceId?: string): void => {
    if (seen.has(id)) {
      errors.push(
        error(
          'DUPLICATE_ID',
          `Duplicate ${kind} ID: ${id} (first seen in ${seen.get(id)})`,
          sliceId,
        ),
      );
    } else {
      seen.set(id, kind + (sliceId !== undefined ? ` in slice ${sliceId}` : ''));
    }
  };

  for (const region of regions) {
    addUnique(region.sliceId, 'Slice', region.sliceId);
    const poSection = extractSection(region.lines, 'Proof Obligations');
    for (const poId of poSection.match(PO_ID_RE) ?? []) {
      addUnique(poId, 'Proof Obligation', region.sliceId);
    }
    const tasksSection = extractSection(region.lines, 'Tasks');
    for (const taskId of tasksSection.match(TASK_ID_RE) ?? []) {
      addUnique(taskId, 'Task', region.sliceId);
    }

    // PO declared-but-empty values (mirrors the legacy gatekeeper rule).
    if (poSection.trim().length > 0 && (poSection.match(PO_ID_RE) ?? []).length > 0) {
      for (const rawBlock of ('\n' + poSection).split(/\n\s*-\s*PO-/).slice(1)) {
        const fullBlock = 'PO-' + rawBlock;
        const poIdMatch = fullBlock.match(/^(PO-S\d{2,}-[A-Z]-\d{2})/);
        if (!poIdMatch) continue;
        const poId = poIdMatch[1];
        // Line-based presence check: a field line must carry a non-empty
        // value on the SAME line (a value on a following line is a
        // different field / continuation, never a valid value).
        const declared = new Map<string, string>();
        for (const line of fullBlock.split('\n')) {
          const trimmed = line.trim();
          const fm = trimmed.match(/^-\s+(.+?):\s*(.*)$/);
          if (fm) declared.set(fm[1].trim(), fm[2].trim());
        }
        const fieldCheck: Array<{ type: string; label: string; keyRe: RegExp }> = [
          { type: 'MISSING_BEHAVIOR_VALUE', label: 'Behavior', keyRe: /^behavior$/i },
          { type: 'MISSING_ORACLE_VALUE', label: 'Oracle Source', keyRe: /^oracle\s*source$/i },
          { type: 'MISSING_SUCCESS_FAILURE_VALUE', label: 'Success / Failure', keyRe: /^success\s*\/\s*failure$/i },
          { type: 'MISSING_REQUIRED_OBSERVATION_VALUE', label: 'Required Observation', keyRe: /^required\s*observation$/i },
        ];
        for (const fc of fieldCheck) {
          let found: string | undefined;
          for (const [key, value] of declared) {
            if (fc.keyRe.test(key)) {
              found = value;
              break;
            }
          }
          if (found === undefined || found.length === 0) {
            errors.push(
              error(
                fc.type,
                `PO ${poId} in slice ${region.sliceId} is missing ${fc.label} or has empty value`,
                region.sliceId,
              ),
            );
          }
        }
      }
    }

    // Risk facts vocabulary (fail closed on unrecognized facts).
    const riskItems = extractListItems(extractSection(region.lines, 'Risk Facts'));
    if (riskItems.length === 0) {
      errors.push(
        error('MISSING_RISK_FACTS', `Slice ${region.sliceId} has no Risk Facts`, region.sliceId),
      );
    }
    const normalized = riskItems.map(normalizeRiskFact);
    const hasNone = normalized.includes('none');
    const hasOther = normalized.some((rf) => rf !== 'none' && rf.length > 0);
    if (hasNone && hasOther) {
      errors.push(
        error(
          'RISK_FACT_NONE_WITH_OTHERS',
          `Slice ${region.sliceId} has 'none' combined with other Risk Facts`,
          region.sliceId,
        ),
      );
    }
    for (const rf of normalized) {
      if (rf.length > 0 && !ALL_KNOWN_RISK_FACTS.has(rf)) {
        errors.push(
          error(
            'UNKNOWN_RISK_FACT',
            `Slice ${region.sliceId} has unrecognized Risk Fact: "${rf}"`,
            region.sliceId,
          ),
        );
      }
    }
  }

  // Every task id occurrence must belong to a slice Tasks section.
  const declaredTasks = new Set<string>();
  for (const region of regions) {
    const tasksSection = extractSection(region.lines, 'Tasks');
    for (const taskId of tasksSection.match(TASK_ID_RE) ?? []) {
      declaredTasks.add(taskId);
    }
  }
  for (const taskId of text.match(TASK_ID_RE) ?? []) {
    if (!declaredTasks.has(taskId)) {
      errors.push(
        error('TASK_OUTSIDE_SLICE', `Task ${taskId} appears outside any slice region`),
      );
    }
  }

  return errors;
}

// ============================================================
// Manifest-aware checks
// ============================================================

const EVIDENCE_PATH_RE = /^delivery\/stages\/(S\d[\w-]*)\/evidence\/(S\d{2,}-[A-Z])\.md$/;

function manifestChecks(
  provided: Manifest,
  compiled: Manifest,
  tasksText: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (provided.stage_id !== compiled.stage_id) {
    errors.push(
      error(
        'STAGE_ID_MISMATCH',
        `Manifest stage_id "${provided.stage_id}" does not match tasks.md Stage ID "${compiled.stage_id}"`,
      ),
    );
  }
  const providedIds = provided.slices.map((s) => s.slice_id);
  const compiledIds = compiled.slices.map((s) => s.slice_id);
  const missing = compiledIds.filter((id) => !providedIds.includes(id));
  const extra = providedIds.filter((id) => !compiledIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    errors.push(
      error(
        'SLICE_SET_MISMATCH',
        `Manifest slice set differs from the compiled slice set: missing ${JSON.stringify(missing)}, extra ${JSON.stringify(extra)}`,
      ),
    );
  }
  const seenSliceIds = new Set<string>();
  const seenEvidence = new Set<string>();
  for (const slice of provided.slices) {
    if (seenSliceIds.has(slice.slice_id)) {
      errors.push(
        error('DUPLICATE_MANIFEST_SLICE_ID', `Manifest contains duplicate slice_id: "${slice.slice_id}"`, slice.slice_id),
      );
    }
    seenSliceIds.add(slice.slice_id);
    const match = slice.evidence_path.match(EVIDENCE_PATH_RE);
    if (!match || match[1] !== provided.stage_id || match[2] !== slice.slice_id) {
      errors.push(
        error(
          'EVIDENCE_PATH_INVALID',
          `Slice ${slice.slice_id} evidence_path "${slice.evidence_path}" does not match the canonical pattern`,
          slice.slice_id,
        ),
      );
    }
    if (seenEvidence.has(slice.evidence_path)) {
      errors.push(
        error('DUPLICATE_MANIFEST_EVIDENCE_PATH', `Manifest contains duplicate evidence_path: "${slice.evidence_path}"`, slice.slice_id),
      );
    }
    seenEvidence.add(slice.evidence_path);
  }
  return errors;
}

// ============================================================
// Evidence dir checks
// ============================================================

function evidenceDirChecks(evidenceDir: string, compiled: Manifest): ValidationError[] {
  const errors: ValidationError[] = [];
  const resolvedDir = path.resolve(evidenceDir);
  if (!fs.existsSync(resolvedDir)) {
    errors.push(error('EVIDENCE_DIR_NOT_FOUND', `Evidence directory not found: ${evidenceDir}`));
    return errors;
  }
  const stat = fs.statSync(resolvedDir);
  if (!stat.isDirectory()) {
    errors.push(error('EVIDENCE_DIR_NOT_DIRECTORY', `Evidence path is not a directory: ${evidenceDir}`));
    return errors;
  }
  const actualFiles = fs.readdirSync(resolvedDir);
  const expected = new Set(compiled.slices.map((s) => `${s.slice_id}.md`));
  for (const slice of compiled.slices) {
    const fileName = `${slice.slice_id}.md`;
    if (!actualFiles.includes(fileName)) {
      errors.push(
        error('MISSING_EVIDENCE_FILE', `Slice ${slice.slice_id} is missing its evidence file: ${fileName}`, slice.slice_id),
      );
    }
  }
  for (const fileName of actualFiles) {
    if (!fileName.endsWith('.md')) continue;
    if (!expected.has(fileName)) {
      errors.push(
        error(
          'ORPHANED_EVIDENCE_FILE',
          `Evidence file "${fileName}" has no matching slice in tasks.md`,
          fileName.replace(/\.md$/, ''),
        ),
      );
    }
  }
  return errors;
}

// ============================================================
// validateStage
// ============================================================

/**
 * Run the Planner mechanical gatekeeper over a Stage tasks.md.
 *
 * @param tasksPath    tasks.md of the stage.
 * @param manifestPath optional previously compiled manifest to cross-check.
 * @param evidenceDir  optional evidence directory for existence checks.
 */
export function validateStage(
  tasksPath: string,
  manifestPath?: string,
  evidenceDir?: string,
): ValidateStageResult {
  let text: string;
  try {
    text = fs.readFileSync(tasksPath, 'utf-8');
  } catch {
    return {
      valid: false,
      stage_id: 'unknown',
      errors: [error('FILE_ERROR', `Cannot read tasks file: ${tasksPath}`)],
    };
  }

  // 1. Structural raw checks (region markers / uniqueness / PO fields /
  //    risk facts / task-in-slice) — run BEFORE compile so marker errors
  //    surface with precise types even when the tasks.md does not compile.
  const stageMatch = text.match(/^# Stage\s+(S\d[\w-]*)/m);
  const errors: ValidationError[] = structuralChecks(text, stageMatch?.[1] ?? 'unknown');

  // 2. Compile through the shared compile seam (kernel validateManifest).
  let compiled: Manifest;
  try {
    compiled = compileManifest(tasksPath);
  } catch (err) {
    errors.push(
      error(
        'COMPILE_FAILED',
        `tasks.md does not compile into a kernel-valid manifest: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return { valid: false, stage_id: stageMatch?.[1] ?? 'unknown', errors };
  }

  // 3. DAG checks over the compiled machine-readable dependencies.
  const byId = new Map(compiled.slices.map((s) => [s.slice_id, s]));
  const seen = new Set<string>();
  const inStack = new Set<string>();
  let cycleFound = false;
  const dfs = (node: string): void => {
    if (cycleFound || seen.has(node)) return;
    if (inStack.has(node)) {
      cycleFound = true;
      errors.push(
        error('CYCLE_DETECTED', `Dependency cycle detected involving slice ${node}`, node),
      );
      return;
    }
    inStack.add(node);
    for (const dep of byId.get(node)?.dependencies ?? []) {
      if (!byId.has(dep)) {
        errors.push(
          error(
            'UNDECLARED_DEPENDENCY',
            `Slice ${node} depends on "${dep}" which is not declared in this Stage`,
            node,
          ),
        );
        continue;
      }
      dfs(dep);
    }
    inStack.delete(node);
    seen.add(node);
  };
  for (const slice of compiled.slices) dfs(slice.slice_id);

  // 4. Optional provided-manifest cross-check.
  if (manifestPath !== undefined) {
    let provided: Manifest;
    try {
      provided = validateManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf-8')),
      );
    } catch (err) {
      errors.push(
        error(
          'MANIFEST_LOAD_FAILED',
          `Cannot load/validate provided manifest "${manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      provided = compiled;
    }
    errors.push(...manifestChecks(provided, compiled, text));
  }

  // 5. Optional evidence-dir checks.
  if (evidenceDir !== undefined) {
    errors.push(...evidenceDirChecks(evidenceDir, compiled));
  }

  return { valid: errors.length === 0, stage_id: compiled.stage_id, errors };
}

// ============================================================
// CLI entry
// ============================================================

/**
 * Legacy-compatible CLI:
 *   node dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 */
export function validateStageCli(argv: readonly string[]): number {
  const [tasksPath, manifestPath, evidenceDir] = argv;
  if (!tasksPath || !manifestPath) {
    console.error('Usage: node dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]');
    console.error('');
    console.error('Runs the Planner mechanical gatekeeper over the tasks.md and');
    console.error('outputs the validation result as JSON to stdout.');
    return 1;
  }
  if (!fs.existsSync(tasksPath)) {
    console.error(`Tasks file not found: ${tasksPath}`);
    return 1;
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest file not found: ${manifestPath}`);
    return 1;
  }
  const result = validateStage(tasksPath, manifestPath, evidenceDir || undefined);
  console.log(JSON.stringify(result, null, 2));
  return result.valid ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = validateStageCli(process.argv.slice(2));
}
