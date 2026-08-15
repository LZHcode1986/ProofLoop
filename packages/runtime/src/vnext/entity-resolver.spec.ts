/**
 * vNext stable entity marker resolver — S0-A bootstrap, task 2 tests.
 *
 * Real-filesystem fixtures (temp dirs, no mocks except the deterministic
 * post-read TOCTOU simulation). Proves:
 *   - explicit `<!-- proofloop:entity id kind -->` markers resolve with
 *     reproducible file/section digests;
 *   - duplicate / missing / kind-mismatch / heading-only / ambiguous markers
 *     fail closed;
 *   - root escape, absolute path, `..` traversal, symlink escape and
 *     non-regular files fail closed;
 *   - a post-read identity/metadata change (TOCTOU) fails closed;
 *   - JSON artifacts support ONLY the explicit `entities` map form;
 *     every other `#/...` fragment is clearly rejected (no fuzzy search);
 *   - normalization touches only UTF-8 / newlines / trailing whitespace
 *     (semantic body preserved).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveVNextReference,
  parseEntityMarkers,
  normalizeEntityText,
  readRootBoundFile,
  assertFileUnchanged,
  VNextEntityResolutionError,
} from '@proofloop/runtime';
import { canonicalJson } from '@proofloop/kernel';

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-entity-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

function sha(text: string): string {
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

const MD = [
  '# Stage S04',
  '',
  '<!-- proofloop:entity id="S04-goal" kind="goal" -->',
  'The stage goal.',
  '',
  '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
  '- [ ] S04-A-T01 do the thing',
  '',
  '<!-- proofloop:entity id="S04-A-accept" kind="acceptance" -->',
  'Acceptance body',
  '',
].join('\n');

describe('parseEntityMarkers — explicit marker grammar', () => {
  it('resolves explicit markers with marker-delimited section ranges', () => {
    const entities = parseEntityMarkers(MD);
    expect(entities.map((e) => e.id)).toEqual(['S04-goal', 'S04-A-T01', 'S04-A-accept']);
    expect(entities[0].kind).toBe('goal');
    // Section content is marker-delimited: the goal entity stops at the next
    // entity marker, never at a heading.
    expect(entities[0].content).toContain('The stage goal.');
    expect(entities[0].content).not.toContain('- [ ]');
    expect(entities[1].content).toContain('- [ ] S04-A-T01');
    // lineStart/lineEnd are 0-based raw indices; marker line is included.
    expect(entities[0].lineStart).toBe(2);
    expect(entities[0].lineEnd).toBe(5);
  });

  it('normalization strips trailing whitespace but preserves semantic body', () => {
    const withTrailing = 'body line   \nsecond line\t\n\n';
    const normalized = normalizeEntityText(withTrailing);
    expect(normalized).toBe('body line\nsecond line\n\n');
    expect(normalized).not.toBe('body line\nsecond line'); // body structure preserved
  });

  it('normalizes CRLF to LF deterministically', () => {
    expect(normalizeEntityText('a\r\nb\r\n')).toBe('a\nb\n');
  });

  it('fails closed on a duplicate entity id', () => {
    const dup = [
      '<!-- proofloop:entity id="E" kind="goal" -->',
      'one',
      '<!-- proofloop:entity id="E" kind="task" -->',
      'two',
    ].join('\n');
    expect(() => parseEntityMarkers(dup)).toThrowError(/Duplicate entity id "E"/);
  });

  it('fails closed on an ambiguous marker (extra attribute)', () => {
    const ambiguous = '<!-- proofloop:entity id="E" kind="goal" extra="x" -->\nbody';
    expect(() => parseEntityMarkers(ambiguous)).toThrowError(VNextEntityResolutionError);
    expect(() => parseEntityMarkers(ambiguous)).toThrowError(/ambiguous/);
  });

  it('fails closed on an ambiguous marker (prose mention in a comment)', () => {
    const ambiguous = '<!-- do not use proofloop:entity here -->\nbody';
    expect(() => parseEntityMarkers(ambiguous)).toThrowError(/ambiguous/);
  });

  it('fails closed on an unknown kind', () => {
    const bad = '<!-- proofloop:entity id="E" kind="bogus" -->\nbody';
    expect(() => parseEntityMarkers(bad)).toThrowError(/unknown kind "bogus"/);
  });

  it('heading-only content (no explicit marker) resolves to nothing', () => {
    const entities = parseEntityMarkers('# Stage\n\n## Goal\n\nno marker here');
    expect(entities).toHaveLength(0);
  });
});

describe('resolveVNextReference — happy path & digests', () => {
  it('resolves a valid Markdown entity with reproducible file/section digests', () => {
    const root = makeTempRoot();
    write(root, 'tasks.md', MD);
    const a = resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-A-T01', expectedKind: 'task' });
    const b = resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-A-T01', expectedKind: 'task' });
    expect(a.entityId).toBe('S04-A-T01');
    expect(a.kind).toBe('task');
    expect(a.filePath).toBe(path.join(root, 'tasks.md'));
    // Reproducible digests across reads.
    expect(a.fileDigest).toBe(b.fileDigest);
    expect(a.sectionDigest).toBe(b.sectionDigest);
    // Section digest covers the canonical path + canonical entity ref + body,
    // not the whole file — they differ.
    expect(a.sectionDigest).not.toBe(a.fileDigest);
    // Expected digest = §7.6 SHA-256(canonical_path + canonical_entity_ref
    // + normalized_section_content).
    const content = normalizeEntityText('- [ ] S04-A-T01 do the thing\n');
    expect(a.sectionDigest).toBe(
      sha('tasks.md' + 'tasks.md#/entities/S04-A-T01' + content),
    );
    expect(a.content).toBe(content);
  });

  it('binds equal section bodies to both canonical path and canonical entity ref', () => {
    const root = makeTempRoot();
    const sameBody = 'same body\n';
    const markdown = `<!-- proofloop:entity id="E" kind="goal" -->\n${sameBody}`;
    write(root, 'one.md', markdown);
    write(root, 'two.md', markdown);

    const firstPath = resolveVNextReference({ root, ref: 'one.md#/entities/E' });
    const secondPath = resolveVNextReference({ root, ref: 'two.md#/entities/E' });
    expect(firstPath.content).toBe(secondPath.content);
    expect(firstPath.sectionDigest).not.toBe(secondPath.sectionDigest);

    write(
      root,
      'same-path.json',
      JSON.stringify({
        entities: {
          first: { kind: 'goal', content: { body: 'same body' } },
          second: { kind: 'goal', content: { body: 'same body' } },
        },
      }),
    );
    const firstRef = resolveVNextReference({ root, ref: 'same-path.json#/entities/first' });
    const secondRef = resolveVNextReference({ root, ref: 'same-path.json#/entities/second' });
    expect(firstRef.content).toBe(secondRef.content);
    expect(firstRef.sectionDigest).not.toBe(secondRef.sectionDigest);
  });

  it('content change changes the section digest (never a stale binding)', () => {
    const root = makeTempRoot();
    const file = write(root, 'tasks.md', MD);
    const before = resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-A-T01' });
    fs.writeFileSync(file, MD.replace('do the thing', 'do the other thing'), 'utf-8');
    const after = resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-A-T01' });
    expect(after.sectionDigest).not.toBe(before.sectionDigest);
    expect(after.fileDigest).not.toBe(before.fileDigest);
  });

  it('keeps Plan reference file and section digests stable when the checkbox projection flips', () => {
    // Mutable Execution Projection mirror of delivery/stages/S08/tasks.md:
    // `- checkbox: `[ ]`` / `- checkbox: `[x]`` — execution-only projection,
    // so flipping it must not invalidate the tasks.md digest bindings.
    const root = makeTempRoot();
    const md = [
      '# Stage S04',
      '',
      '<!-- proofloop:entity id="S04-goal" kind="goal" -->',
      'The stage goal.',
      '',
      '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
      '- [ ] S04-A-T01 do the thing',
      '',
      '### Mutable Execution Projection',
      '- checkbox: `[ ]`',
      '- Worker Status: `NOT_STARTED`',
      '- Current CV Status: `NOT_RUN`',
      '',
      '<!-- proofloop:entity id="S04-A-accept" kind="acceptance" -->',
      'Acceptance body',
      '',
    ].join('\n');
    const file = write(root, 'tasks.md', md);
    const before = resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-A-T01', expectedKind: 'task' });
    fs.writeFileSync(
      file,
      md.replace('- checkbox: `[ ]`', '- checkbox: `[x]`'),
      'utf-8',
    );
    const after = resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-A-T01', expectedKind: 'task' });
    expect(after.fileDigest).toBe(before.fileDigest);
    expect(after.sectionDigest).toBe(before.sectionDigest);
  });

  it('resolves a JSON artifact through the explicit top-level entities map', () => {
    const root = makeTempRoot();
    const content = { z: 1, a: 'The goal' };
    write(
      root,
      'contracts.json',
      JSON.stringify({
        entities: {
          'S04-goal': { kind: 'goal', content },
        },
      }),
    );
    const resolved = resolveVNextReference({ root, ref: 'contracts.json#/entities/S04-goal', expectedKind: 'goal' });
    expect(resolved.kind).toBe('goal');
    expect(resolved.content).toBe(canonicalJson(content));
    expect(resolved.sectionDigest).toBe(
      sha('contracts.json' + 'contracts.json#/entities/S04-goal' + canonicalJson(content)),
    );
  });
});

describe('resolveVNextReference — fail-closed ref grammar', () => {
  const root = (): string => makeTempRoot();

  it('rejects a missing "#" fragment', () => {
    expect(() => resolveVNextReference({ root: root(), ref: 'tasks.md' })).toThrowError(
      VNextEntityResolutionError,
    );
  });

  it('rejects a plain JSON pointer fragment (no fuzzy search)', () => {
    expect(() =>
      resolveVNextReference({ root: root(), ref: 'data.json#/slices/0' }),
    ).toThrowError(/not supported/);
    expect(() =>
      resolveVNextReference({ root: root(), ref: 'data.json#/slices/0' }),
    ).toThrowError(/no full-text search/);
  });

  it('rejects an empty entity id fragment', () => {
    expect(() => resolveVNextReference({ root: root(), ref: 'tasks.md#/entities/' })).toThrowError(
      /not supported|ambiguous/,
    );
  });

  it('rejects a JSON artifact without an explicit entities map', () => {
    const r = root();
    write(r, 'data.json', JSON.stringify({ slices: [] }));
    expect(() =>
      resolveVNextReference({ root: r, ref: 'data.json#/entities/S04-goal' }),
    ).toThrowError(/no top-level "entities" object/);
  });

  it('rejects an entity missing from the JSON entities map', () => {
    const r = root();
    write(r, 'data.json', JSON.stringify({ entities: { other: { kind: 'goal', content: 1 } } }));
    expect(() =>
      resolveVNextReference({ root: r, ref: 'data.json#/entities/S04-goal' }),
    ).toThrowError(/not present in the JSON/);
  });
});

describe('resolveVNextReference — entity presence & kind', () => {
  it('rejects a Markdown entity with no explicit marker (heading-only is not authoritative)', () => {
    const root = makeTempRoot();
    write(root, 'tasks.md', '# Stage\n\n## Goal\n\nonly a heading');
    expect(() =>
      resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-goal' }),
    ).toThrowError(/no explicit proofloop:entity marker/);
  });

  it('rejects a kind mismatch against the declared expected kind', () => {
    const root = makeTempRoot();
    write(root, 'tasks.md', MD);
    expect(() =>
      resolveVNextReference({ root, ref: 'tasks.md#/entities/S04-goal', expectedKind: 'task' }),
    ).toThrowError(/has kind "goal" but expected "task"/);
  });
});

describe('resolveVNextReference — root boundary & file type', () => {
  it('rejects an absolute path (outside-root) as an escape', () => {
    const root = makeTempRoot();
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.md`);
    fs.writeFileSync(outside, MD, 'utf-8');
    cleanups.push(() => fs.rmSync(outside, { force: true }));
    expect(() =>
      resolveVNextReference({ root, ref: `${outside}#/entities/S04-goal` }),
    ).toThrowError(/escapes the project root/);
  });

  it('rejects ".." traversal escaping the root', () => {
    const root = makeTempRoot();
    expect(() =>
      resolveVNextReference({ root, ref: '../outside.md#/entities/E' }),
    ).toThrowError(/escapes the project root/);
  });

  it('rejects a symlink whose target escapes the root', () => {
    const root = makeTempRoot();
    const outside = path.join(os.tmpdir(), `vnext-outside-${Date.now()}.md`);
    fs.writeFileSync(outside, MD, 'utf-8');
    cleanups.push(() => fs.rmSync(outside, { force: true }));
    fs.symlinkSync(outside, path.join(root, 'link.md'));
    expect(() =>
      resolveVNextReference({ root, ref: 'link.md#/entities/S04-goal' }),
    ).toThrowError(VNextEntityResolutionError);
  });

  it('rejects a non-regular file (FIFO) without blocking', () => {
    const root = makeTempRoot();
    const fifo = path.join(root, 'pipe.md');
    execFileSync('mkfifo', [fifo]); // Node has no mkfifo API — test-only coreutils use
    expect(() =>
      resolveVNextReference({ root, ref: 'pipe.md#/entities/E' }),
    ).toThrowError(/not a regular file/);
  });
});

describe('readRootBoundFile — TOCTOU re-check', () => {
  it('fails closed when the post-read path identity differs from the read fd (simulated TOCTOU)', () => {
    const root = makeTempRoot();
    const abs = write(root, 'tasks.md', MD);
    const fdStats = fs.statSync(abs);
    const changed = { dev: 999, ino: 888, mtimeMs: 1, size: 1 } as fs.Stats;
    expect(() => assertFileUnchanged(abs, fdStats, () => changed)).toThrowError(
      /changed identity\/metadata between the read and the re-check/,
    );
  });

  it('passes when the post-read identity matches the read fd', () => {
    const root = makeTempRoot();
    const abs = write(root, 'tasks.md', MD);
    const fdStats = fs.statSync(abs);
    expect(() => assertFileUnchanged(abs, fdStats)).not.toThrow();
  });

  it('reports a missing file as unreadable (fail closed, legal absence)', () => {
    const root = makeTempRoot();
    expect(() => readRootBoundFile(root, 'missing.md')).toThrowError(/missing or unreadable/);
  });
});

describe('resolveVNextReference — UTF-8 boundary', () => {
  it('fails closed on invalid UTF-8 (never silently replaces bytes)', () => {
    const root = makeTempRoot();
    write(root, 'bad.md', '');
    fs.writeFileSync(path.join(root, 'bad.md'), Buffer.from([0xff, 0xfe, 0x00, 0x0a]));
    expect(() => resolveVNextReference({ root, ref: 'bad.md#/entities/E' })).toThrowError(
      /not valid UTF-8/,
    );
  });
});

describe('resolveVNextReference — S08-C-T02 current Task Plan binding', () => {
  const repoRoot = path.resolve(__dirname, '../../../..');

  it('resolves the S08-C-T02 task entity with the section digest the Manifest binds', () => {
    const root = makeTempRoot();
    for (const rel of [
      'delivery/stages/S08/tasks.md',
      '.proofloop/manifests/S08.json',
    ]) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, rel), abs);
    }
    const resolved = resolveVNextReference({
      root,
      ref: 'delivery/stages/S08/tasks.md#/entities/S08-C-T02',
      expectedKind: 'task',
    });
    expect(resolved.entityId).toBe('S08-C-T02');
    expect(resolved.kind).toBe('task');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, '.proofloop/manifests/S08.json'), 'utf8'),
    ) as {
      reference_index: Record<string, { kind: string; file_digest: string; section_digest: string }>;
    };
    const descriptor = manifest.reference_index['REF-S08-C-T02'];
    expect(descriptor.kind).toBe('task');
    // Root-bound resolution is deterministic: the resolver re-derives exactly
    // the file/section digests the admitted Manifest binds, so a Context that
    // carries this task_ref is self-verifiable against the source Plan.
    expect(resolved.fileDigest).toBe(descriptor.file_digest);
    expect(resolved.sectionDigest).toBe(descriptor.section_digest);
  });
});
