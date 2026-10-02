/**
 * @proofloop/runtime — bounded accepted-Plan execution-graph reader
 * (ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.1.3 / §2.2.2,
 * architecture #/entities/planning-acceptance-succession).
 *
 * R2-B lane-start machinery: the Runtime must NOT ask Brain to supply the
 * accepted-Plan task/dependency graph, a graph digest, or parse Plan Markdown.
 * Instead this module owns the ONE bounded reader that resolves the durable
 * accepted-Plan identity and reconstructs the execution-graph capability in
 * the SAME Node process as the materializer/transaction, so the module-private
 * WeakSet brand of `buildAcceptedPlanTaskGraph` stays valid.
 *
 * Contract (G6):
 *
 *   - the ENTRY is the durable `PLAN_ACCEPTANCE.plan_binding.accepted_plan_ref`
 *     resolved from current MES state — never a hard-coded `plan.md` /
 *     `thin-plan.md` filename;
 *   - the text is the EXACT accepted Plan blob at the accepted generation's
 *     canonical Git basis (`git show <git_basis.head>:<accepted_plan_ref>`),
 *     never the current worktree file when that Git basis differs;
 *   - SHA-256 over those exact blob bytes must equal the durable
 *     `plan_binding.plan_digest` (exact equality, fail closed, no recompute
 *     substitution);
 *   - EXACTLY ONE supported execution-graph grammar must match:
 *       1. framework `delivery/stages/Sxx/plan.md` — Markdown containing ONE
 *          canonical fenced-YAML execution graph
 *          (`stage/slices/tasks/dependencies`, supported optional
 *          `blocked_by`); or
 *       2. product legacy `delivery/stages/Sxx/thin-plan.md` — Markdown
 *          Slice/Task headings plus task-level `depends_on` fields.
 *     Both-match, neither-match, duplicate graph blocks, malformed
 *     task/dependency identity, dangling dependencies, non-dependency
 *     `blocked_by` and an execution-semantic field the selected grammar does
 *     not understand are all typed no-write errors;
 *   - normalization keeps ONLY Stage/Slice/Task identity, task order,
 *     dependencies and supported optional `blocked_by`, then delegates to
 *     `buildAcceptedPlanTaskGraph` (the single producer) which performs the
 *     canonical-id / duplicate / cycle / dangling-edge / blocked_by⊆dependencies
 *     closure and mints the opaque branded capability.
 *
 * This module performs NO route / next-action / reasoning decisions and reads
 * Git only through the existing read-only `git show` pattern used by other
 * Runtime seams.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { buildAcceptedPlanTaskGraph, type AcceptedPlanTaskGraph } from '../execute/plan-task-graph';
import { materializeFail } from './materialization-error';
import { isCanonicalRootRelativeRef } from './binding';
import { MES_SLICE_ID_RE, MES_TASK_ID_RE } from './types';

const GIT_MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** Parseable execution-graph facts normalized from one accepted Plan blob. */
interface ExecGraphSlice {
  readonly slice: string;
  readonly tasks: readonly ExecGraphTask[];
}
interface ExecGraphTask {
  readonly task: string;
  readonly dependencies: readonly string[];
  readonly blocked_by?: readonly string[];
}

/** The closed per-marker vocabulary is what the reader understands; see module doc. */
const EXECUTION_SEMANTIC_KEY_RE = /depend|block|order|parallel|sequen|successor|edge|graph|run/i;

function isFencedYamlStart(line: string): boolean {
  return /^```yaml\s*$/i.test(line);
}

function isFenceEnd(line: string): boolean {
  return /^```\s*$/.test(line);
}

/** Split one YAML inline array value (`[]`, `[A, B]`, `[ A , B ]`) into trimmed items. */
function parseInlineArray(rest: string): string[] | undefined {
  const trimmed = rest.trim();
  if (trimmed.startsWith('[')) {
    if (!trimmed.endsWith(']')) {
      materializeFail('invalid-derived-fact', 'accepted Plan execution graph: malformed inline array (missing closing bracket)');
    }
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  }
  return undefined;
}

