import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export type FarmerState =
  | 'idle'
  | 'thinking'
  | 'planting'
  | 'harvesting'
  | 'walking'
  | 'waiting'
  | 'done';

export interface Farmer {
  id: string;
  name: string;
  state: FarmerState;
  msg: string;
  cwd?: string;
  plotId?: string;
  ancestorPids?: number[];
  ts: number;
}

const STALE_MS = 10 * 60 * 1000; // 10 minutes without update => drop
const FOCUS_PREFIX = 'focus-';
const FOCUS_TTL_MS = 5_000;

export interface FocusRequest {
  sessionId: string;
  requestId: string;
  ts: number;
  filePath: string;
}

export class StateWatcher {
  readonly stateDir: string;
  private readonly farmers = new Map<string, Farmer>();
  private fsWatcher?: fs.FSWatcher;
  private readonly emitter = new vscode.EventEmitter<Farmer[]>();
  private readonly focusEmitter = new vscode.EventEmitter<FocusRequest>();
  readonly onDidChange = this.emitter.event;
  readonly onDidRequestFocus = this.focusEmitter.event;
  private readonly seenFocusRequests = new Set<string>();
  private debounce?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;

  constructor() {
    this.stateDir = path.join(os.homedir(), '.claude', 'rice-state');
  }

  async start(): Promise<void> {
    await fsp.mkdir(this.stateDir, { recursive: true });
    await this.cleanupStaleFocusRequests();
    await this.loadAll();

    try {
      this.fsWatcher = fs.watch(this.stateDir, (_event, filename) => {
        if (!filename || !filename.endsWith('.json')) return;
        if (filename.startsWith(FOCUS_PREFIX)) {
          this.handleFocusFile(path.join(this.stateDir, filename)).catch(() => {});
          return;
        }
        const full = path.join(this.stateDir, filename);
        fs.stat(full, (err) => {
          if (err) {
            const id = path.basename(filename, '.json');
            if (this.farmers.delete(id)) this.schedule();
          } else {
            this.loadOne(full).catch(() => {});
          }
        });
      });
    } catch {
      // swallow; re-attempt via sweep
    }

    this.sweepTimer = setInterval(() => this.sweep(), 5_000);
  }

  async requestFocus(sessionId: string): Promise<string> {
    const requestId = crypto.randomUUID();
    const filePath = path.join(this.stateDir, `${FOCUS_PREFIX}${requestId}.json`);
    const body = { sessionId, requestId, ts: Date.now() };
    // Don't handle our own request — mark it seen before writing.
    this.seenFocusRequests.add(filePath);
    await fsp.writeFile(filePath, JSON.stringify(body, null, 2));
    return filePath;
  }

  getAll(): Farmer[] {
    return Array.from(this.farmers.values()).sort((a, b) => a.ts - b.ts);
  }

