/**
 * @proofloop/runtime — vNext stable entity marker resolver (S0-A bootstrap, task 2).
 *
 * READ-ONLY parsing seam. Resolves the canonical entity-reference grammar
 *   <root-relative-path>#/entities/<entity-id>
 * against the filesystem trust root, binding `file_digest` / `section_digest`
 * for the vNext Reference Index.
 *
 * Non-negotiable invariants (all fail closed):
 *   - Markdown entities are located ONLY by the explicit unique marker
 *     `<!-- proofloop:entity id="<id>" kind="<kind>" -->`. Heading / table
 *     row / list order is NEVER authoritative positioning.
 *   - A JSON artifact supports ONLY `#/entities/<id>` where the artifact
 *     carries an explicit top-level `entities` object keyed by entity id.
 *     Any other `#/...` fragment (plain JSON pointer, fuzzy form) is clearly
 *     rejected as unsupported / ambiguous — there is NO full-text search.
 *   - Every path is root-bound: absolute paths, `..` traversal, symlink
 *     escape and non-regular files are rejected (reuses the runtime's
 *     path-guard component-wise walk + atomic no-follow open).
 *   - File identity/metadata is re-checked before AND after reading; a
 *     TOCTOU change fails closed.
 *   - Normalization touches ONLY UTF-8, line endings and trailing whitespace
 *     — semantic body is never collapsed.
 *
 * This seam does NOT implement Context artifacts, role projection, Evidence
 * gating, or Runtime Proof resolution (S0-B / S0-C out of scope).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { VNEXT_REFERENCE_KINDS, canonicalJson } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';

// ============================================================
// Error surface
// ============================================================

/** Structured fail-closed condition from the entity resolver. */
export class VNextEntityResolutionError extends Error {
  public readonly code:
    | 'escape'
    | 'unreadable'
    | 'not-regular-file'
    | 'toctou-change'
    | 'ambiguous-ref'
    | 'unsupported-json-pointer'
    | 'ambiguous-marker'
    | 'duplicate-entity'
    | 'entity-not-found'
    | 'unknown-kind'
    | 'kind-mismatch'
    | 'invalid-utf8';
  public readonly ref?: string;

  constructor(
    code: VNextEntityResolutionError['code'],
    message: string,
    ref?: string,
  ) {
    super(message);
    this.name = 'VNextEntityResolutionError';
    this.code = code;
    this.ref = ref;
  }
}

function fail(
  code: VNextEntityResolutionError['code'],
  message: string,
  ref?: string,
): never {
  throw new VNextEntityResolutionError(code, message, ref);
}

// ============================================================
// Marker grammar
// ============================================================

/**
 * The ONLY recognized Markdown entity marker. Strict: exactly
 * `<!-- proofloop:entity id="<id>" kind="<kind>" -->` with the two
 * attributes in that order and no extra attributes / whitespace tricks.
 * Any line that mentions `proofloop:entity` but does not match this exact
 * form is an ambiguous marker and fails closed.
 */
