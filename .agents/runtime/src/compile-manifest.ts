import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseStageFile } from './parse-stage.js';
import type { Manifest, RuntimeProofStep } from './schemas.js';

/**
 * Extract the content of a Markdown section by heading (## or ###).
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
 * Extract the first paragraph of a section (content before any sub-heading).
 */
function extractFirstParagraph(text: string): string {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'))
    .join(' ')
    .trim();
}

/**
 * Extract all task IDs from a Tasks section.
 */
function extractTaskIds(text: string): string[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => /^- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/.test(l))
    .map(l => {
      const match = l.match(/- \[.?\]\s*(S\d{2,}-[A-Z]-T\d+)/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

export function compileManifest(tasksPath: string): Manifest {
  const text = fs.readFileSync(tasksPath, 'utf-8');
  const lines = text.split('\n');

  // Compute SHA-256 digest of the source file
  const sourceDigest = crypto.createHash('sha256').update(text, 'utf-8').digest('hex');

  // Extract stage ID
  const stageIdMatch = text.match(/^# Stage\s+(S\d[\w-]*)/m);
  const stageId = stageIdMatch?.[1] ?? 'unknown';

  // Extract stage goal
  const stageGoalText = extractSection(lines, 'Stage Goal');
  // Take the first non-empty line as the goal
  const stageGoal = extractFirstParagraph(stageGoalText);

  // Extract observable outcomes
  const outcomesText = extractSection(lines, 'Observable Outcomes');
  const outcomes = extractListItems(outcomesText);

  // Extract global dependencies
  const depsText = extractSection(lines, 'Dependencies');
  const dependencies = extractListItems(depsText);

  // Extract global risk facts (from a section if present)
  let riskFacts: string[] = [];
  const riskFactsSection = extractSection(lines, 'Risk Facts');
  if (riskFactsSection) {
    riskFacts = extractListItems(riskFactsSection);
  }

  // Parse slices
  const parsed = parseStageFile(tasksPath);

  // Build slices for manifest
  const slices = parsed.slices.map(slice => {
    // Extract fields from the slice content
    const goal = extractFirstParagraph(extractSection(slice.lines, 'Goal'));
    const observableOutcome = extractFirstParagraph(extractSection(slice.lines, 'Observable Outcome'));
    const publicSeam = extractFirstParagraph(extractSection(slice.lines, 'Public Seam'));

    // Extract dependencies
    const sliceDepsText = extractSection(slice.lines, 'Dependencies');
    const sliceDeps = extractListItems(sliceDepsText)
      .map(item => item.split(/\s+/)[0])
      .filter(id => /^S\d{2,}-[A-Z]$/.test(id));

    // Extract risk facts
    const sliceRiskFactsText = extractSection(slice.lines, 'Risk Facts');
    const sliceRiskFacts = extractListItems(sliceRiskFactsText);

    // Extract tasks
    const tasksText = extractSection(slice.lines, 'Tasks');
    const tasks = extractTaskIds(tasksText);

    // Extract proof obligations from the Proof Obligations section
    const proofObligations: Array<{
      po_id: string;
      behavior: string;
      public_seam: string;
      oracle_source: string;
      success_criteria: string;
      failure_criteria?: string;
      required_observation?: string;
      applicable_risk_facts?: string[];
    }> = [];

    const poDefSection = extractSection(slice.lines, 'Proof Obligations');
    if (poDefSection) {
      // Split by PO entries: each PO block starts with "- PO-"
      const poBlocks = poDefSection.split(/\n\s*-\s*PO-/).slice(1);
      for (const rawBlock of poBlocks) {
        const fullBlock = 'PO-' + rawBlock;
        const poIdMatch = fullBlock.match(/^(PO-S\d{2,}-[A-Z]-\d{2})/);
        if (!poIdMatch) continue;
        const poId = poIdMatch[1];

        // Extract fields from indented sub-list under the PO
        // Format:
        //   - Behavior:
        //   - Public Seam:
        //   - Oracle Source:
        //   - Success / Failure:
        //   - Required Observation:
        //   - Applicable Risk Facts:
        const fieldLines = fullBlock.split('\n')
          .map(l => l.trim())
          .filter(l => l.startsWith('- '));

        const fields = new Map<string, string>();
        for (const line of fieldLines) {
          const match = line.match(/^-\s+(.+?):\s*(.*)$/);
          if (match) {
            const key = match[1].trim().toLowerCase().replace(/[^a-z0-9_\/]+/g, '_');
            const value = match[2].trim();
            fields.set(key, value);
          }
        }

        proofObligations.push({
          po_id: poId,
          behavior: fields.get('behavior') || 'verified',
          public_seam: fields.get('public_seam') || publicSeam,
          oracle_source: fields.get('oracle_source') || '',
          success_criteria: fields.get('success_/_failure') || fields.get('success_failure') || '',
          failure_criteria: undefined,
          required_observation: fields.get('required_observation') || undefined,
          applicable_risk_facts: fields.has('applicable_risk_facts') && fields.get('applicable_risk_facts')!
            ? fields.get('applicable_risk_facts')!.split(',').map(s => s.trim()).filter(Boolean)
            : undefined,
        });
      }
    }

    // Determine SCV minimum level
    const scvLevelMatch = slice.raw.match(/scv_minimum_level["']?\s*:\s*["'](lite|standard|enhanced)["']/);
    const scvMinimumLevel = (scvLevelMatch?.[1] ?? 'standard') as 'lite' | 'standard' | 'enhanced';

    return {
      slice_id: slice.sliceId,
      goal,
      observable_outcome: observableOutcome,
      public_seam: publicSeam,
      dependencies: sliceDeps,
      proof_obligations: proofObligations,
      tasks,
      risk_facts: sliceRiskFacts,
      scv_minimum_level: scvMinimumLevel,
    };
  });

  // ── Helper: parse simple YAML array of objects ──
  // Handles the indentation-based YAML used in Stage Runtime Proof sections.
  // Expected format:
  //   steps:
  //     - id: build
  //       executable: npm
  //       args: [run, build]
  //       cwd: .
  //       timeout_ms: 300000
  //       expected:
  //         exit_code: 0
  function parseYamlSteps(yamlText: string): RuntimeProofStep[] {
    const steps: RuntimeProofStep[] = [];
    const lines = yamlText.split('\n');

    // Find the "steps:" line
    const stepsIdx = lines.findIndex(l => l.trim() === 'steps:');
    if (stepsIdx === -1) return steps;

    // Determine indentation of the first list item under steps
    const restLines = lines.slice(stepsIdx + 1);
    const firstItemIdx = restLines.findIndex(l => l.trim().startsWith('- '));
    if (firstItemIdx === -1) return steps;

    const baseIndent = restLines[firstItemIdx].search(/\S/); // indent of first item marker

    // Split into step blocks (each block starts with "- " at baseIndent)
    const stepBlocks: string[] = [];
    let currentBlock: string[] = [];
    for (const rawLine of restLines.slice(firstItemIdx)) {
      const indent = rawLine.search(/\S/);
      const trimmed = rawLine.trim();
      if (trimmed.length === 0) continue;

      if (indent === baseIndent && trimmed.startsWith('- ')) {
        if (currentBlock.length > 0) {
          stepBlocks.push(currentBlock.join('\n'));
        }
        currentBlock = [trimmed.slice(2).trim()]; // remove "- " prefix
      } else if (currentBlock.length > 0) {
        currentBlock.push(rawLine);
      }
    }
    if (currentBlock.length > 0) {
      stepBlocks.push(currentBlock.join('\n'));
    }

    // Parse each step block into a RuntimeProofStep
    for (const block of stepBlocks) {
      const step: Record<string, unknown> = {};
      const blines = block.split('\n');

      // Detect child indent level for nested objects
      const childIndent = blines.length > 1 ? blines.slice(1).find(l => l.trim().length > 0)?.search(/\S/) ?? 0 : 0;

      let currentKey = '';
      let currentNested: Record<string, unknown> = {};

      for (const raw of blines) {
        const trimmed = raw.trim();
        if (trimmed.length === 0) continue;
        const indent = raw.search(/\S/);

        if (indent === 0 || indent < childIndent) {
          // Top-level key-value or nested key flush
          if (Object.keys(currentNested).length > 0) {
            step[currentKey] = currentNested;
            currentNested = {};
          }
          const match = trimmed.match(/^(.+?):\s*(.*)$/);
          if (match) {
            currentKey = match[1].trim();
            const value = match[2].trim();
            if (value === '') {
              // Value will be filled by nested lines
              step[currentKey] = null;
            } else if (value.startsWith('[') && value.endsWith(']')) {
              // Array: [a, b, c]
              const items = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
              step[currentKey] = items;
            } else if (/^\d+$/.test(value)) {
              step[currentKey] = parseInt(value, 10);
            } else {
              step[currentKey] = value;
            }
          }
        } else if (indent >= childIndent && currentKey) {
          // Nested key-value
          const match = trimmed.match(/^(.+?):\s*(.*)$/);
          if (match) {
            const nk = match[1].trim();
            const nv = match[2].trim();
            currentNested[nk] = /^\d+$/.test(nv) ? parseInt(nv, 10) : nv;
          }
        }
      }

      // Flush any remaining nested object
      if (Object.keys(currentNested).length > 0 && currentKey) {
        step[currentKey] = currentNested;
      }

      if (step.id) {
        const s = step as Record<string, any>;
        const entry: RuntimeProofStep = {
          id: String(s.id),
          executable: String(s.executable ?? ''),
          args: Array.isArray(s.args) ? s.args.map(String) : [],
          cwd: String(s.cwd ?? '.'),
          timeout_ms: typeof s.timeout_ms === 'number' ? s.timeout_ms : 300000,
        };

        // Handle readiness_signal
        if (s.readiness_signal) {
          entry.readiness_signal = String(s.readiness_signal);
        }

        // Handle expected_observation
        if (s.expected_observation) {
          entry.expected_observation = String(s.expected_observation);
        }

        // Handle not_applicable
        if (s.not_applicable && typeof s.not_applicable === 'object') {
          entry.not_applicable = { reason: String((s.not_applicable as Record<string, any>).reason ?? '') };
        }

        // Handle expected block
        if (s.expected && typeof s.expected === 'object') {
          const exp = s.expected as Record<string, any>;
          const expected: Record<string, unknown> = {};
          if (exp.exit_code !== undefined && exp.exit_code !== null) expected.exit_code = Number(exp.exit_code);
          if (exp.output_contains) expected.output_contains = String(exp.output_contains);
          if (exp.output_matches) expected.output_matches = String(exp.output_matches);
          if (Object.keys(expected).length > 0) entry.expected = expected as RuntimeProofStep['expected'];
        }

        steps.push(entry);
      }
    }

    return steps;
  }

  // Build runtime proof steps (extract from Stage Runtime Proof section if present)
  const runtimeProofSection = extractSection(lines, 'Stage Runtime Proof');
  const runtimeProof: RuntimeProofStep[] = [];

  if (runtimeProofSection) {
    const parsed = parseYamlSteps(runtimeProofSection);
    runtimeProof.push(...parsed);
  }

  const manifest: Manifest = {
    stage_id: stageId,
    source_path: tasksPath,
    source_digest: sourceDigest,
    stage_goal: stageGoal,
    outcomes,
    slices,
    dependencies,
    risk_facts: riskFacts,
    runtime_proof: runtimeProof,
    compiled_at: new Date().toISOString(),
    compiled_by: 'compile-manifest.ts',
  };

  return manifest;
}