/** Collect the executed-graph facts of ONE fenced-YAML block (`slices:` top-level). */
function parseFrameworkGraph(block: string, acceptedPlanRef: string): readonly ExecGraphSlice[] {
  const lines = block.split('\n');
  const slices: ExecGraphSlice[] = [];
  let currentSlice: ExecGraphSlice | null = null;
  let sliceTasks: { task: string; dependencies: string[]; blocked_by?: string[] }[] = [];
  let currentTask: { task: string; dependencies: string[]; blocked_by?: string[] } | null = null;
  let expectingTaskDepBlock = false;
  let expectingTaskBlockedBlock = false;
  let seenSlicesKey = false;

  const pushTask = (): void => {
    if (currentTask !== null) {
      sliceTasks.push(currentTask);
      currentTask = null;
    }
  };
  const pushSlice = (): void => {
    pushTask();
    if (currentSlice !== null) {
      slices.push({ slice: currentSlice.slice, tasks: sliceTasks });
    }
    sliceTasks = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // R2-B / G6 fail-closed: an execution-semantic key this grammar does not
    // understand fails at EVERY grammar level (top / slice / task) — never
    // silently dropped at the Slice level. The closed per-level known set:
    //   - top level: no execution keys (slices: is the structural marker)
    //   - slice level: depends_on (real framework plans carry it)
    //   - task level: dependencies / blocked_by
    const execKeyLine = /^([A-Za-z0-9_]+):/.exec(trimmed);
    if (execKeyLine && EXECUTION_SEMANTIC_KEY_RE.test(execKeyLine[1])) {
      const knownExecKeys =
        currentTask !== null
          ? new Set(['dependencies', 'blocked_by'])
          : currentSlice !== null
            ? new Set(['depends_on'])
            : new Set<string>();
      if (!knownExecKeys.has(execKeyLine[1])) {
        materializeFail(
          'invalid-derived-fact',
          `accepted Plan execution graph carries execution-semantic field ${JSON.stringify(execKeyLine[1])} that the framework grammar does not understand at this level (${acceptedPlanRef}) — no-write`,
        );
      }
    }

    // Top-level markers (execution graph structure only).
    if (indent === 0) {
      if (/^slices:\s*$/.test(trimmed)) {
        seenSlicesKey = true;
        pushSlice();
        currentSlice = null;
        continue;
      }
      // any other top-level YAML key (stage, project_stage_map_ref, ...) is
      // planning metadata, never execution-graph facts — skip it.
      continue;
    }

    if (/^- slice:\s+(\S+)/.test(trimmed)) {
      const match = /^- slice:\s+(\S+)/.exec(trimmed)!;
      if (!MES_SLICE_ID_RE.test(match[1])) {
        materializeFail('invalid-derived-fact', `accepted Plan execution graph carries a non-canonical slice id ${JSON.stringify(match[1])} (${acceptedPlanRef})`);
      }
      pushSlice();
      currentSlice = { slice: match[1], tasks: [] };
      currentTask = null;
      expectingTaskDepBlock = false;
      expectingTaskBlockedBlock = false;
      continue;
    }
    if (currentSlice === null) continue;

    if (/^tasks:\s*$/.test(trimmed) && indent >= 2) {
      pushTask();
      continue;
    }
    if (/^- task:\s+(\S+)/.test(trimmed) && indent >= 4) {
      const match = /^- task:\s+(\S+)/.exec(trimmed)!;
      if (!MES_TASK_ID_RE.test(match[1])) {
        materializeFail('invalid-derived-fact', `accepted Plan execution graph carries a non-canonical task id ${JSON.stringify(match[1])} (${acceptedPlanRef})`);
      }
      pushTask();
      currentTask = { task: match[1], dependencies: [], blocked_by: [] };
      expectingTaskDepBlock = false;
      expectingTaskBlockedBlock = false;
      continue;
    }
    if (currentTask === null) continue;

    // Task-level list markers.
    if (/^dependencies:\s*$/.test(trimmed) && indent >= 6) {
      expectingTaskDepBlock = true;
      expectingTaskBlockedBlock = false;
      currentTask.dependencies = [];
      continue;
    }
    if (/^blocked_by:\s*$/.test(trimmed) && indent >= 6) {
      expectingTaskBlockedBlock = true;
      expectingTaskDepBlock = false;
      currentTask.blocked_by = [];
      continue;
    }
    if (expectingTaskDepBlock || expectingTaskBlockedBlock) {
      if (/^- /.test(trimmed) && indent >= 8) {
        const item = trimmed.slice(2).trim();
        if (!MES_TASK_ID_RE.test(item)) {
          materializeFail('invalid-derived-fact', `accepted Plan dependency/blocked_by item ${JSON.stringify(item)} is not a canonical task id (${acceptedPlanRef})`);
        }
        if (expectingTaskDepBlock) currentTask.dependencies.push(item);
        else currentTask.blocked_by!.push(item);
        continue;
      }
      // A non-list line ending the block list.
      expectingTaskDepBlock = false;
      expectingTaskBlockedBlock = false;
    }

    // Inline `key: [...]` on the SAME line (execution-graph keys only).
    const inlineKey = /^(dependencies|blocked_by):\s*(.*)$/.exec(trimmed);
    if (inlineKey && indent >= 6) {
      const key = inlineKey[1];
      const items = parseInlineArray(inlineKey[2]);
      if (items === undefined) {
        materializeFail('invalid-derived-fact', `accepted Plan ${key} must be an inline array or a block list (${acceptedPlanRef})`);
      }
      for (const item of items) {
        if (!MES_TASK_ID_RE.test(item)) {
          materializeFail('invalid-derived-fact', `accepted Plan ${key} item ${JSON.stringify(item)} is not a canonical task id (${acceptedPlanRef})`);
        }
      }
      if (key === 'dependencies') currentTask.dependencies = items;
      else currentTask.blocked_by = items;
      expectingTaskDepBlock = false;
      expectingTaskBlockedBlock = false;
      continue;
    }

    // (the per-level closed-set guard at the loop head already fails closed
    // on any execution-semantic key this grammar does not understand at any
    // level — top / slice / task; every other field here is planning content
    // and is intentionally ignored).
  }

  pushSlice();
  if (!seenSlicesKey) {
    materializeFail('invalid-derived-fact', `accepted Plan fenced-YAML block has no slices: execution graph (${acceptedPlanRef})`);
  }
  if (slices.length === 0) {
    materializeFail('invalid-derived-fact', `accepted Plan fenced-YAML block declares no slices (${acceptedPlanRef})`);
  }
  return slices;
}

