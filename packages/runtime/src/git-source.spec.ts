/**
 * gitSource — S02-C-T02 (PO-S02-C-01 data-source part / PO-S02-C-02 source-error part)
 *
 * Verifies the runtime Git source seam against REAL filesystem fixtures:
 * a temporary directory initialized as a REAL git repository (git init +
 * git config + real commits), with real `tasks.md` / evidence files in the
 * canonical layout. No mocks, no cached state files (HP-003).
 *
 * Behaviors under test:
 *   - HEAD is read from `git rev-parse HEAD` (deterministic subprocess).
 *   - per-task checkbox states (`- [x]` / `- [ ]`) are parsed in the
 *     manifest-declared task-ID order, restricted to the slice region
 *     markers (`<!-- SLICE:<id>:BEGIN -->` … `<!-- SLICE:<id>:END -->`)
 *     when present.
 *   - per-task evidence_written (non-placeholder `### <taskId>` subsection
 *     under `## Task Evidence`) and evidence_finalized (the PO-coverage
 *     matrix under `## Current Slice Evidence` is filled / non-placeholder).
 *   - non-git root / git-subdir-as-root → GitSourceError
 *     (RUNTIME.SCHEMA_MISMATCH — Git source unavailable, PO-S02-C-02).
 *   - unborn HEAD (git init without commit) → GitSourceError (fail-closed).
 *   - missing tasks.md → GitSourceError (fail-closed, never guess).
 *   - missing evidence file → evidence_file_present: false with every
 *     evidence fact false (recoverable — reconcile turns the mismatch into
 *     the warn Finding of PO-S02-C-02).
 *   - determinism (HP-003): two reads of the same fixture are deep-equal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  gitSource,
  GitSourceError,
  parseTaskCheckboxes,
  parseEvidenceFacts,
  hasTaskEvidenceWritten,
  isSliceEvidenceFinalized,
  defaultTasksMdPath,
  type GitSourceResult,
} from '@proofloop/runtime';

// ============================================================
// Real-git fixture helpers
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

interface GitFixture {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  head(): string;
  cleanup(): void;
}

/** Create a temp dir initialized as a REAL git repository. */
function makeGitFixture(stageId = 'S02', sliceId = 'S02-C'): GitFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-git-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'git-source@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Git Source Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const fx: GitFixture = {
    root,
    stageId,
    sliceId,
    head: () =>
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Write a real file below the fixture root (relative path). */
function writeFile(root: string, rel: string, content: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/** `git add -A` + commit; returns the new HEAD sha. */
function commitAll(fx: GitFixture, message = 'init'): string {
  execFileSync('git', ['-C', fx.root, 'add', '-A']);
  execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', message]);
  return fx.head();
}

/** Canonical happy-path tasks.md with slice regions. */
function happyTasksMd(sliceId: string, checkedTask: string, uncheckedTask: string): string {
  return [
    `# Stage S02 — Runtime Core`,
    `<!-- SLICE:S02-A:BEGIN -->`,
    `## Slice S02-A — Reducer`,
    `- [x] S02-A-T01: define model`,
    `<!-- SLICE:S02-A:END -->`,
    `<!-- SLICE:${sliceId}:BEGIN -->`,
    `## Slice ${sliceId} — Reconcile`,
    `- [x] ${checkedTask}: first task`,
    `- [ ] ${uncheckedTask}: second task`,
    `<!-- SLICE:${sliceId}:END -->`,
    ``,
  ].join('\n');
}

/** Canonical evidence file: T01 written, PO matrix filled. */
function happyEvidence(sliceId: string, writtenTask: string): string {
  return [
    `# Slice ${sliceId} Evidence`,
    ``,
    `## Task Evidence`,
    ``,
    `### ${writtenTask}`,
    ``,
    `- Task Goal: layout`,
    `- Status: COMPLETE`,
    ``,
    `## Current Slice Evidence`,
    ``,
    `### Proof Obligation Coverage`,
    ``,
    `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
    `|---|---|---|---|---|`,
    `| PO-S02-C-05 | contract | r1 | g1 | PASS |`,
    ``,
    `## Current CV Status`,
    ``,
    `- Status: NOT_RUN`,
    ``,
  ].join('\n');
}

function readGitSource(fx: GitFixture, taskIds: readonly string[]): GitSourceResult {
  return gitSource({
    projectRoot: fx.root,
    stageId: fx.stageId,
    sliceId: fx.sliceId,
    taskIds,
    evidencePath: `delivery/stages/${fx.stageId}/evidence/${fx.sliceId}.md`,
  });
}

// ============================================================
// Happy path — HEAD, checkboxes, evidence facts (PO-S02-C-01)
// ============================================================

describe('gitSource — happy path on a real git fixture (PO-S02-C-01)', () => {
  it('reads HEAD, parses mixed checkboxes in task-ID order, and reads evidence facts', () => {
    const fx = makeGitFixture();
    const taskIds = ['S02-C-T01', 'S02-C-T02'];
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    const head = commitAll(fx);

    const result = readGitSource(fx, taskIds);

    expect(result.head).toBe(head);
    expect(result.head).toMatch(/^[0-9a-f]{40}$/);
    // Checkbox states in the provided task-ID order, mixed checked/unchecked.
    expect(result.tasks).toEqual([
      { task_id: 'S02-C-T01', checked: true },
      { task_id: 'S02-C-T02', checked: false },
    ]);
    // Per-task evidence facts.
    expect(result.evidence).toEqual([
      { task_id: 'S02-C-T01', evidence_written: true },
      { task_id: 'S02-C-T02', evidence_written: false },
    ]);
    expect(result.evidence_file_present).toBe(true);
    expect(result.evidence_finalized).toBe(true);
    // Canonical path facts are surfaced.
    expect(result.tasks_md_path).toBe(
      path.join(fx.root, 'delivery', 'stages', 'S02', 'tasks.md'),
    );
    expect(result.evidence_path).toBe(
      path.join(fx.root, 'delivery', 'stages', 'S02', 'evidence', 'S02-C.md'),
    );
    // gitRoot resolves to the fixture root (path-identical, realpath-safe).
    expect(result.gitRoot).toBe(fs.realpathSync(fx.root));
  });

  it('parses checkbox states only from the slice region when region markers are present', () => {
    const fx = makeGitFixture();
    const tasksMd = [
      `# Stage S02`,
      `<!-- SLICE:S02-A:BEGIN -->`,
      `## Slice S02-A`,
      // A decoy checkbox for the TARGET slice's task id living in ANOTHER
      // slice's region — must be ignored when the S02-C region is present.
      `- [x] S02-C-T01: decoy outside the S02-C region`,
      `<!-- SLICE:S02-A:END -->`,
      `<!-- SLICE:S02-C:BEGIN -->`,
      `## Slice S02-C`,
      `- [ ] S02-C-T01: real unchecked line inside the region`,
      `- [x] S02-C-T02: second task`,
      `<!-- SLICE:S02-C:END -->`,
      ``,
    ].join('\n');
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, tasksMd);
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);

    // Region-scoped parse: the decoy `[x]` outside the region is NOT seen.
    expect(result.tasks).toEqual([
      { task_id: 'S02-C-T01', checked: false },
      { task_id: 'S02-C-T02', checked: true },
    ]);
  });

  it('is deterministic: two reads of the same fixture are deep-equal (HP-003)', () => {
    const fx = makeGitFixture();
    const taskIds = ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'];
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    const first = readGitSource(fx, taskIds);
    const second = readGitSource(fx, taskIds);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ============================================================
// Git source unavailable — structured errors (PO-S02-C-02)
// ============================================================

describe('gitSource — Git source unavailable (PO-S02-C-02)', () => {
  it('throws GitSourceError (RUNTIME.SCHEMA_MISMATCH) when projectRoot is not inside a git work tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-nongit-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });

    let thrown: unknown;
    try {
      gitSource({
        projectRoot: root,
        stageId: 'S02',
        sliceId: 'S02-C',
        taskIds: ['S02-C-T01'],
        evidencePath: 'delivery/stages/S02/evidence/S02-C.md',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitSourceError);
    const err = thrown as GitSourceError;
    expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(err.source).toBe('git');
    expect(err.message).toMatch(/git work tree|git root/);
  });

  it('throws GitSourceError when projectRoot is inside a work tree but is NOT the git root', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    commitAll(fx);
    const subdir = path.join(fx.root, 'delivery');
    expect(fs.existsSync(subdir)).toBe(true);

    let thrown: unknown;
    try {
      gitSource({
        projectRoot: subdir,
        stageId: 'S02',
        sliceId: 'S02-C',
        taskIds: ['S02-C-T01'],
        evidencePath: 'delivery/stages/S02/evidence/S02-C.md',
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitSourceError);
    expect((thrown as GitSourceError).code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect((thrown as GitSourceError).message).toMatch(/not the git root/);
  });

  it('throws GitSourceError on an unborn HEAD (git init without any commit)', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    // No commit — HEAD is unborn.

    let thrown: unknown;
    try {
      readGitSource(fx, ['S02-C-T01']);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitSourceError);
    expect((thrown as GitSourceError).code).toBe('RUNTIME.SCHEMA_MISMATCH');
  });

  it('throws GitSourceError (fail-closed) when tasks.md is missing at the canonical path', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    let thrown: unknown;
    try {
      readGitSource(fx, ['S02-C-T01']);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(GitSourceError);
    expect((thrown as GitSourceError).code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect((thrown as GitSourceError).message).toMatch(/tasks\.md/);
    // Never guess: a missing tasks.md must not silently yield "all unchecked".
  });
});

// ============================================================
// Trust-root boundary (S2-F-003) — symlink / traversal escapes fail closed
// ============================================================

describe('gitSource — trust-root boundary (S2-F-003)', () => {
  function expectTrustBoundaryError(fn: () => GitSourceResult): GitSourceError {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitSourceError);
    const err = thrown as GitSourceError;
    expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(err.message).toMatch(/trust boundary/);
    return err;
  }

  it('throws GitSourceError when the tasks.md file is a symlink to an outside file', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-git-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const outsideTasks = path.join(external, 'tasks.md');
    fs.writeFileSync(outsideTasks, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'), 'utf-8');
    // Replace the tasks.md FILE with a symlink pointing outside the root.
    const tasksMdPath = path.join(fx.root, 'delivery', 'stages', 'S02', 'tasks.md');
    fs.rmSync(tasksMdPath);
    fs.symlinkSync(outsideTasks, tasksMdPath);

    expectTrustBoundaryError(() => readGitSource(fx, ['S02-C-T01', 'S02-C-T02']));
  });

  it('throws GitSourceError when the evidence file is a symlink to an outside file', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-git-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const outsideEvidence = path.join(external, 'evidence.md');
    fs.writeFileSync(outsideEvidence, happyEvidence('S02-C', 'S02-C-T01'), 'utf-8');
    const evidencePath = path.join(fx.root, 'delivery', 'stages', 'S02', 'evidence', 'S02-C.md');
    fs.rmSync(evidencePath);
    fs.symlinkSync(outsideEvidence, evidencePath);

    expectTrustBoundaryError(() => readGitSource(fx, ['S02-C-T01', 'S02-C-T02']));
  });

  it('throws GitSourceError when the tasks.md parent directory is a symlink to an outside dir', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-git-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    // The canonical tasks.md lives in external/<stage>/tasks.md.
    fs.mkdirSync(path.join(external, 'S02'), { recursive: true });
    fs.writeFileSync(path.join(external, 'S02', 'tasks.md'), happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'), 'utf-8');
    // Replace the stage dir with a symlink to the external stage dir.
    const stageDir = path.join(fx.root, 'delivery', 'stages', 'S02');
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.symlinkSync(path.join(external, 'S02'), stageDir, 'dir');

    expectTrustBoundaryError(() => readGitSource(fx, ['S02-C-T01', 'S02-C-T02']));
  });

  it('throws GitSourceError when the evidence path traverses outside the root via ..', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    commitAll(fx);

    const outsideEvidence = path.join(
      path.dirname(fx.root),
      `escape-${path.basename(fx.root)}.md`,
    );
    fs.writeFileSync(outsideEvidence, happyEvidence('S02-C', 'S02-C-T01'), 'utf-8');
    cleanups.push(() => {
      try {
        fs.rmSync(outsideEvidence, { force: true });
      } catch {
        // best-effort cleanup
      }
    });

    expectTrustBoundaryError(() =>
      gitSource({
        projectRoot: fx.root,
        stageId: 'S02',
        sliceId: 'S02-C',
        taskIds: ['S02-C-T01', 'S02-C-T02'],
        evidencePath: `../${path.basename(outsideEvidence)}`,
      }),
    );
  });

  it('legal default paths remain fully functional (no symlink)', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(fx.root, `delivery/stages/S02/evidence/S02-C.md`, happyEvidence('S02-C', 'S02-C-T01'));
    commitAll(fx);

    const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);
    expect(result.tasks).toEqual([
      { task_id: 'S02-C-T01', checked: true },
      { task_id: 'S02-C-T02', checked: false },
    ]);
    expect(result.evidence_file_present).toBe(true);
  });
});

// ============================================================
// Evidence file edge cases
// ============================================================

describe('gitSource — evidence file facts', () => {
  it('tolerates a missing evidence file: evidence_file_present false, all evidence facts false', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    commitAll(fx);

    const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);

    expect(result.evidence_file_present).toBe(false);
    expect(result.evidence).toEqual([
      { task_id: 'S02-C-T01', evidence_written: false },
      { task_id: 'S02-C-T02', evidence_written: false },
    ]);
    expect(result.evidence_finalized).toBe(false);
  });

  it('reports placeholder task section and placeholder PO matrix as not written / not finalized', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(
      fx.root,
      `delivery/stages/S02/evidence/S02-C.md`,
      [
        `# Slice S02-C Evidence`,
        ``,
        `## Task Evidence`,
        ``,
        `*No tasks have been executed yet.*`,
        ``,
        `## Current Slice Evidence`,
        ``,
        `### Proof Obligation Coverage`,
        ``,
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
        `|---|---|---|---|---|`,
        `| *None* | | | | |`,
        ``,
        `## Current CV Status`,
        ``,
        `- Status: NOT_RUN`,
        ``,
      ].join('\n'),
    );
    commitAll(fx);

    const result = readGitSource(fx, ['S02-C-T01', 'S02-C-T02']);

    expect(result.evidence_file_present).toBe(true);
    expect(result.evidence).toEqual([
      { task_id: 'S02-C-T01', evidence_written: false },
      { task_id: 'S02-C-T02', evidence_written: false },
    ]);
    expect(result.evidence_finalized).toBe(false);
  });

  it('evidence_finalized is false when the PO matrix has only a header and separator', () => {
    const fx = makeGitFixture();
    writeFile(fx.root, `delivery/stages/S02/tasks.md`, happyTasksMd('S02-C', 'S02-C-T01', 'S02-C-T02'));
    writeFile(
      fx.root,
      `delivery/stages/S02/evidence/S02-C.md`,
      [
        `# Slice S02-C Evidence`,
        ``,
        `## Task Evidence`,
        ``,
        `### S02-C-T01`,
        ``,
        `- Task Goal: layout`,
        ``,
        `## Current Slice Evidence`,
        ``,
        `### Proof Obligation Coverage`,
        ``,
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
        `|---|---|---|---|---|`,
        ``,
      ].join('\n'),
    );
    commitAll(fx);

    const result = readGitSource(fx, ['S02-C-T01']);
    expect(result.evidence).toEqual([{ task_id: 'S02-C-T01', evidence_written: true }]);
    expect(result.evidence_finalized).toBe(false);
  });
});

