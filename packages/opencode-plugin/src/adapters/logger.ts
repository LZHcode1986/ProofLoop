/**
 * @proofloop/opencode-plugin — host logger adapter (ADR-002).
 *
 * S01-B-T01: converges ALL host logging interaction behind this adapter so
 * tools/hooks never touch `client.app.log` directly. The adapter depends only
 * on the structurally minimal host log sink shape observed in OC-0
 * (tech-spec/host-compatibility.md #Logging):
 *
 *   client.app.log({ body: { service, level, message, extra } })
 *
 * and on a canonical `service` name supplied by the caller. It does not
 * import SDK types or host API details; the real `client.app.log` call is
 * bound at the host-context boundary, so a host SDK upgrade only changes
 * that binding.
 *
 * S01-C Repair (host logger observation, CV S01-C-REPAIR-HOST-CHECKS-ERROR-
 * MAPPING-CANCELLATION #6): the adapter observes the REAL host sink and never
 * throws. A missing/abnormal sink (or a sink that throws on a call) marks the
 * adapter `healthy: false` — the failure is absorbed so plugin initialization
 * and doctor execution never break, and the doctor's host-api check reads
 * `logger.healthy` instead of a hardcoded `true`.
 *
 * S01-C Diagnose (CV_REPAIR #2 / 36349b09…): the host `client.app.log` sink is
 * ASYNC — its return value is a Promise. The adapter therefore absorbs BOTH a
 * synchronous throw AND an asynchronous rejection: `log()` attaches a
 * rejection handler to thenable results (no unhandled rejection), and
 * `probe()` AWAITS the sink settlement so the observed `healthy` state
 * reflects async failures too. Both failure paths mark the adapter unhealthy
 * identically and never break plugin behavior.
 *
 * S1-F-002 (OUT-S1-05 compact_log_not_persisted): the adapter ALSO persists
 * every structured diagnostic entry to `<projectRoot>/.proofloop/logs/` as
 * append-only JSONL (contract-state-matrix §3 `.proofloop/logs/**`). The
 * canonical log directory is supplied by the caller (`logsDir`); the file is
 * created lazily on the first write and the adapter exposes a traceable
 * `logRef` (`.proofloop/logs/<file>` relative to `projectRoot`) so compact
 * output can point at the FULL persisted diagnostics instead of a bare host
 * log identifier. File persistence is fail-closed: a missing/unwritable
 * `.proofloop/logs/` directory marks `fileHealthy: false` and NEVER fakes a
 * "persisted" claim — the doctor engine turns that into a structured Finding.
 */

import * as fs from 'node:fs';
import path from 'node:path';
import { resolveWithinRoot, reverifyCanonicalPath } from '../path-boundary.js';

/** Host log level closed set (AppLogData.body.level). */
export type LogLevel = 'debug' | 'info' | 'error' | 'warn';

/** Structured log body accepted by the host log endpoint. */
export interface HostLogBody {
  service: string;
  level: LogLevel;
  message: string;
  extra?: Record<string, unknown>;
}

/**
 * Minimal structural sink for the host `client.app.log({ body })` call.
 * The real SDK method is generic (`Options<AppLogData>`); this adapter
 * depends only on the observed `{ body }` shape (ADR-002). The sink may be
 * synchronous or asynchronous (return a Promise).
 */
export type HostAppLog = (options: { body: HostLogBody }) => unknown;

/**
 * Structured host logger bound to a canonical service name.
 * Every call is forwarded to the host log sink with a structured body and
 * (when file persistence is configured) appended to `.proofloop/logs/`.
 */