const ENTITY_MARKER_RE = /^<!--\s*proofloop:entity\s+id="([^"]+)"\s+kind="([^"]+)"\s*-->\s*$/;

const AMBIGUOUS_MARKER_RE = /proofloop:entity/;

/** Closed set of kinds accepted by the vNext Reference Index. */
const KNOWN_KINDS = new Set<string>(VNEXT_REFERENCE_KINDS);

// ============================================================
// Normalization (UTF-8 / newline / trailing whitespace ONLY)
// ============================================================

/**
 * Normalize a text block for digesting: CRLF / lone CR → LF and strip
 * trailing whitespace per line. Semantic body (line structure, ordering,
 * leading whitespace) is preserved — nothing is collapsed.
 */
export function normalizeEntityText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
}
export function normalizePlanExecutionProjection(text: string): string {
  const tick = String.fromCharCode(96);
  const workerStatus = tick + "NOT_STARTED" + tick;
  const cvStatus = tick + "NOT_RUN" + tick;
  return normalizeEntityText(text)
    .replace(/^(\s*-\s*)\[[xX]\]/gm, "$1[ ]")
    .replace(/^(\s*(?:[-*]\s*)?checkbox\s*:\s*`)\[[xX]\](`\s*)$/gim, "$1[ ]$2")
    .replace(/^(\s*(?:[-*]\s*)?Worker Status\s*:\s*).*$/gim, "$1" + workerStatus)
    .replace(/^(\s*(?:[-*]\s*)?Current CV Status\s*:\s*).*$/gim, "$1" + cvStatus);
}
function isPlanReferencePath(pathPart: string): boolean { return pathPart.split("/").pop() === "tasks.md"; }
function normalizeReferenceFileText(pathPart: string, text: string): string { return isPlanReferencePath(pathPart) ? normalizePlanExecutionProjection(text) : normalizeEntityText(text); }
function normalizeReferenceSectionText(pathPart: string, text: string): string { return isPlanReferencePath(pathPart) ? normalizePlanExecutionProjection(text) : text; }
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Compute a section digest per §7.6 Entity/Section Digest:
 *
 *   section_digest = SHA-256(canonical_path + canonical_entity_ref + normalized_section_content)
 *
 * `normalized_section_content` is already normalized by the caller (Markdown
 * section body normalized for UTF-8/newlines/trailing whitespace; JSON content
 * canonicalized with the kernel `canonicalJson` serializer).
 */
function computeSectionDigest(
  canonicalPath: string,
  canonicalEntityRef: string,
  normalizedSectionContent: string,
): string {
  return sha256Hex(canonicalPath + canonicalEntityRef + normalizedSectionContent);
}

/**
 * The identity components used by the §7.6 section digest formula.
 *
 * Entity references are root-relative, so the canonical path is also
 * root-relative (with `/` separators) rather than an environment-bound
 * absolute path. This keeps a manifest stable when the same worktree is
 * checked out at a different absolute location while still binding the
 * digest to the artifact's canonical location within that worktree.
 */
export interface EntityDigestBinding {
  readonly canonicalPath: string;
  readonly canonicalEntityRef: string;
}

function canonicalEntityPath(root: string, filePath: string): string {
  const canonicalRoot = canonicalPathWithinRoot(root, root);
  if (canonicalRoot === null) {
    fail('escape', `Project root "${root}" is outside the trust boundary`);
  }
  const relative = path.relative(canonicalRoot, filePath);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`)
  ) {
    fail('escape', `Resolved path "${filePath}" is outside the project root`);
  }
  return relative.split(path.sep).join('/');
}

function makeEntityDigestBinding(
  canonicalPath: string,
  entityId: string,
): EntityDigestBinding {
  return {
    canonicalPath,
    canonicalEntityRef: `${canonicalPath}#/entities/${entityId}`,
  };
}

// ============================================================
// Markdown marker parsing
// ============================================================

export interface MarkedEntity {
  readonly id: string;
  readonly kind: string;
  /** 0-based line index of the marker line. */
  readonly lineStart: number;
  /** 0-based line index one past the last content line. */
  readonly lineEnd: number;
  /** Normalized section content (marker-delimited, never heading-based). */
  readonly content: string;
  /**
   * §7.6 digest when a canonical path/ref binding was supplied. Plain marker
   * parsing has no path/ref identity and therefore intentionally leaves this
   * absent instead of exposing a content-only digest.
   */
  readonly sectionDigest?: string;
}

/**
 * Parse every `proofloop:entity` marker in a Markdown document.
 *
 * Section ranges are marker-delimited: an entity's content is the normalized
 * text from the line AFTER its marker up to the next entity marker (or EOF).
 * Heading / table row / list order never determines a range.
 *
 * Fail-closed conditions:
 *   - a line mentioning `proofloop:entity` that is not the exact marker
 *     grammar → `ambiguous-marker`;
 *   - two markers with the same id → `duplicate-entity`;
 *   - an unknown kind → `unknown-kind`.
 */
export function parseEntityMarkers(
  markdown: string,
  digestBinding?: EntityDigestBinding,
): MarkedEntity[] {
  const normalized = normalizeEntityText(markdown);
  const lines = normalized.split('\n');

  interface RawMarker {
    id: string;
    kind: string;
    lineStart: number;
  }
  const markers: RawMarker[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!AMBIGUOUS_MARKER_RE.test(line)) continue;
    const match = ENTITY_MARKER_RE.exec(line);
    if (match === null) {
      fail(
        'ambiguous-marker',
        `Line ${i + 1} is an ambiguous proofloop:entity marker: it is not the exact grammar ` +
          '`<!-- proofloop:entity id="<id>" kind="<kind>" -->`',
      );
    }
    markers.push({ id: match[1], kind: match[2], lineStart: i });
  }

  const seen = new Map<string, number>();
  const result: MarkedEntity[] = [];
  for (const marker of markers) {
    const prior = seen.get(marker.id);
    if (prior !== undefined) {
      fail(
        'duplicate-entity',
        `Duplicate entity id "${marker.id}" (markers at lines ${prior + 1} and ${marker.lineStart + 1})`,
      );
    }
    seen.set(marker.id, marker.lineStart);
    if (!KNOWN_KINDS.has(marker.kind)) {
      fail(
        'unknown-kind',
        `Entity "${marker.id}" declares unknown kind "${marker.kind}". Allowed: ${[...KNOWN_KINDS].join(', ')}`,
      );
    }
  }

  for (let m = 0; m < markers.length; m++) {
    const marker = markers[m];
    const nextStart = m + 1 < markers.length ? markers[m + 1].lineStart : lines.length;
    const contentLines = lines.slice(marker.lineStart + 1, nextStart);
    const content = normalizeEntityText(contentLines.join('\n'));
    const entity: MarkedEntity = {
      id: marker.id,
      kind: marker.kind,
      lineStart: marker.lineStart,
      lineEnd: nextStart,
      content,
    };
    result.push(
      digestBinding === undefined
        ? entity
        : {
            ...entity,
            sectionDigest: computeSectionDigest(
              digestBinding.canonicalPath,
              digestBinding.canonicalEntityRef,
              content,
            ),
          },
    );
  }
  return result;
}

