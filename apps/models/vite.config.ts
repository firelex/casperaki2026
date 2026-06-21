import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = env.CASPERAKI_PORT || '16400';
  const clientPort = parseInt(env.CASPERAKI_CLIENT_PORT || '16401', 10);

  return {
    plugins: [react(), tailwindcss()],
    // `@teamsuzie/ui` is linked from the sibling monorepo; dedupe React so a
    // single copy is used, and allow Vite to read files outside the project root.
    resolve: {
      dedupe: ['react', 'react-dom'],
    },
    // `@teamsuzie/ui` is a linked package, so by default Vite serves it as raw
    // source — its barrel re-exports ~70 modules (pdfjs, codemirror, react-pdf,
    // docx-preview…), which the browser would otherwise fetch one-by-one on
    // every load (~2.5k requests → page crawls). Forcing it through esbuild
    // pre-bundling collapses that into a few cached chunks.
    optimizeDeps: {
      include: [
        '@teamsuzie/ui',
        '@teamsuzie/ui > pdfjs-dist',
        '@teamsuzie/ui > react-pdf',
        '@teamsuzie/ui > docx-preview',
      ],
    },
    server: {
      port: clientPort,
      fs: {
        allow: ['..'],
      },
      proxy: {
        '/api': `http://localhost:${backendPort}`,
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