export interface LoggerAdapter {
  /** Canonical service name stamped on every host log entry. */
  readonly service: string;
  /**
   * True when the host log sink is available and has not failed on a call.
   * Observed from the REAL host sink — never hardcoded.
   */
  readonly healthy: boolean;
  /**
   * True when file persistence is configured (a `logsDir` was supplied).
   * Independent of the host sink health.
   */
  readonly persisted: boolean;
  /**
   * True while the persisted diagnostic file accepts writes. A missing or
   * unwritable `.proofloop/logs/` directory marks this false (fail-closed);
   * the doctor engine turns a configured-but-unhealthy file sink into a
   * structured Finding — never a silent "persisted" claim.
   */
  readonly fileHealthy: boolean;
  /**
   * Traceable reference to the persisted diagnostic file
   * (`.proofloop/logs/<file>` relative to `projectRoot`, or the absolute path
   * when no `projectRoot` is supplied). `undefined` when file persistence is
   * not configured or the file has not been created yet.
   */
  readonly logRef: string | undefined;
  /**
   * Probe the host sink (fail-closed): emits a debug-level observation entry
   * and AWAITS the sink settlement, so a synchronous throw AND an asynchronous
   * rejection are both absorbed and mark the adapter unhealthy. Resolves when
   * the observation is complete. Never throws.
   */
  probe(): Promise<void>;
  log(level: LogLevel, message: string, extra?: Record<string, unknown>): void;
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/** Options for file persistence of the diagnostic log (S1-F-002). */
export interface LoggerAdapterOptions {
  /**
   * Absolute path to the canonical diagnostic log directory
   * (`<projectRoot>/.proofloop/logs`, contract-state-matrix §3). When
   * supplied, every structured entry is appended to a JSONL file there.
   */
  logsDir?: string;
  /**
   * Canonical project root used to render the traceable relative `logRef`
   * (`.proofloop/logs/<file>`). When omitted, `logRef` is the absolute path.
   */
  projectRoot?: string;
}

/**
 * Create a host logger adapter over the given `client.app.log`-shaped sink.
 *
 * The sink is fire-and-forget for `log()`: the adapter forwards the structured
 * body, attaches a rejection handler to any thenable result (an async rejection
 * is ABSORBED — never an unhandled rejection), and catches synchronous throws.
 * Any failure marks the adapter unhealthy; it never breaks plugin behavior and
 * never throws out of the logger.
 *
 * File persistence (S1-F-002): when `logsDir` is supplied, every log call also
 * appends a structured JSONL entry to `.proofloop/logs/doctor-<timestamp>.log`.
 * The directory and file are created lazily on the first write; any failure
 * (missing/unwritable directory) marks `fileHealthy: false` fail-closed and
 * sets `logRef` to `undefined` — a "persisted" ref is never faked.
 */
export function createLoggerAdapter(
  appLog: HostAppLog,
  service: string,
  options: LoggerAdapterOptions = {},
): LoggerAdapter {
  let healthy = typeof appLog === 'function';
  let fileHealthy = true;
  const persisted = options.logsDir !== undefined;
  let logFilePath: string | undefined;
  let logRef: string | undefined;

  const markUnhealthy = (): void => {
    healthy = false;
  };

  const markFileUnhealthy = (): void => {
    fileHealthy = false;
  };

  /**
   * Lazily create the `.proofloop/logs` directory and the per-session
   * diagnostic file on the first write, then set the traceable logRef.
   * Any failure marks the file sink unhealthy (fail-closed) — the caller is
   * never left believing diagnostics were persisted when they were not.
   *
   * Two-phase invariant (S01-F-002-APPEND-FAILURE-STALE-LOGREF): `ensureFile`
   * (mkdir + file creation) and `persistToFile` (append) are the two phases of
   * file persistence. EITHER phase failing must leave `logRef === undefined` —
   * a ref is only ever exposed after the file was actually written
   * successfully. A stale ref pointing at a file that was never persisted is
   * a fake traceability claim and is forbidden.
   */
  const ensureFile = (): void => {
    if (!persisted || logFilePath !== undefined || !fileHealthy) return;
    try {
      const logsDir = options.logsDir as string;
      // Trust-root boundary (S2-F-003 round 1): when a projectRoot trust
      // boundary is known, a logsDir whose canonical path escapes it is NEVER
      // created or written — a symlinked `.proofloop/logs` pointing outside the
      // worktree would otherwise make the logger write outside the
      // read-only/no-write boundary. Escapes fail closed (markFileUnhealthy +
      // logRef undefined).
      if (options.projectRoot !== undefined) {
        if (resolveWithinRoot(options.projectRoot, logsDir) === null) {
          throw new Error(
            `logsDir escapes the project root trust boundary: ${logsDir}`,
          );
        }
      }
      fs.mkdirSync(logsDir, { recursive: true });
      // S2-F-003 round 2 (canonical append target): canonicalize the logs
      // directory AFTER creation and build the per-session file path from the
      // REALPATH. The append therefore targets the canonical directory that
      // actually exists inside the trust root — a concurrent symlink swap of
      // the lexical `logsDir` between this point and the append can no longer
      // redirect the write outside the boundary.
      const canonicalLogsDir = fs.realpathSync(logsDir);
      if (options.projectRoot !== undefined) {
        if (resolveWithinRoot(options.projectRoot, canonicalLogsDir) === null) {
          throw new Error(
            `logsDir canonical path escapes the project root trust boundary: ${canonicalLogsDir}`,
          );
        }
      }
      const fileName = `doctor-${logFileTimestamp()}.log`;
      const filePath = path.join(canonicalLogsDir, fileName);
      if (options.projectRoot !== undefined) {
        // The per-session file must stay inside the trust boundary too: a
        // pre-existing symlinked log file (or a logsDir that was swapped
        // between the mkdir and this check) must never redirect the append.
        if (resolveWithinRoot(options.projectRoot, filePath) === null) {
          throw new Error(
            `log file path escapes the project root trust boundary: ${filePath}`,
          );
        }
        const relative = path.relative(options.projectRoot, filePath);
        logRef =
          relative.length > 0 && !relative.startsWith('..')
            ? relative
            : filePath;
      } else {
        logRef = filePath;
      }
      logFilePath = filePath;
    } catch {
      fileHealthy = false;
      logRef = undefined;
      logFilePath = undefined;
    }
  };

  /** Append one structured JSONL entry to the persisted diagnostic file. */
  const persistToFile = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    if (!persisted || !fileHealthy) return;
    ensureFile();
    if (logFilePath === undefined) return; // creation failed → fileHealthy=false
    try {
      // S2-F-003 round 2 (tight pre-append re-verify): the append targets the
      // canonical path captured by ensureFile. Re-verify it still resolves to
      // ITSELF (identity) — a concurrent symlink swap of the file (or an
      // ancestor) between ensureFile and the append fails closed instead of
      // redirecting the write outside the boundary.
      if (options.projectRoot !== undefined) {
        if (reverifyCanonicalPath(options.projectRoot, logFilePath) === null) {
          throw new Error(
            `log file path was redirected before append: ${logFilePath}`,
          );
        }
      }
      const entry: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        service,
        level,
        message,
      };
      if (extra !== undefined) {
        entry.extra = extra;
      }
      // S2-F-003 round 3 (no-follow atomic append): the append opens the
      // canonical log file with O_NOFOLLOW, so a concurrent replacement of the
      // file with a symlink (in-root or external) between the reverify above
      // and this open fails closed (ELOOP) instead of redirecting the write
      // outside the boundary — no external byte is ever written.
      //
      // S2-F-003 final supplement (open-after-fstat dev/ino identity): the
      // expected file identity is captured BEFORE the open; after the open the
      // opened fd's identity must match it. A mismatch means the canonical file
      // was replaced between the expectation capture and the open — fail
      // closed (inode changed) instead of appending to an unexpected inode.
      let expected: fs.Stats | null = null;
      try {
        expected = fs.statSync(logFilePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // ENOENT — the file does not exist yet and will be created by
          // O_CREAT below; a freshly created file has no swap window (this
          // process just created it), so no identity comparison applies.
          expected = null;
        } else {
          // EIO / EACCES / EPERM — the expected identity cannot be captured
          // reliably. Fail closed instead of opening with an UNKNOWN expected
          // identity (S2-F-003-R3-LOGGER-STAT-ERROR-FAILOPEN): the error
          // propagates to the outer catch → fileHealthy=false, refs cleared,
          // no byte is ever written.
          throw err;
        }
      }
      let fd: number;
      try {
        fd = fs.openSync(
          logFilePath,
          fs.constants.O_APPEND |
            fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_NOFOLLOW |
            // O_NONBLOCK (S2-F-003-R3-FIFO-BLOCK-BEFORE-FSTAT): a pre-placed
            // FIFO with no reader would otherwise block the O_WRONLY open
            // forever; with O_NONBLOCK the open returns immediately (ENXIO when
            // no reader is attached) and the isFile check below rejects it.
            fs.constants.O_NONBLOCK,
          0o644,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
          throw new Error(
            `log file path is a symlink (trust-root escape): ${logFilePath}`,
          );
        }
        throw err;
      }
      try {
        const actual = fs.fstatSync(fd);
        // A FIFO / socket / device is never a valid persisted-log target —
        // fail closed instead of writing to a non-regular file.
        if (!actual.isFile()) {
          throw new Error(
            `log file path is not a regular file (FIFO/special): ${logFilePath}`,
          );
        }
        if (expected !== null && (actual.dev !== expected.dev || actual.ino !== expected.ino)) {
          throw new Error(
            `log file path inode changed between check and append: ${logFilePath}`,
          );
        }
        fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Append failure is fail-closed AND must clear the ref: `ensureFile`
      // already exposed `logRef`, but the file was never successfully
      // persisted — a traceable ref to an unwritten file is a FAKE ref.
      fileHealthy = false;
      logRef = undefined;
      logFilePath = undefined;
    }
  };