// ============================================================
// Reference grammar parsing
// ============================================================

export interface ParsedEntityRef {
  /** The path part before `#`. */
  readonly path: string;
  /** The entity id after `/entities/`. */
  readonly entityId: string;
  /** The raw fragment (for diagnostics). */
  readonly fragment: string;
}

/**
 * Parse a canonical entity reference `<path>#/entities/<id>`.
 *
 * Fail-closed on:
 *   - missing `#` fragment;
 *   - a fragment that is not exactly `/entities/<id>` (e.g. a plain JSON
 *     pointer `/slices/0`, an empty id, or a fuzzy fragment) → clearly
 *     rejected; there is NO full-text search.
 */
export function parseEntityRef(ref: string): ParsedEntityRef {
  if (typeof ref !== 'string' || ref.length === 0) {
    fail('ambiguous-ref', 'Reference must be a non-empty string', ref);
  }
  const hashIdx = ref.indexOf('#');
  if (hashIdx === -1) {
    fail(
      'ambiguous-ref',
      'Reference has no "#" fragment; expected "<root-relative-path>#/entities/<entity-id>"',
      ref,
    );
  }
  if (ref.indexOf('#', hashIdx + 1) !== -1) {
    fail('ambiguous-ref', 'Reference contains more than one "#" fragment', ref);
  }
  const pathPart = ref.slice(0, hashIdx);
  const fragment = ref.slice(hashIdx + 1);
  if (pathPart.length === 0) {
    fail('ambiguous-ref', 'Reference path part is empty', ref);
  }
  const entityMatch = /^\/entities\/([^/]+)$/.exec(fragment);
  if (entityMatch === null) {
    fail(
      'unsupported-json-pointer',
      `Fragment "${fragment}" is not supported. Only "#/entities/<entity-id>" is accepted; ` +
        'other JSON pointers / fuzzy forms are rejected (no full-text search)',
      ref,
    );
  }
  const entityId = entityMatch[1];
  if (entityId.length === 0) {
    fail('ambiguous-ref', 'Entity id in fragment is empty', ref);
  }
  return { path: pathPart, entityId, fragment };
}

// ============================================================
// JSON artifact entity extraction
// ============================================================

/**
 * Resolve `#/entities/<id>` inside a JSON artifact. The artifact must carry
 * an explicit top-level `entities` object keyed by entity id; each entry
 * must be an object with `kind` (a known reference kind) and `content`
 * (JSON-serializable entity body). Any other JSON form is unsupported.
 */
