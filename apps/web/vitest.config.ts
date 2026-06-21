import { defineConfig } from 'vitest/config';

// Standalone vitest config so the runtime vite config (consumed by vite@7)
// stays decoupled from vitest@2's pinned vite@5 type dependency.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
