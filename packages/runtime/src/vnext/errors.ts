/** Neutral vNext fail-closed error shared by validation seams.
 *
 * The legacy v1 / Manifest / admission / task-anchor / reference / snapshot
 * codes were retired with their business consumers; only the two protected-path
 * codes used by protected-paths remain.
 */
export class VNextHandoffError extends Error {
  public readonly code: 'execution-scope-gap' | 'path-escape';

  constructor(code: VNextHandoffError['code'], message: string) {
    super(message);
    this.name = 'VNextHandoffError';
    this.code = code;
  }
}