/** Extract the executed-graph facts of the legacy Markdown Slice/Task grammar. */
function parseLegacyGraph(text: string, acceptedPlanRef: string): readonly ExecGraphSlice[] {
  const slices: ExecGraphSlice[] = [];
  let currentSlice: string | null = null;
  let currentTask: { task: string; dependencies: string[] } | null = null;
  let pendingTasks: { task: string; dependencies: string[] }[] = [];

  const pushTask = (): void => {
    if (currentTask !== null) {
      pendingTasks.push(currentTask);
      currentTask = null;
    }
  };
  const pushSlice = (): void => {
    pushTask();
    if (currentSlice !== null) {
      slices.push({ slice: currentSlice, tasks: pendingTasks });
    }
    pendingTasks = [];
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    const sliceHeading = /^###\s+Slice\s+(\S+)/.exec(line);
    if (sliceHeading) {
      const id = sliceHeading[1];
      if (!MES_SLICE_ID_RE.test(id)) {
        materializeFail('invalid-derived-fact', `accepted Plan legacy grammar carries a non-canonical slice id ${JSON.stringify(id)} (${acceptedPlanRef})`);
      }
      pushSlice();
      currentSlice = id;
      continue;
    }

    const taskHeading = /^####\s+(\S+)/.exec(line);
    if (taskHeading && currentSlice !== null) {
      const id = taskHeading[1];
      if (!MES_TASK_ID_RE.test(id)) {
        materializeFail('invalid-derived-fact', `accepted Plan legacy grammar carries a non-canonical task id ${JSON.stringify(id)} (${acceptedPlanRef})`);
      }
      pushTask();
      currentTask = { task: id, dependencies: [] };
      continue;
    }
    // R2-B / G6 fail-closed: between a Slice heading and its first Task
    // heading, an execution-semantic field this legacy grammar does not
    // understand at the Slice level is a typed no-write — never silently
    // dropped. depends_on belongs ONLY to the task level in this grammar, so
    // any execution-semantic bullet here fails closed (Slice scope,
    // currentTask === null).
    if (currentSlice !== null && currentTask === null) {
      const sliceExec = /^[-*]\s+`?([A-Za-z0-9_]+)`?\s*[：:]/.exec(line);
      if (sliceExec && EXECUTION_SEMANTIC_KEY_RE.test(sliceExec[1])) {
        materializeFail(
          'invalid-derived-fact',
          `accepted Plan legacy grammar carries execution-semantic field ${JSON.stringify(sliceExec[1])} at the Slice level it does not understand (${acceptedPlanRef}) — no-write`,
        );
      }
    }
    if (currentTask === null || currentSlice === null) continue;

    // Task-level execution-semantic field: depends_on (closed grammar).
    const dependsOn = /^[-*]\s+`?depends_on`?\s*[：:]\s*(.*)$/.exec(line);
    if (dependsOn) {
      const value = dependsOn[1].trim();
      if (value.length === 0 || value === '—' || value === '-') {
        currentTask.dependencies = [];
        continue;
      }
      const items = value.split(/[、，,;\s]+/).map((item) => item.trim()).filter((item) => item.length > 0);
      for (const item of items) {
        if (!MES_TASK_ID_RE.test(item)) {
          materializeFail('invalid-derived-fact', `accepted Plan legacy depends_on item ${JSON.stringify(item)} is not a canonical task id (${acceptedPlanRef})`);
        }
      }
      currentTask.dependencies = items;
      continue;
    }

    // Any other bullet with an execution-semantic field name that this grammar
    // does not understand fails closed (never silently dropped).
    const execField = /^[-*]\s+`?([A-Za-z0-9_]+)`?\s*[：:]/.exec(line);
    if (execField && EXECUTION_SEMANTIC_KEY_RE.test(execField[1]) && execField[1].toLowerCase() !== 'depends_on') {
      materializeFail(
        'invalid-derived-fact',
        `accepted Plan legacy grammar carries execution-semantic field ${JSON.stringify(execField[1])} it does not understand (${acceptedPlanRef}) — no-write`,
      );
    }
  }

  pushSlice();
  if (slices.length === 0) {
    materializeFail('invalid-derived-fact', `accepted Plan legacy grammar declares no Slice/Task section (${acceptedPlanRef})`);
  }
  return slices;
}

