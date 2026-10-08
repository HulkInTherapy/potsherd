import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@potsherd/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@potsherd/bridges': path.resolve(__dirname, 'packages/bridges/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // Rescue and settings tests write real files under a temp dir and take a
    // process-wide lock; serial files keep that honest. Fresh forks also keep
    // prior embedding/eval heaps outside the native parser process RSS budget.
    pool: 'forks',
    fileParallelism: false,
    poolOptions: { forks: { singleFork: false, isolate: true, minForks: 1, maxForks: 1 } },
  },
});