// ============================================================
// Pure parsing helpers (exported seam)
// ============================================================

describe('parseTaskCheckboxes / parseEvidenceFacts — pure parsers', () => {
  it('parseTaskCheckboxes returns results in the provided task-ID order and defaults missing ids to unchecked', () => {
    const content = [
      `- [x] S02-C-T01: first`,
      `- [ ] S02-C-T02: second`,
      `- [X] S02-C-T03: uppercase checked`,
      `- [ ] S02-C-T01: duplicate line (last wins, same value)`,
      ``,
    ].join('\n');
    const states = parseTaskCheckboxes(content, ['S02-C-T03', 'S02-C-T01', 'S02-C-T99']);
    expect(states).toEqual([
      { task_id: 'S02-C-T03', checked: true },
      { task_id: 'S02-C-T01', checked: false },
      { task_id: 'S02-C-T99', checked: false },
    ]);
  });

  it('parseTaskCheckboxes falls back to whole-document parsing when slice region markers are absent', () => {
    const content = [
      `## Slice S02-C`,
      `- [x] S02-C-T01: first`,
      `- [ ] S02-C-T02: second`,
      ``,
    ].join('\n');
    expect(parseTaskCheckboxes(content, ['S02-C-T01', 'S02-C-T02'], 'S02-C')).toEqual([
      { task_id: 'S02-C-T01', checked: true },
      { task_id: 'S02-C-T02', checked: false },
    ]);
  });

  it('hasTaskEvidenceWritten / isSliceEvidenceFinalized / parseEvidenceFacts', () => {
    const written = happyEvidence('S02-C', 'S02-C-T01');
    expect(hasTaskEvidenceWritten(written, 'S02-C-T01')).toBe(true);
    expect(hasTaskEvidenceWritten(written, 'S02-C-T02')).toBe(false);
    expect(isSliceEvidenceFinalized(written)).toBe(true);

    const placeholder = [
      `## Task Evidence`,
      ``,
      `*No tasks have been executed yet.*`,
      ``,
      `## Current Slice Evidence`,
      ``,
      `### Proof Obligation Coverage`,
      ``,
      `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
      `|---|---|---|---|---|`,
      `| *None* | | | | |`,
      ``,
    ].join('\n');
    expect(hasTaskEvidenceWritten(placeholder, 'S02-C-T01')).toBe(false);
    expect(isSliceEvidenceFinalized(placeholder)).toBe(false);

    const facts = parseEvidenceFacts(written, ['S02-C-T01', 'S02-C-T02']);
    expect(facts).toEqual({
      evidence: [
        { task_id: 'S02-C-T01', evidence_written: true },
        { task_id: 'S02-C-T02', evidence_written: false },
      ],
      evidence_finalized: true,
    });
  });

  it('defaultTasksMdPath resolves the canonical tasks.md location', () => {
    expect(defaultTasksMdPath('/project', 'S02')).toBe(
      path.join('/project', 'delivery', 'stages', 'S02', 'tasks.md'),
    );
  });
});
