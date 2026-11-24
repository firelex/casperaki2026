// The newest project's song (the one generation just made), as GET /api/songs/:id answers it.

import type { Express } from 'express';

/** GET /api/songs/:id for the project generation made (the newest). */
export async function settled<T>(url: string, app: Express): Promise<T> {
  const { projects } = (await (await fetch(`${url}/api/songs`)).json()) as { projects: { id: string; updatedAt: string }[] };
  const newest = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!newest) throw new Error('settled: no project');
  const res = await fetch(`${url}/api/songs/${newest.id}`);
  if (res.status !== 200) throw new Error(`settled: GET /api/songs/${newest.id} answered ${res.status}`);
  return (await res.json()) as T;
}
