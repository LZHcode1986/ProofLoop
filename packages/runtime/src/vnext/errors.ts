/** Neutral vNext fail-closed error shared by validation seams. */
export class VNextHandoffError extends Error {
  public readonly code:
    | 'v1-input'
    | 'manifest-invalid'
    | 'manifest-binding'
    | 'admission-missing'
    | 'admission-invalid'
    | 'task-anchor-gap'
    | 'execution-scope-gap'
    | 'path-escape'
    | 'reference-digest-mismatch'
    | 'snapshot-binding';

  constructor(code: VNextHandoffError['code'], message: string) {
    super(message);
    this.name = 'VNextHandoffError';
    this.code = code;
  }
}
