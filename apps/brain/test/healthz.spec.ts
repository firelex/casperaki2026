import { describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { openSongsStore } from '../src/store.js';

describe('GET /healthz', () => {
  it('responds with ok=true', async () => {
    const store = openSongsStore({ path: ':memory:' });
    const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${address.port}/healthz`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, service: '@casperaki/brain' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    }
  });
});
