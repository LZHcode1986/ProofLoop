/**
 * @proofloop/opencode-plugin package-internal spec
 *
 * PO: PO-S01-A-01, PO-S01-A-02
 *
 * Root workspace test discovery (vitest `include`) collects this package-internal
 * spec. It asserts the package identity constants (PO-S01-A-01) and the entry
 * export shape (PO-S01-A-02). The real host-load seam smoke (module resolution
 * + invocation with an OC-0-shaped PluginInput fixture) lives in
 * test/opencode-plugin-load.spec.ts.
 */

import { describe, expect, it } from 'vitest';
import plugin, { PLUGIN_PACKAGE_NAME, PLUGIN_VERSION, server } from './index.js';

describe('@proofloop/opencode-plugin package identity (PO-S01-A-01)', () => {
  it('declares the canonical package name', () => {
    expect(PLUGIN_PACKAGE_NAME).toBe('@proofloop/opencode-plugin');
  });

  it('declares version 0.1.0', () => {
    expect(PLUGIN_VERSION).toBe('0.1.0');
  });
});

describe('@proofloop/opencode-plugin entry shape (PO-S01-A-02)', () => {
  it('exposes a loadable default export', () => {
    expect(typeof plugin).toBe('function');
  });

  it('exposes a loadable named server export', () => {
    expect(typeof server).toBe('function');
  });
});
