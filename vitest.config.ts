import { defineConfig } from 'vitest/config';

const maxWorkers = Number(process.env.MAX_WORKERS ?? '4');

// WSL2 内存受限：默认 4 个 fork worker，避免全量跑测试时 OOM（16 workers 曾崩溃
// WSL）。需要时用 MAX_WORKERS=8 npx vitest run 覆盖。

export default defineConfig({
  test: {
    include: [
      'packages/kernel/src/**/*.spec.ts',
      'packages/runtime/src/**/*.spec.ts',
      'test/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    maxWorkers,
  },
});
