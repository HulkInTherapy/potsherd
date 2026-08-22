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
    // process-wide lock; running them in one process keeps that honest.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