/** Detect exactly one supported grammar; both/neither/duplicate → fail closed. */
function normalizeExecGraph(text: string, acceptedPlanRef: string): { slices: readonly ExecGraphSlice[] } {
  // Framework grammar: exactly ONE fenced-YAML block containing a `slices:` execution graph.
  const fencedBlocks: string[] = [];
  let inBlock = false;
  let currentBlock = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!inBlock) {
      if (isFencedYamlStart(line)) {
        inBlock = true;
        currentBlock = '';
      }
      continue;
    }
    if (isFenceEnd(line)) {
      inBlock = false;
      fencedBlocks.push(currentBlock);
      continue;
    }
    currentBlock += line + '\n';
  }

  const isGraphBlock = (block: string): boolean =>
    block.split('\n').some((line) => /^\s*slices:\s*$/.test(line)) &&
    /(^|\n)\s*-\s+slice\s*:/m.test(block);
  const graphBlocks = fencedBlocks.filter(isGraphBlock);
  const hasLegacy = /^###\s+Slice\s+(\S+)/m.test(text) && /^####\s+S\d+-[A-Z]+-T\d+/m.test(text);

  if (graphBlocks.length > 1) {
    materializeFail(
      'invalid-derived-fact',
      `accepted Plan ${acceptedPlanRef} carries ${graphBlocks.length} execution-graph blocks — duplicate graph block, no-write`,
    );
  }
  if (graphBlocks.length === 1 && hasLegacy) {
    materializeFail(
      'invalid-derived-fact',
      `accepted Plan ${acceptedPlanRef} matches BOTH the framework fenced-YAML graph and the legacy Slice/Task grammar — exactly one supported grammar required, no-write`,
    );
  }
  if (graphBlocks.length === 1) {
    return { slices: parseFrameworkGraph(graphBlocks[0], acceptedPlanRef) };
  }
  if (hasLegacy) {
    return { slices: parseLegacyGraph(text, acceptedPlanRef) };
  }
  materializeFail(
    'invalid-derived-fact',
    `accepted Plan ${acceptedPlanRef} matches NEITHER the framework fenced-YAML graph nor the legacy Slice/Task grammar — no-write`,
  );
}