  const log = (
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void => {
    // File persistence is independent of the host sink: always attempt the
    // append, then forward to the (healthy) host sink.
    persistToFile(level, message, extra);
    if (!healthy) return;
    try {
      const body: HostLogBody =
        extra === undefined
          ? { service, level, message }
          : { service, level, message, extra };
      attachRejectionHandling(appLog({ body }), markUnhealthy);
    } catch {
      healthy = false;
    }
  };

  async function probe(): Promise<void> {
    if (!healthy) return;
    try {
      // Await the sink settlement so an ASYNC rejection is observed (marks
      // unhealthy) exactly like a synchronous throw — no unhandled rejection.
      await appLog({
        body: { service, level: 'debug', message: 'logger capability probe' },
      });
    } catch {
      healthy = false;
    }
  }

  return {
    service,
    get healthy() {
      return healthy;
    },
    get persisted() {
      return persisted;
    },
    get fileHealthy() {
      return fileHealthy;
    },
    get logRef() {
      return logRef;
    },
    probe,
    log,
    debug: (message, extra) => log('debug', message, extra),
    info: (message, extra) => log('info', message, extra),
    warn: (message, extra) => log('warn', message, extra),
    error: (message, extra) => log('error', message, extra),
  };
}

/**
 * Deterministic per-adapter log file timestamp (no colons/dots in the file
 * name), e.g. `2026-08-02T11-25-00-000Z`. Stable for the adapter lifetime so
 * `logRef` never changes mid-run.
 */
function logFileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Attach rejection handling to a thenable `appLog` result so an asynchronous
 * sink failure is ABSORBED (no unhandled rejection) and marks the adapter
 * unhealthy. Non-thenable results are ignored.
 */
function attachRejectionHandling(
  result: unknown,
  onRejection: () => void,
): void {
  if (
    result === null ||
    result === undefined ||
    typeof (result as PromiseLike<unknown>).then !== 'function'
  ) {
    return;
  }
  void (result as PromiseLike<unknown>).then(undefined, () => {
    onRejection();
  });
}