export function extractJsonEntity(
  parsed: unknown,
  entityId: string,
  sourceRef: string,
  digestBinding?: EntityDigestBinding,
): MarkedEntity {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(
      'unsupported-json-pointer',
      `JSON artifact for "${sourceRef}" must be an object with an explicit "entities" map`,
      sourceRef,
    );
  }
  const entities = (parsed as Record<string, unknown>).entities;
  if (entities === undefined) {
    fail(
      'unsupported-json-pointer',
      `JSON artifact for "${sourceRef}" has no top-level "entities" object`,
      sourceRef,
    );
  }
  if (entities === null || typeof entities !== 'object' || Array.isArray(entities)) {
    fail(
      'unsupported-json-pointer',
      `JSON artifact for "${sourceRef}" "entities" must be an object keyed by entity id`,
      sourceRef,
    );
  }
  const entry = (entities as Record<string, unknown>)[entityId];
  if (entry === undefined) {
    fail('entity-not-found', `Entity "${entityId}" is not present in the JSON "entities" map`, sourceRef);
  }
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('entity-not-found', `Entity "${entityId}" in JSON must be an object with kind + content`, sourceRef);
  }
  const kind = (entry as Record<string, unknown>).kind;
  if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
    fail(
      'unknown-kind',
      `JSON entity "${entityId}" declares unknown kind ${String(kind)}. Allowed: ${[...KNOWN_KINDS].join(', ')}`,
      sourceRef,
    );
  }
  const contentValue = (entry as Record<string, unknown>).content;
  if (contentValue === undefined) {
    fail(
      'entity-not-found',
      `JSON entity "${entityId}" is missing a "content" field`,
      sourceRef,
    );
  }
  // Normalized section content for JSON is the kernel canonical JSON
  // serialization (deterministic key order / primitive normalization) — the
  // SAME canonicalization rule used by every other vNext digest.
  const content = canonicalJson(contentValue);
  const entity: MarkedEntity = {
    id: entityId,
    kind,
    lineStart: -1,
    lineEnd: -1,
    content,
  };
  return digestBinding === undefined
    ? entity
    : {
        ...entity,
        sectionDigest: computeSectionDigest(
          digestBinding.canonicalPath,
          digestBinding.canonicalEntityRef,
          content,
        ),
      };
}

// ============================================================
// Root-bound, TOCTOU-safe file read
// ============================================================

// ============================================================
// Post-read identity/metadata re-check (TOCTOU closure)
// ============================================================

/**
 * Re-check that the canonical path still references the SAME inode with the
 * SAME metadata that was read from the fd. A replacement / metadata change
 * between the read and the re-check fails closed as `toctou-change`.
 *
 * `statFn` is injectable for deterministic TOCTOU tests (the production call
 * path uses the default real `fs.statSync`).
 */
export function assertFileUnchanged(
  filePath: string,
  fdStats: fs.Stats,
  statFn: (p: string) => fs.Stats = (p) => fs.statSync(p),
): void {
  let finalStats: fs.Stats;
  try {
    finalStats = statFn(filePath);
  } catch {
    fail('toctou-change', `Path "${filePath}" disappeared between read and re-check`);
  }
  if (
    finalStats.dev !== fdStats.dev ||
    finalStats.ino !== fdStats.ino ||
    finalStats.mtimeMs !== fdStats.mtimeMs ||
    finalStats.size !== fdStats.size
  ) {
    fail(
      'toctou-change',
      `Path "${filePath}" changed identity/metadata between the read and the re-check (TOCTOU)`,
    );
  }
}

export interface ReadRootBoundResult {
  readonly content: string;
  readonly filePath: string;
}

/**
 * Read a root-relative file with the atomic no-follow boundary and a
 * pre-read + post-read identity/metadata re-check.
 *
 *   - `openNoFollowRead` canonicalizes the parent chain, opens the final
 *     component with O_NOFOLLOW | O_NONBLOCK and verifies dev/ino against a
 *     pre-open stat (symlink escape / swap / non-regular file fail closed).
 *   - The fd is fstat'ed after reading (post-read identity), then the
 *     canonical path is stat'ed again and compared (dev/ino + mtimeMs +
 *     size) — a replacement or metadata change between read and re-check
 *     fails closed as `toctou-change`.
 */
export function readRootBoundFile(root: string, pathPart: string): ReadRootBoundResult {
  if (typeof root !== 'string' || root.length === 0 || typeof pathPart !== 'string' || pathPart.length === 0) {
    fail('escape', 'Root and path must be non-empty strings');
  }

  const opened = openNoFollowRead(root, pathPart);
  if (!opened.ok) {
    switch (opened.reason) {
      case 'escape':
        fail(
          'escape',
          `Path "${pathPart}" escapes the project root trust boundary (absolute path, ".." traversal or symlink escape)`,
        );
      case 'not-regular-file':
        fail('not-regular-file', `Path "${pathPart}" is not a regular file`);
      case 'inode-mismatch':
        fail(
          'toctou-change',
          `Path "${pathPart}" identity changed between the pre-open check and the atomic open (TOCTOU)`,
        );
      default:
        fail('unreadable', `Path "${pathPart}" is missing or unreadable`);
    }
  }

  const fd = opened.fd;
  let content: string;
  try {
    const buf = fs.readFileSync(fd);
    // Fatal UTF-8 decode: invalid byte sequences fail closed instead of being
    // silently replaced (normalization handles only valid UTF-8 + newline +
    // trailing whitespace — never a lossy body rewrite).
    content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore close failure */
    }
    const isInvalidUtf8 = err instanceof TypeError && /utf-8|decode|invalid/i.test(String(err.message));
    if (isInvalidUtf8) {
      fail('invalid-utf8', `Path "${pathPart}" is not valid UTF-8`);
    }
    fail('unreadable', `Path "${pathPart}" could not be read from the opened fd`);
  }

  let fdStats: fs.Stats;
  try {
    fdStats = fs.fstatSync(fd);
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    fail('toctou-change', `Path "${pathPart}" fd could not be re-stat'ed after read`);
  }
  try {
    fs.closeSync(fd);
  } catch {
    /* ignore */
  }

  // Post-read re-check: the canonical path must still reference the SAME
  // inode with the SAME metadata that was actually read (TOCTOU closed).
  assertFileUnchanged(opened.filePath, fdStats);

  return { content, filePath: opened.filePath };
}

