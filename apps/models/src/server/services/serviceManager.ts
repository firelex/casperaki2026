import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * A model-serving backend we launch as a *detached* child process — the generic
 * harness (services/_serving/harness.py) running a given adapter.
 *
 * Crucially the model server is decoupled from the casperaki app lifecycle:
 * it's spawned in its own process group with stdio redirected to a log file and
 * `unref()`'d, so restarting the web app does NOT kill a loaded model. State
 * (pid/port) is written to `services/_serving/run/<id>.json`; a fresh app
 * process re-adopts a still-alive server instead of relaunching it.
 */
export interface ServiceSpec {
  id: string;
  label: string;
  description: string;
  /** 'model' (serves downloaded weights) or 'app' (a tool with no weights). */
  category: 'model' | 'app';
  cwd: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  port: number;
  /** Path probed for readiness (expects HTTP 200 when ready). */
  healthPath: string;
  /** Local model directory this service serves, if known. */
  modelPath: string | null;
}

export type ReadyState = 'stopped' | 'starting' | 'ready' | 'error';

export interface ServiceStatus {
  id: string;
  label: string;
  description: string;
  category: 'model' | 'app';
  port: number;
  url: string;
  modelPath: string | null;
  readyState: ReadyState;
  pid: number | null;
  startedAt: string | null;
  /** True when the running server was adopted from a previous app process. */
  adopted: boolean;
  error: string | null;
  logTail: string[];
}

interface RunState {
  pid: number;
  port: number;
  startedAt: string;
}

const RUN_DIR = join(process.cwd(), 'services', '_serving', 'run');

/** In-memory readyState cache + poll timer, keyed by service id. Rebuilt lazily. */
interface Tracked {
  readyState: ReadyState;
  error: string | null;
  poll: ReturnType<typeof setInterval> | null;
}
const tracked = new Map<string, Tracked>();

function ensureRunDir(): void {
  if (!existsSync(RUN_DIR)) mkdirSync(RUN_DIR, { recursive: true });
}
function stateFile(id: string): string {
  return join(RUN_DIR, `${id}.json`);
}
function logFile(id: string): string {
  return join(RUN_DIR, `${id}.log`);
}

function readState(id: string): RunState | null {
  try {
    return JSON.parse(readFileSync(stateFile(id), 'utf8')) as RunState;
  } catch {
    return null;
  }
}
function writeState(id: string, st: RunState): void {
  ensureRunDir();
  writeFileSync(stateFile(id), JSON.stringify(st, null, 2));
}
function clearState(id: string): void {
  try { rmSync(stateFile(id)); } catch { /* gone */ }
}

/** Is `pid` a live process? `kill(pid, 0)` throws ESRCH when it isn't. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLogTail(id: string, n = 40): string[] {
  try {
    const text = readFileSync(logFile(id), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

async function probeHealth(spec: ServiceSpec): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${spec.port}${spec.healthPath}`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Background poller: flips starting→ready on health, →stopped if the pid dies. */
function startPoller(spec: ServiceSpec): void {
  const t = tracked.get(spec.id);
  if (!t || t.poll) return;
  t.poll = setInterval(async () => {
    const st = readState(spec.id);
    if (!st || !pidAlive(st.pid)) {
      // Process is gone — but don't clobber a real error we already recorded.
      if (t.readyState !== 'error') t.readyState = 'stopped';
      stopPoller(spec.id);
      return;
    }
    if (await probeHealth(spec)) {
      t.readyState = 'ready';
      stopPoller(spec.id);
    }
  }, 2000);
}
function stopPoller(id: string): void {
  const t = tracked.get(id);
  if (t?.poll) { clearInterval(t.poll); t.poll = null; }
}

function stoppedStatus(spec: ServiceSpec): ServiceStatus {
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    category: spec.category,
    port: spec.port,
    url: `http://127.0.0.1:${spec.port}`,
    modelPath: spec.modelPath,
    readyState: 'stopped',
    pid: null,
    startedAt: null,
    adopted: false,
    error: null,
    logTail: [],
  };
}

/**
 * Current status. Source of truth is the on-disk state file + pid liveness, so
 * this reports correctly even for a server started by a previous app process.
 */