/** Read the EXACT accepted Plan blob bytes at the accepted generation's Git basis. */
function readAcceptedPlanBlob(gitRoot: string, gitBasisHead: string, acceptedPlanRef: string): Buffer {
  if (!/^[0-9a-f]{40}$/.test(gitBasisHead)) {
    materializeFail(
      'invalid-derived-fact',
      `accepted Plan ${JSON.stringify(acceptedPlanRef)} has no valid canonical Git basis head ${JSON.stringify(gitBasisHead)} — no-write`,
    );
  }
  try {
    return execFileSync('git', ['show', `${gitBasisHead}:${acceptedPlanRef}`], {
      cwd: gitRoot,
      encoding: 'buffer',
      maxBuffer: GIT_MAX_BLOB_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    materializeFail(
      'invalid-derived-fact',
      `accepted Plan blob ${JSON.stringify(acceptedPlanRef)} is not readable at Git basis ${JSON.stringify(gitBasisHead)} under ${gitRoot} — the current worktree file is never substituted, no-write`,
    );
  }
}

export interface AcceptedPlanGraphReadInput {
  readonly gitRoot: string;
  readonly acceptedPlanRef: string;
  readonly expectedPlanDigest: string;
  readonly gitBasisHead: string;
}

/**
 * Reconstruct the branded accepted-Plan execution-graph capability from the
 * durable accepted-Plan identity + its canonical Git basis (R2-B / G6).
 *
 * @returns the brittle-branded `AcceptedPlanTaskGraph` minted in THIS process.
 *   The exact blob bytes are hash-verified against the durable
 *   `plan_digest` BEFORE grammar detection; every fail is a typed no-write.
 */
export function readAcceptedPlanExecutionGraph(input: AcceptedPlanGraphReadInput): AcceptedPlanTaskGraph {
  const { gitRoot, acceptedPlanRef, expectedPlanDigest, gitBasisHead } = input;
  if (typeof acceptedPlanRef !== 'string' || !isCanonicalRootRelativeRef(acceptedPlanRef)) {
    materializeFail('invalid-derived-fact', `accepted_plan_ref ${JSON.stringify(acceptedPlanRef)} is not a canonical root-relative ref — no-write`);
  }
  if (typeof expectedPlanDigest !== 'string' || !/^[0-9a-f]{64}$/.test(expectedPlanDigest)) {
    materializeFail('invalid-derived-fact', `accepted Plan plan_digest ${JSON.stringify(expectedPlanDigest)} is not a 64-hex SHA-256 — no-write`);
  }

  const blob = readAcceptedPlanBlob(gitRoot, gitBasisHead, acceptedPlanRef);
  const observed = createHash('sha256').update(blob).digest('hex');
  if (observed !== expectedPlanDigest) {
    materializeFail(
      'binding-mismatch',
      `accepted Plan blob SHA-256 ${observed} does not equal the durable plan_binding.plan_digest ${expectedPlanDigest} (${acceptedPlanRef} at ${gitBasisHead}) — no-write`,
    );
  }

  const { slices } = normalizeExecGraph(blob.toString('utf8'), acceptedPlanRef);
  const planObject: Record<string, unknown> = {
    slices: slices.map((slice) => ({
      slice: slice.slice,
      tasks: slice.tasks.map((task) => {
        const obj: Record<string, unknown> = {
          task: task.task,
          dependencies: [...task.dependencies],
        };
        if (task.blocked_by !== undefined) obj.blocked_by = [...task.blocked_by];
        return obj;
      }),
    })),
  };

  try {
    // Same-process mint: the WeakSet brand stays valid for the transaction.
    return buildAcceptedPlanTaskGraph(planObject, acceptedPlanRef, expectedPlanDigest);
  } catch (error) {
    materializeFail(
      'invalid-derived-fact',
      `accepted Plan execution graph construction failed: ${error instanceof Error ? error.message : String(error)} (${acceptedPlanRef}) — no-write`,
    );
  }
}

/** Convenience guard: human-readable git root for the reader. */
export function assertGitRootPresent(root: string): string {
  if (typeof root !== 'string' || root.length === 0) {
    materializeFail('unreadable', 'accepted-Plan graph reader requires a non-empty canonical project root — no-write');
  }
  return path.resolve(root);
}