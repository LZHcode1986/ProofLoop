import fs from 'node:fs';
import { parseStageFile } from './parse-stage.js';

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

export function validateStage(tasksPath: string, evidencePath?: string): ValidationResult {
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

    // Extract PO IDs from slice content
    const poIds = extractIds(slice.raw, /PO-S\d{2,}-[A-Z]-\d{2}/g);
    for (const poId of poIds) {
      checkUnique(poId, 'Proof Obligation', slice.sliceId);
    }

    // Extract Task IDs from slice content
    const taskIds = extractIds(slice.raw, /S\d{2,}-[A-Z]-T\d+/g);
    for (const taskId of taskIds) {
      checkUnique(taskId, 'Task', slice.sliceId);
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
    const poIdsInSlice = extractIds(slice.raw, /PO-S\d{2,}-[A-Z]-\d{2}/g);
    if (poIdsInSlice.length > 0) {
      const poSection = extractSection(slice.lines, 'Proof Plan');
      // If PO IDs are declared, the Proof Plan section must have oracle source references
      if (!poSection || poSection.trim().length === 0) {
        errors.push({
          type: 'MISSING_ORACLE_SOURCE',
          message: `Slice ${slice.sliceId} has Proof Obligations but the Proof Plan section is empty`,
          sliceId: slice.sliceId,
        });
      } else if (!poSection.includes('oracle') && !poSection.includes('Oracle') && !poSection.includes('source')) {
        // Oracle source is expected but not found in Proof Plan text; warn
        errors.push({
          type: 'MISSING_ORACLE_SOURCE',
          message: `Slice ${slice.sliceId} Proof Plan may be missing oracle_source for POs: ${poIdsInSlice.join(', ')}`,
          sliceId: slice.sliceId,
        });
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

  // ── 7. Each Slice has Risk Facts ──
  for (const slice of parsed.slices) {
    const riskFactsSection = extractSection(slice.lines, 'Risk Facts');
    const riskItems = extractListItems(riskFactsSection);
    if (riskItems.length === 0) {
      errors.push({
        type: 'MISSING_RISK_FACTS',
        message: `Slice ${slice.sliceId} has no Risk Facts`,
        sliceId: slice.sliceId,
      });
    }
  }

  // ── 8. Evidence markers (if evidencePath provided) ──
  if (evidencePath) {
    try {
      const evidenceText = fs.readFileSync(evidencePath, 'utf-8');
      const evidenceBeginIds = [...evidenceText.matchAll(/<!--\s*EVIDENCE:(\S+):BEGIN\s*-->/g)].map(m => m[1]);
      const evidenceEndIds = [...evidenceText.matchAll(/<!--\s*EVIDENCE:(\S+):END\s*-->/g)].map(m => m[1]);

      // Each slice should have a matching evidence marker
      for (const slice of parsed.slices) {
        if (!evidenceBeginIds.includes(slice.sliceId)) {
          errors.push({
            type: 'MISSING_EVIDENCE_MARKER',
            message: `Slice ${slice.sliceId} has no EVIDENCE:BEGIN marker in evidence.md`,
            sliceId: slice.sliceId,
          });
        }
      }

      // Each evidence marker should have a matching slice
      for (const evId of evidenceBeginIds) {
        if (!parsed.slices.some(s => s.sliceId === evId)) {
          errors.push({
            type: 'ORPHANED_EVIDENCE_MARKER',
            message: `Evidence marker ${evId} has no matching slice in tasks.md`,
            sliceId: evId,
          });
        }
      }

      // Evidence BEGIN/END matching
      for (const id of evidenceBeginIds) {
        if (!evidenceEndIds.includes(id)) {
          errors.push({
            type: 'UNCLOSED_EVIDENCE',
            message: `Evidence ${id} has BEGIN but no END marker`,
            sliceId: id,
          });
        }
      }
      for (const id of evidenceEndIds) {
        if (!evidenceBeginIds.includes(id)) {
          errors.push({
            type: 'ORPHANED_EVIDENCE_END',
            message: `Evidence ${id} has END but no BEGIN marker`,
            sliceId: id,
          });
        }
      }
    } catch {
      errors.push({
        type: 'EVIDENCE_FILE_ERROR',
        message: `Cannot read evidence file: ${evidencePath}`,
      });
    }
  }

  return { valid: errors.length === 0, stageId, errors };
}
