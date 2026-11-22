import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The video engine is a git dependency whose real pnpm folder name holds a
  // "#": keep the node_modules symlink path (no "#") when resolving it.
  resolve: {
    alias: [{ find: /^@casperaki\/video$/u, replacement: new URL('./node_modules/@casperaki/video/dist/lib.js', import.meta.url).pathname }],
    preserveSymlinks: true,
  },
  test: {
    include: ['test/**/*.spec.ts', 'test/**/*.test.ts'],
    server: {
      deps: {
        // A git dependency: pnpm's folder name holds a "#", which vite-node reads
        // as a URL fragment. Node loads it directly instead.
        external: [/@casperaki\/video/u, /casperaki-video/u],
      },
    },
  },
});
