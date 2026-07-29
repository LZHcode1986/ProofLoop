import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseStageFile } from './parse-stage.js';
import { normalizeRiskFact, ALL_KNOWN_RISK_FACTS } from './compute-cv-level.js';
import { Manifest as ManifestSchema } from './schemas.js';
import type { Manifest } from './schemas.js';

export interface ValidationResult {
  valid: boolean;
  stageId: string;
  errors: ValidationError[];
}

export interface ValidationError {
  type: string;
  message: string;
  sliceId?: string;
}

/**
 * Extract the content of a Markdown section by heading name (## or ###).
 */
function extractSection(lines: string[], heading: string): string {
  const startIdx = lines.findIndex(l => {
    const trimmed = l.trim();
    const match = trimmed.match(/^#{2,3}\s+(.+)/);
    return match !== null && match[1].trim() === heading;
  });
  if (startIdx === -1) return '';
  const rest = lines.slice(startIdx + 1);
  const endIdx = rest.findIndex(l => /^#{1,3}\s/.test(l.trim()));
  return endIdx === -1 ? rest.join('\n').trim() : rest.slice(0, endIdx).join('\n').trim();
}

/**
 * Extract list items (- item) from text.
 */
function extractListItems(text: string): string[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2).trim())
    .filter(Boolean);
}

/**
 * Extract all IDs of a given type from text using regex.
 */
function extractIds(text: string, regex: RegExp): string[] {
  return [...text.matchAll(regex)].map(m => m[0]);
}