// ============================================================
// Resolver entry point
// ============================================================

export interface ResolvedEntity {
  /** The canonical reference string actually resolved. */
  readonly ref: string;
  readonly entityId: string;
  readonly kind: string;
  /** Canonical absolute path of the artifact. */
  readonly filePath: string;
  /** SHA-256 over the normalized full-file content. */
  readonly fileDigest: string;
  /** SHA-256 over the normalized entity section content. */
  readonly sectionDigest: string;
  /** Normalized entity section content. */
  readonly content: string;
  /** 1-based marker line (Markdown) or -1 (JSON). */
  readonly lineStart: number;
  /** 1-based last content line (Markdown) or -1 (JSON). */
  readonly lineEnd: number;
}

export interface ResolveEntityOptions {
  readonly root: string;
  /** The canonical reference: `<root-relative-path>#/entities/<id>`. */
  readonly ref: string;
  /** Expected reference kind; a mismatch with the marker/JSON kind fails closed. */
  readonly expectedKind?: string;
}

/**
 * Resolve a root-bound entity reference into a descriptor-ready entity with
 * file/section digests bound.
 *
 * @throws {VNextEntityResolutionError} on every fail-closed condition:
 *         escape / unreadable / not-regular-file / toctou-change /
 *         ambiguous-ref / unsupported-json-pointer / ambiguous-marker /
 *         duplicate-entity / entity-not-found / unknown-kind / kind-mismatch.
 */
export function resolveVNextReference(options: ResolveEntityOptions): ResolvedEntity {
  const { root, ref, expectedKind } = options;
  const parsed = parseEntityRef(ref);

  const read = readRootBoundFile(root, parsed.path);
  const canonicalPath = canonicalEntityPath(root, read.filePath);
  const digestBinding = makeEntityDigestBinding(canonicalPath, parsed.entityId);
  const fileDigest = sha256Hex(normalizeReferenceFileText(parsed.path, read.content));

  let entity: MarkedEntity;
  let jsonDetected = false;
  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(read.content);
    jsonDetected = parsedJson !== null && typeof parsedJson === 'object';
  } catch {
    jsonDetected = false;
  }

  if (jsonDetected) {
    entity = extractJsonEntity(parsedJson, parsed.entityId, ref, digestBinding);
  } else {
    const entities = parseEntityMarkers(read.content, digestBinding);
    const found = entities.find((e) => e.id === parsed.entityId);
    if (found === undefined) {
      fail(
        'entity-not-found',
        `Entity "${parsed.entityId}" has no explicit proofloop:entity marker in ${parsed.path}`,
        ref,
      );
    }
    entity = found;
  }

  if (expectedKind !== undefined && entity.kind !== expectedKind) {
    fail(
      'kind-mismatch',
      `Entity "${parsed.entityId}" has kind "${entity.kind}" but expected "${expectedKind}"`,
      ref,
    );
  }

  // §7.6 Entity/Section Digest: bind the section digest over the canonical
  // path + canonical entity ref + normalized section content (not the content
  // alone), so the digest is anchored to the artifact identity and the exact
  // reference that resolved to it. The extraction helpers receive the same
  // binding, so there is no content-only section digest on the resolver path.
  const sectionContent = normalizeReferenceSectionText(parsed.path, entity.content);
  const sectionDigest = computeSectionDigest(digestBinding.canonicalPath, digestBinding.canonicalEntityRef, sectionContent);

  return {
    ref: digestBinding.canonicalEntityRef,
    entityId: entity.id,
    kind: entity.kind,
    filePath: read.filePath,
    fileDigest,
    sectionDigest,
    content: entity.content,
    lineStart: entity.lineStart === -1 ? -1 : entity.lineStart + 1,
    lineEnd: entity.lineEnd === -1 ? -1 : entity.lineEnd,
  };
}