  dispose(): void {
    this.fsWatcher?.close();
    this.emitter.dispose();
    this.focusEmitter.dispose();
    if (this.debounce) clearTimeout(this.debounce);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async loadAll(): Promise<void> {
    try {
      const entries = await fsp.readdir(this.stateDir);
      await Promise.all(
        entries
          .filter((f) => f.endsWith('.json') && !f.startsWith(FOCUS_PREFIX))
          .map((f) => this.loadOne(path.join(this.stateDir, f)))
      );
    } catch {
      // ignore
    }
    this.schedule();
  }

  private async cleanupStaleFocusRequests(): Promise<void> {
    try {
      const entries = await fsp.readdir(this.stateDir);
      const now = Date.now();
      await Promise.all(
        entries
          .filter((f) => f.startsWith(FOCUS_PREFIX) && f.endsWith('.json'))
          .map(async (f) => {
            const full = path.join(this.stateDir, f);
            try {
              const s = await fsp.stat(full);
              if (now - s.mtimeMs > FOCUS_TTL_MS) {
                await fsp.unlink(full).catch(() => {});
              }
            } catch {
              // ignore
            }
          })
      );
    } catch {
      // ignore
    }
  }

  private async handleFocusFile(filePath: string): Promise<void> {
    if (this.seenFocusRequests.has(filePath)) return;
    this.seenFocusRequests.add(filePath);
    // Prune the seen-set so it doesn't grow unbounded.
    if (this.seenFocusRequests.size > 256) {
      const keep = Array.from(this.seenFocusRequests).slice(-128);
      this.seenFocusRequests.clear();
      for (const k of keep) this.seenFocusRequests.add(k);
    }
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data.sessionId !== 'string' || typeof data.requestId !== 'string') return;
      const ts = typeof data.ts === 'number' ? data.ts : 0;
      if (ts && Date.now() - ts > FOCUS_TTL_MS) return;
      this.focusEmitter.fire({ sessionId: data.sessionId, requestId: data.requestId, ts, filePath });
    } catch {
      // partial write or bad JSON; ignore
    }
  }

  private async loadOne(filePath: string): Promise<void> {
    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const data = JSON.parse(raw);
      const id = data.sessionId || path.basename(filePath, '.json');
      const ancestorPids = Array.isArray(data.ancestorPids)
        ? data.ancestorPids.filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
        : undefined;

      if (ancestorPids && ancestorPids.length > 0 && !isSessionAlive(ancestorPids)) {
        fsp.unlink(filePath).catch(() => {});
        if (this.farmers.delete(id)) this.schedule();
        return;
      }

      const farmer: Farmer = {
        id,
        name: shortName(id),
        state: normalizeState(data.state),
        msg: typeof data.msg === 'string' ? data.msg : '',
        cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
        ancestorPids,
        ts: typeof data.ts === 'number' ? data.ts : Date.now(),
      };
      this.farmers.set(id, farmer);
      this.evictSupersededBy(farmer);
    } catch {
      // Ignore; partial write or bad JSON
    }
    this.schedule();
  }

  // Two farmers that share the same claude CLI PID (ancestorPids[0]) must be
  // the same terminal. Only the newest session_id is current; anything older
  // is a leftover from /clear or /compact. Evict the older one and unlink its
  // file so the webview reflects reality immediately.
  private evictSupersededBy(current: Farmer): void {
    const currentPid = current.ancestorPids?.[0];
    if (typeof currentPid !== 'number') return;
    for (const [otherId, other] of this.farmers) {
      if (otherId === current.id) continue;
      if (other.ancestorPids?.[0] !== currentPid) continue;
      if (other.ts >= current.ts) continue;
      this.farmers.delete(otherId);
      fsp.unlink(path.join(this.stateDir, otherId + '.json')).catch(() => {});
    }
  }

  private schedule(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.emitter.fire(this.getAll()), 60);
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, f] of this.farmers) {
      const stale = now - f.ts > STALE_MS;
      const dead = !!f.ancestorPids && f.ancestorPids.length > 0 && !isSessionAlive(f.ancestorPids);
      if (stale || dead) {
        this.farmers.delete(id);
        if (dead) {
          fsp.unlink(path.join(this.stateDir, id + '.json')).catch(() => {});
        }
        changed = true;
      }
    }
    if (changed) this.schedule();
  }
}

// ancestorPids[0] is the hook's immediate parent: the `claude` CLI process.
// When the terminal closes, SIGHUP kills the shell and claude with it; when
// claude exits via /exit, the PID dies too. Deeper ancestors (pty-host, the
// VS Code app) outlive the session and must not gate liveness.
function isSessionAlive(pids: number[]): boolean {
  const claudePid = pids[0];
  if (typeof claudePid !== 'number') return false;
  try {
    process.kill(claudePid, 0);
    return true;
  } catch {
    return false;
  }
}

function shortName(id: string): string {
  const tail = id.replace(/[^a-zA-Z0-9]/g, '').slice(-6) || id;
  return 'claude-' + tail;
}

function normalizeState(s: unknown): FarmerState {
  const valid: FarmerState[] = ['idle', 'thinking', 'planting', 'harvesting', 'walking', 'waiting', 'done'];
  return (valid.includes(s as FarmerState) ? s : 'idle') as FarmerState;
}
