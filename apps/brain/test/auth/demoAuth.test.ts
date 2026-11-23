// apps/brain/test/auth/demoAuth.test.ts — the fake demo sign-in (BRAIN_DEMO_LOGIN=1).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/bootstrap.ts';
import { loadConfig } from '../../src/config.ts';
import { SESSION_COOKIE } from '../../src/auth/middleware.ts';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({ BRAIN_SONGS_DB_PATH: ':memory:', SESSION_SECRET: 'test-secret', BRAIN_DEMO_LOGIN: '1', WEB_ORIGIN: 'http://localhost:5173' } as NodeJS.ProcessEnv);
  const app = createApp(config, { store: undefined });
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const login = (email: string, password: string) =>
  fetch(`${baseUrl}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });

describe('demo sign-in', () => {
  it('the API is closed while signed out', async () => {
    expect((await fetch(`${baseUrl}/api/auth/me`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/api/songs/x`)).status).toBe(401);
  });

  it('GET /login sends the browser to the login form', async () => {
    const res = await fetch(`${baseUrl}/api/auth/login?return_to=%2Fpatterns`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?return_to=%2Fpatterns');
    const offsite = await fetch(`${baseUrl}/api/auth/login?return_to=${encodeURIComponent('//evil.example/x')}`, { redirect: 'manual' });
    expect(offsite.headers.get('location')).toBe('/sign-in?return_to=%2F');
  });

  it('refuses wrong credentials', async () => {
    expect((await login('demo@example.com', 'nope')).status).toBe(401);
    expect((await login('other@example.com', 'demo123')).status).toBe(401);
  });

  it('the demo credentials sign in as an admin; a forged cookie does not', async () => {
    const res = await login('Demo@Example.com', 'demo123');
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    expect(await me.json()).toEqual({ id: 'demo-user', email: 'demo@example.com', name: 'Demo', isAdmin: true });
    const forged = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: `${SESSION_COOKIE}=demo-user.forged` } });
    expect(forged.status).toBe(401);
  });
});
