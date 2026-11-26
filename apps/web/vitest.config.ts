import { defineConfig } from 'vitest/config';

// Standalone vitest config so the runtime vite config (consumed by vite@7)
// stays decoupled from vitest@2's pinned vite@5 type dependency.
export default defineConfig({
  // One React for the app and the @teamsuzie/ui components it renders (they resolve their own copy otherwise, and a
  // component with hooks from both fails in tests: "Invalid hook call").
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