export function validateStage(tasksPath: string, evidenceDir?: string): ValidationResult {
  const errors: ValidationError[] = [];

  let text: string;
  try {
    text = fs.readFileSync(tasksPath, 'utf-8');
  } catch {
    return {
      valid: false,
      stageId: 'unknown',
      errors: [{ type: 'FILE_ERROR', message: `Cannot read tasks file: ${tasksPath}` }],
    };
  }

  // Extract stage ID from first heading
  const stageIdMatch = text.match(/^# Stage\s+(S\d[\w-]*)/m);
  const stageId = stageIdMatch?.[1] ?? 'unknown';
  const lines = text.split('\n');

  // ── 1. Markdown region parseability (SLICE:BEGIN/END matching) ──
  const beginMatches = [...text.matchAll(/<!--\s*SLICE:(\S+):BEGIN\s*-->/g)];
  const endMatches = [...text.matchAll(/<!--\s*SLICE:(\S+):END\s*-->/g)];

  const beginIds = beginMatches.map(m => m[1]);
  const endIds = endMatches.map(m => m[1]);

  for (const id of beginIds) {
    if (!endIds.includes(id)) {
      errors.push({ type: 'UNCLOSED_SLICE', message: `Slice ${id} has BEGIN but no END marker`, sliceId: id });
    }
  }

  for (const id of endIds) {
    if (!beginIds.includes(id)) {
      errors.push({ type: 'ORPHANED_SLICE_END', message: `Slice ${id} has END but no BEGIN marker`, sliceId: id });
    }
  }

  // ── 2. Parse slices ──
  const parsed = parseStageFile(tasksPath);

  // ── 3. ID uniqueness ──
  const seenIds = new Map<string, string>(); // id -> source description
  function checkUnique(id: string, kind: string, sliceId?: string): void {
    if (seenIds.has(id)) {
      errors.push({
        type: 'DUPLICATE_ID',
        message: `Duplicate ${kind} ID: ${id} (first seen in ${seenIds.get(id)})`,
        sliceId,
      });
    } else {
      seenIds.set(id, kind + (sliceId ? ` in slice ${sliceId}` : ''));
    }
  }

  for (const slice of parsed.slices) {
    checkUnique(slice.sliceId, 'Slice');

    // Only check PO IDs within the Proof Obligations section (definition location)
    // References in Proof Plan, Tasks, and Closure should not trigger duplicates.
    const poDefSection = extractSection(slice.lines, 'Proof Obligations');
    if (poDefSection) {
      const poIds = extractIds(poDefSection, /PO-S\d{2,}-[A-Z]-\d{2}/g);
      for (const poId of poIds) {
        checkUnique(poId, 'Proof Obligation', slice.sliceId);
      }
    }

    // Only check Task IDs within the Tasks section (definition location)
    const tasksSection = extractSection(slice.lines, 'Tasks');
    if (tasksSection) {
      const taskIds = extractIds(tasksSection, /S\d{2,}-[A-Z]-T\d+/g);
      for (const taskId of taskIds) {
        checkUnique(taskId, 'Task', slice.sliceId);
      }
    }
  }

  // ── 4. DAG no cycles (topological sort on slice dependencies) ──
  const depMap = new Map<string, string[]>();
  for (const slice of parsed.slices) {
    const depsSection = extractSection(slice.lines, 'Dependencies');
    const depItems = extractListItems(depsSection);
    // Extract the slice ID from each dependency line (first space-separated token)
    const depIds = depItems.map(item => item.split(/\s+/)[0]).filter(id => /^S\d/.test(id));
    depMap.set(slice.sliceId, depIds);
  }

  // DFS cycle detection
  const visited = new Set<string>();
  const inStack = new Set<string>();
  let hasCycle = false;

  function dfs(node: string): void {
    if (hasCycle) return;
    if (inStack.has(node)) {
      errors.push({ type: 'CYCLE_DETECTED', message: `Dependency cycle detected involving slice ${node}`, sliceId: node });
      hasCycle = true;
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    inStack.add(node);
    const deps = depMap.get(node) ?? [];
    for (const dep of deps) {
      if (depMap.has(dep)) {
        dfs(dep);
        if (hasCycle) return;
      }
    }
    inStack.delete(node);
  }

  for (const slice of parsed.slices) {
    if (!hasCycle) {
      dfs(slice.sliceId);
    }
  }

  // ── 5. Each PO has Oracle Source ──
  for (const slice of parsed.slices) {
    const poDefSection = extractSection(slice.lines, 'Proof Obligations');
    if (poDefSection && poDefSection.trim().length > 0) {
      const poIdsInSlice = extractIds(poDefSection, /PO-S\d{2,}-[A-Z]-\d{2}/g);
      if (poIdsInSlice.length > 0) {
        // Split by PO entries: each PO block starts with "- PO-"
        // Since the section content starts with "- PO-", we prepend a marker
        const rawText = '\n' + poDefSection;
        const poBlocks = rawText.split(/\n\s*-\s*PO-/).slice(1);
        for (const rawBlock of poBlocks) {
          const fullBlock = 'PO-' + rawBlock;
          const poIdMatch = fullBlock.match(/^(PO-S\d{2,}-[A-Z]-\d{2})/);
          if (!poIdMatch) continue;
          const poId = poIdMatch[1];

          // Check Oracle Source has non-empty value
          if (!/oracle\s*source:\s*\S+/i.test(fullBlock)) {
            errors.push({
              type: 'MISSING_ORACLE_VALUE',
              message: `PO ${poId} in slice ${slice.sliceId} is missing Oracle Source or has empty value`,
              sliceId: slice.sliceId,
            });
          }

          // Check Behavior has non-empty value
          if (!/behavior:\s*\S+/i.test(fullBlock)) {
            errors.push({
              type: 'MISSING_BEHAVIOR_VALUE',
              message: `PO ${poId} in slice ${slice.sliceId} is missing Behavior or has empty value`,
              sliceId: slice.sliceId,
            });
          }

          // Check Success / Failure has non-empty value
          if (!/success\s*\/\s*failure:\s*\S+/i.test(fullBlock)) {
            errors.push({
              type: 'MISSING_SUCCESS_FAILURE_VALUE',
              message: `PO ${poId} in slice ${slice.sliceId} is missing Success/Failure or has empty value`,
              sliceId: slice.sliceId,
            });
          }

          // Check Required Observation has non-empty value (if the field is present)
          if (/required\s*observation\b/i.test(fullBlock) && !/required\s*observation:\s*\S+/i.test(fullBlock)) {
            errors.push({
              type: 'MISSING_REQUIRED_OBSERVATION_VALUE',
              message: `PO ${poId} in slice ${slice.sliceId} has Required Observation field but empty value`,
              sliceId: slice.sliceId,
            });
          }
        }
      }
    }
  }

  // ── 6. Each Task belongs to a Slice ──
  const allSliceTaskIds = new Set<string>();
  for (const slice of parsed.slices) {
    const tasksSection = extractSection(slice.lines, 'Tasks');
    // Track which task IDs are inside slice markers
    const taskLines = tasksSection.split('\n')
      .map(l => l.trim())
      .filter(l => /^- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/.test(l));
    for (const taskLine of taskLines) {
      const match = taskLine.match(/- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/);
      if (match) allSliceTaskIds.add(match[1]);
    }
  }

  // Check that every mentioned task ID is within a slice
  const allTaskIdMatches = extractIds(text, /S\d{2,}-[A-Z]-T\d+/g);
  for (const taskId of allTaskIdMatches) {
    if (!allSliceTaskIds.has(taskId)) {
      errors.push({
        type: 'TASK_OUTSIDE_SLICE',
        message: `Task ${taskId} appears outside any slice region`,
      });
    }
  }

  // ── 7. Each Slice has Risk Facts (strict validation) ──
  for (const slice of parsed.slices) {
    const riskFactsSection = extractSection(slice.lines, 'Risk Facts');
    const riskItems = extractListItems(riskFactsSection);

    // 7a. Must have at least one Risk Fact
    if (riskItems.length === 0) {
      errors.push({
        type: 'MISSING_RISK_FACTS',
        message: `Slice ${slice.sliceId} has no Risk Facts`,
        sliceId: slice.sliceId,
      });
      continue; // skip per-item checks when there are no items
    }

    // 7b. Reject empty risk fact values
    for (const fact of riskItems) {
      if (fact.trim().length === 0) {
        errors.push({
          type: 'EMPTY_RISK_FACT',
          message: `Slice ${slice.sliceId} has an empty Risk Fact entry`,
          sliceId: slice.sliceId,
        });
      }
    }

    // 7c. 'none' cannot be combined with other Risk Facts
    const normalized = riskItems.map(f => normalizeRiskFact(f));
    const hasNone = normalized.includes('none');
    const hasOther = normalized.some(f => f !== 'none' && f.length > 0);
    if (hasNone && hasOther) {
      errors.push({
        type: 'RISK_FACT_NONE_WITH_OTHERS',
        message: `Slice ${slice.sliceId} has 'none' combined with other Risk Facts`,
        sliceId: slice.sliceId,
      });
    }

    // 7d. Each Risk Fact must be a known enumeration value
    for (const fact of riskItems) {
      const nf = normalizeRiskFact(fact);
      if (nf.length === 0) continue; // already reported as EMPTY_RISK_FACT
      if (!ALL_KNOWN_RISK_FACTS.has(nf)) {
        errors.push({
          type: 'UNKNOWN_RISK_FACT',
          message: `Slice ${slice.sliceId} has unrecognized Risk Fact: "${fact}" (normalized: "${nf}")`,
          sliceId: slice.sliceId,
        });
      }
    }
  }

  // ── 8. Per-Slice Evidence file validation (if evidenceDir provided) ──
  if (evidenceDir) {
    // Resolve the evidence directory path
    const resolvedEvidenceDir = path.resolve(evidenceDir);

    // Check that evidence directory exists
    if (!fs.existsSync(resolvedEvidenceDir)) {
      errors.push({
        type: 'EVIDENCE_DIR_NOT_FOUND',
        message: `Evidence directory not found: ${evidenceDir}`,
      });
    } else {
      // Check that evidenceDir is a directory
      const stat = fs.statSync(resolvedEvidenceDir);
      if (!stat.isDirectory()) {
        errors.push({
          type: 'EVIDENCE_DIR_NOT_DIRECTORY',
          message: `Evidence path is not a directory: ${evidenceDir}`,
        });
      } else {
        // Get actual files in the evidence directory
        let actualFiles: string[];
        try {
          actualFiles = fs.readdirSync(resolvedEvidenceDir);
        } catch {
          actualFiles = [];
        }

        // Expected file names (slice-id.md)
        const expectedFileNames = new Set(parsed.slices.map(s => `${s.sliceId}.md`));

        // ── 8a. Missing evidence files ──
        for (const slice of parsed.slices) {
          const expectedFileName = `${slice.sliceId}.md`;
          if (!actualFiles.includes(expectedFileName)) {
            errors.push({
              type: 'MISSING_EVIDENCE_FILE',
              message: `Slice ${slice.sliceId} is missing its evidence file: ${expectedFileName}`,
              sliceId: slice.sliceId,
            });
          }
        }

        // ── 8b. Orphaned/extra evidence files ──
        for (const fileName of actualFiles) {
          // Only check .md files
          if (!fileName.endsWith('.md')) continue;

          if (!expectedFileNames.has(fileName)) {
            const sliceIdFromFile = fileName.replace(/\.md$/, '');
            errors.push({
              type: 'ORPHANED_EVIDENCE_FILE',
              message: `Evidence file "${fileName}" has no matching slice in tasks.md`,
              sliceId: sliceIdFromFile,
            });
          }
        }

        // ── 8c. Path traversal check: verify file names don't contain path separators ──
        for (const slice of parsed.slices) {
          const expectedFileName = `${slice.sliceId}.md`;
          if (expectedFileName.includes('/') || expectedFileName.includes('\\')) {
            errors.push({
              type: 'EVIDENCE_PATH_TRAVERSAL',
              message: `Slice ${slice.sliceId} has an evidence file name with path separators: ${expectedFileName}`,
              sliceId: slice.sliceId,
            });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, stageId, errors };
}

// ── Manifest-based validation ──────────────────────────────────────────────────

/**
 * Expected evidence path pattern.
 * Must be exactly: delivery/stages/<stage-id>/evidence/<slice-id>.md
 */
const EVIDENCE_PATH_PATTERN = /^delivery\/stages\/(S\d[\w-]*)\/evidence\/(S\d{2,}-[A-Z])\.md$/;

/**
 * Validate a Stage against its compiled Manifest.
 *
 * This supersedes the older `validateStage` for manifest-aware validation.
 * It performs:
 * 1. All structural tasks.md checks (delegates to `validateStage` internally)
 * 2. Manifest source_path / source_digest matches the tasks file
 * 3. Manifest slice IDs match parsed tasks slice IDs (bidirectional union)
 * 4. Each slice's evidence_path matches the canonical pattern
 * 5. Evidence file existence/orphan checks against manifest's evidence_path set
 *
 * @param manifest  The compiled Manifest object.
 * @param tasksPath  Path to the tasks.md file.
 * @param evidenceDir  Optional directory containing per-slice evidence files.
 */
export function validateStageWithManifest(
  manifest: Manifest,
  tasksPath: string,
  evidenceDir?: string,
): ValidationResult {
  const errors: ValidationError[] = [];

  // ── 1. Structural tasks.md checks ──
  const structuralResult = validateStage(tasksPath, undefined);
  if (!structuralResult.valid) {
    // Propagate structural errors but continue with manifest-specific checks
    errors.push(...structuralResult.errors);
  }

  // ── 1b. Validate manifest.stage_id matches tasks.md Stage ID ──
  if (structuralResult.stageId !== 'unknown' && structuralResult.stageId !== manifest.stage_id) {
    errors.push({
      type: 'STAGE_ID_MISMATCH',
      message: `Manifest stage_id "${manifest.stage_id}" does not match tasks.md Stage ID "${structuralResult.stageId}"`,
    });
  }

  // ── 1c. Reject duplicate manifest slice_id ──
  const manifestSliceIdSet = new Set<string>();
  for (const slice of manifest.slices) {
    if (manifestSliceIdSet.has(slice.slice_id)) {
      errors.push({
        type: 'DUPLICATE_MANIFEST_SLICE_ID',
        message: `Manifest contains duplicate slice_id: "${slice.slice_id}"`,
        sliceId: slice.slice_id,
      });
    }
    manifestSliceIdSet.add(slice.slice_id);
  }

  // ── 1d. Reject duplicate manifest evidence_path ──
  const manifestEvidencePathSet = new Set<string>();
  for (const slice of manifest.slices) {
    if (slice.evidence_path && manifestEvidencePathSet.has(slice.evidence_path)) {
      errors.push({
        type: 'DUPLICATE_MANIFEST_EVIDENCE_PATH',
        message: `Manifest contains duplicate evidence_path: "${slice.evidence_path}"`,
        sliceId: slice.slice_id,
      });
    }
    if (slice.evidence_path) {
      manifestEvidencePathSet.add(slice.evidence_path);
    }
  }

  // We need the tasks content for slice set comparison
  let tasksText: string;
  try {
    tasksText = fs.readFileSync(tasksPath, 'utf-8');
  } catch {
    errors.push({
      type: 'FILE_ERROR',
      message: `Cannot read tasks file: ${tasksPath}`,
    });
    return { valid: false, stageId: manifest.stage_id, errors };
  }

  // ── 2. Validate manifest source_path matches tasksPath ──
  // Normalize both paths for comparison (resolve relative paths)
  const resolvedTasksPath = path.resolve(tasksPath);
  const manifestSourcePath = manifest.source_path;
  const resolvedSourcePath = path.resolve(manifestSourcePath);

  if (resolvedSourcePath !== resolvedTasksPath) {
    errors.push({
      type: 'MANIFEST_SOURCE_PATH_MISMATCH',
      message: `Manifest source_path "${manifestSourcePath}" (resolved: "${resolvedSourcePath}") ` +
        `does not match provided tasksPath "${tasksPath}" (resolved: "${resolvedTasksPath}")`,
    });
  }

  // ── 3. Validate manifest source_digest matches tasks.md SHA-256 ──
  const computedDigest = crypto.createHash('sha256').update(tasksText, 'utf-8').digest('hex');
  if (manifest.source_digest !== computedDigest) {
    errors.push({
      type: 'MANIFEST_SOURCE_DIGEST_MISMATCH',
      message: `Manifest source_digest "${manifest.source_digest}" does not match ` +
        `computed SHA-256 of tasks.md: "${computedDigest}"`,
    });
  }

  // ── 4. Parse tasks slices for comparison ──
  const parsed = parseStageFile(tasksPath);
  const tasksSliceIds = new Set(parsed.slices.map(s => s.sliceId));
  const manifestSliceIds = new Set(manifest.slices.map(s => s.slice_id));

  // Slices in manifest but not in tasks
  for (const sliceId of manifestSliceIds) {
    if (!tasksSliceIds.has(sliceId)) {
      errors.push({
        type: 'SLICE_IN_MANIFEST_NOT_IN_TASKS',
        message: `Slice "${sliceId}" is in manifest but not found in tasks.md`,
        sliceId,
      });
    }
  }

  // Slices in tasks but not in manifest
  for (const sliceId of tasksSliceIds) {
    if (!manifestSliceIds.has(sliceId)) {
      errors.push({
        type: 'SLICE_IN_TASKS_NOT_IN_MANIFEST',
        message: `Slice "${sliceId}" is in tasks.md but not found in manifest`,
        sliceId,
      });
    }
  }

  // ── 5. Validate each slice's evidence_path pattern ──
  for (const slice of manifest.slices) {
    const evidencePath = slice.evidence_path;

    if (!evidencePath) {
      errors.push({
        type: 'MISSING_EVIDENCE_PATH',
        message: `Slice "${slice.slice_id}" has no evidence_path in manifest`,
        sliceId: slice.slice_id,
      });
      continue;
    }

    const match = evidencePath.match(EVIDENCE_PATH_PATTERN);
    if (!match) {
      errors.push({
        type: 'INVALID_EVIDENCE_PATH_PATTERN',
        message: `Slice "${slice.slice_id}" evidence_path "${evidencePath}" does not match ` +
          `expected pattern "delivery/stages/<stage-id>/evidence/<slice-id>.md"`,
        sliceId: slice.slice_id,
      });
    } else {
      if (match[1] !== manifest.stage_id) {
        errors.push({
          type: 'EVIDENCE_PATH_STAGE_ID_MISMATCH',
          message: `Slice "${slice.slice_id}" evidence_path "${evidencePath}" ` +
            `has stage ID "${match[1]}" but manifest stage_id is "${manifest.stage_id}"`,
          sliceId: slice.slice_id,
        });
      }
      if (match[2] !== slice.slice_id) {
        errors.push({
          type: 'EVIDENCE_PATH_SLICE_ID_MISMATCH',
          message: `Slice "${slice.slice_id}" evidence_path "${evidencePath}" ` +
            `has slice ID "${match[2]}" but slice slice_id is "${slice.slice_id}"`,
          sliceId: slice.slice_id,
        });
      }
    }
  }

  // ── 6. Evidence file validation against manifest's evidence_path set ──
  if (evidenceDir) {
    const resolvedEvidenceDir = path.resolve(evidenceDir);

    // ── 6a. Verify evidenceDir matches the canonical stage evidence directory ──
    // The canonical evidence dir suffix is: delivery/stages/<stage-id>/evidence/
    // We check that the resolved path ends with this suffix (handles both
    // absolute and relative paths).
    const canonicalSuffix = path.join('delivery', 'stages', manifest.stage_id, 'evidence');
    const resolvedStr = resolvedEvidenceDir.replace(/\\/g, '/');
    const canonicalSuffixStr = canonicalSuffix.replace(/\\/g, '/');

    if (!resolvedStr.endsWith(canonicalSuffixStr)) {
      errors.push({
        type: 'EVIDENCE_DIR_MISMATCH',
        message: `Evidence directory "${evidenceDir}" (resolved: "${resolvedEvidenceDir}") ` +
          `does not match the canonical Manifest-declared evidence directory suffix ` +
          `"${canonicalSuffix}". The evidence-dir must point to the Manifest-declared ` +
          `stage evidence location: delivery/stages/<stage-id>/evidence/.`,
      });
    } else if (!fs.existsSync(resolvedEvidenceDir)) {
      errors.push({
        type: 'EVIDENCE_DIR_NOT_FOUND',
        message: `Evidence directory not found: ${evidenceDir}`,
      });
    } else {
      const stat = fs.statSync(resolvedEvidenceDir);
      if (!stat.isDirectory()) {
        errors.push({
          type: 'EVIDENCE_DIR_NOT_DIRECTORY',
          message: `Evidence path is not a directory: ${evidenceDir}`,
        });
      } else {
        let actualFiles: string[];
        try {
          actualFiles = fs.readdirSync(resolvedEvidenceDir);
        } catch {
          actualFiles = [];
        }

        // Build expected file names from manifest's evidence_path values
        const expectedFileNames = new Set(
          manifest.slices
            .filter(s => s.evidence_path)
            .map(s => path.basename(s.evidence_path)),
        );

        // ── 6b. Missing evidence files ──
        for (const slice of manifest.slices) {
          if (!slice.evidence_path) continue; // already reported above
          const expectedFileName = path.basename(slice.evidence_path);
          if (!actualFiles.includes(expectedFileName)) {
            errors.push({
              type: 'MISSING_EVIDENCE_FILE',
              message: `Slice "${slice.slice_id}" is missing its evidence file: ${expectedFileName} ` +
                `(declared in manifest as "${slice.evidence_path}")`,
              sliceId: slice.slice_id,
            });
          }
        }

        // ── 6c. Orphaned/extra evidence files ──
        for (const fileName of actualFiles) {
          if (!fileName.endsWith('.md')) continue;
          if (!expectedFileNames.has(fileName)) {
            const sliceIdFromFile = fileName.replace(/\.md$/, '');
            errors.push({
              type: 'ORPHANED_EVIDENCE_FILE',
              message: `Evidence file "${fileName}" has no matching slice in manifest evidence_path`,
              sliceId: sliceIdFromFile,
            });
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, stageId: manifest.stage_id, errors };
}

// ── CLI entry point ────────────────────────────────────────────────────────────

/**
 * CLI usage:
 * ```
 * node dist/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 * ```
 *
 * Reads and schema-parses the manifest, then performs manifest-aware validation
 * against the tasks.md file. Exits with code 0 on success, 1 on failure.
 * All errors are printed to stderr.
 */
function isScriptEntry(): boolean {
  const scriptPath = process.argv[1];
  if (!scriptPath) return false;
  try {
    const resolved = path.resolve(scriptPath);
    const currentFile = fileURLToPath(import.meta.url);
    return resolved === currentFile;
  } catch {
    const base = path.basename(scriptPath);
    return base === 'validate-stage.js' || base === 'validate-stage.ts';
  }
}

if (isScriptEntry()) {
  const tasksPath = process.argv[2];
  const manifestPath = process.argv[3];
  const evidenceDir = process.argv[4];

  if (!tasksPath || !manifestPath) {
    console.error('Usage: node dist/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]');
    process.exit(1);
  }

  // Check that tasks file exists
  if (!fs.existsSync(tasksPath)) {
    console.error(`Tasks file not found: ${tasksPath}`);
    process.exit(1);
  }

  // Check that manifest file exists
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest file not found: ${manifestPath}`);
    process.exit(1);
  }

  // Read and schema-parse manifest
  let manifest: Manifest;
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const parsed = JSON.parse(content);
    manifest = ManifestSchema.parse(parsed) as Manifest;
  } catch (err) {
    console.error(`Manifest schema validation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Perform manifest-aware validation
  const result = validateStageWithManifest(manifest, tasksPath, evidenceDir || undefined);

  // Print all errors to stderr
  for (const err of result.errors) {
    const sliceInfo = err.sliceId ? ` (slice: ${err.sliceId})` : '';
    console.error(`[${err.type}] ${err.message}${sliceInfo}`);
  }

  if (!result.valid) {
    process.exit(1);
  }

  console.log('Stage validation passed.');
  process.exit(0);
}