export function getServiceStatus(spec: ServiceSpec): ServiceStatus {
  const st = readState(spec.id);
  if (!st || !pidAlive(st.pid)) {
    if (st) clearState(spec.id); // stale file from a dead process
    const t = tracked.get(spec.id);
    // Preserve a recorded spawn error so the UI can show why it failed.
    if (t?.readyState === 'error') {
      return { ...stoppedStatus(spec), readyState: 'error', error: t.error, logTail: readLogTail(spec.id) };
    }
    return stoppedStatus(spec);
  }

  // Live pid. Ensure we're tracking + polling it (adopts cross-process servers).
  let t = tracked.get(spec.id);
  if (!t) {
    t = { readyState: 'starting', error: null, poll: null };
    tracked.set(spec.id, t);
  }
  if (t.readyState === 'starting') startPoller(spec);

  const adopted = !ownPids.has(st.pid);
  return {
    id: spec.id,
    label: spec.label,
    description: spec.description,
    category: spec.category,
    port: spec.port,
    url: `http://127.0.0.1:${spec.port}`,
    modelPath: spec.modelPath,
    readyState: t.readyState,
    pid: st.pid,
    startedAt: st.startedAt,
    adopted,
    error: t.error,
    logTail: readLogTail(spec.id),
  };
}

/** pids of servers WE spawned this process (vs. adopted ones). */
const ownPids = new Set<number>();

/**
 * Start a service. Idempotent: if a live server is already recorded (ours OR
 * adopted from a previous app run), returns its status without relaunching —
 * so a web-app restart never re-pays the model load.
 */
export function startService(spec: ServiceSpec): ServiceStatus {
  const st = readState(spec.id);
  if (st && pidAlive(st.pid)) return getServiceStatus(spec);
  if (st) clearState(spec.id);

  ensureRunDir();
  // Redirect stdio to a log file (NOT pipes): pipes break when the parent app
  // exits and would take the detached child down with them.
  const out = openSync(logFile(spec.id), 'a');
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
    stdio: ['ignore', out, out],
    detached: true, // own process group → survives app restart, group-killable
  });
  closeSync(out);

  if (!child.pid) {
    const t: Tracked = { readyState: 'error', error: 'failed to spawn service process', poll: null };
    tracked.set(spec.id, t);
    return getServiceStatus(spec);
  }

  ownPids.add(child.pid);
  writeState(spec.id, { pid: child.pid, port: spec.port, startedAt: new Date().toISOString() });
  const t: Tracked = { readyState: 'starting', error: null, poll: null };
  tracked.set(spec.id, t);

  child.on('error', (err) => {
    t.readyState = 'error';
    t.error = String(err?.message ?? err);
  });
  child.on('exit', (code, signal) => {
    if (code && code !== 0) {
      t.readyState = 'error';
      t.error = `process exited (code ${code}, signal ${signal ?? 'null'})`;
    }
    clearState(spec.id);
  });
  // Detach: let the app event loop exit without waiting on this child.
  child.unref();

  startPoller(spec);
  return getServiceStatus(spec);
}

/** Stop a service, killing its whole process group (harness + model server). */
export async function stopService(id: string, spec?: ServiceSpec): Promise<void> {
  const st = readState(id);
  stopPoller(id);
  const t = tracked.get(id);
  if (t) t.readyState = 'stopped';
  if (!st) { clearState(id); return; }

  const kill = (sig: NodeJS.Signals) => {
    try { process.kill(-st.pid, sig); } catch { try { process.kill(st.pid, sig); } catch { /* gone */ } }
  };
  if (pidAlive(st.pid)) {
    kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const iv = setInterval(() => {
        if (!pidAlive(st.pid) || Date.now() - start > 5000) {
          if (pidAlive(st.pid)) kill('SIGKILL');
          clearInterval(iv);
          resolve();
        }
      }, 250);
    });
  }
  ownPids.delete(st.pid);
  clearState(id);
  void spec;
}

/**
 * Re-adopt any servers left running by a previous app process. Called at
 * startup so their status is warm immediately. Stale state files (dead pids)
 * are cleaned up.
 */
export function adoptExisting(specs: ServiceSpec[]): void {
  ensureRunDir();
  const known = new Set(specs.map((s) => s.id));
  // Clean orphan state files for services no longer registered.
  try {
    for (const f of readdirSync(RUN_DIR)) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (!known.has(id)) clearState(id);
    }
  } catch { /* run dir may not exist yet */ }
  for (const spec of specs) getServiceStatus(spec); // triggers adopt + poll
}
