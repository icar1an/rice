#!/usr/bin/env node
/* Claude Code hook: reads stdin JSON, writes ~/.claude/rice-state/<session_id>.json.
   Invoked as: node rice-hook.js <event>
   Events: session-start | user-prompt | pre-tool | post-tool | stop | notification */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const event = process.argv[2] || 'unknown';
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  try {
    run();
  } catch (e) {
    logError(e);
  }
  process.exit(0);
});

process.stdin.on('error', (e) => { logError(e); process.exit(0); });

function run() {
  const payload = raw ? safeParse(raw) : {};
  const sessionId = payload.session_id || 'unknown';
  const cwd = payload.cwd || process.cwd();
  const toolName = payload.tool_name;
  const toolInput = payload.tool_input || {};

  const { state, msg } = resolveState(event, toolName, toolInput);

  const outDir = path.join(os.homedir(), '.claude', 'rice-state');
  fs.mkdirSync(outDir, { recursive: true });

  const ancestorPids = getAncestorPids(process.pid, 6);
  const outFile = path.join(outDir, sessionId + '.json');
  const record = {
    sessionId,
    state,
    msg,
    cwd,
    toolName: toolName || null,
    event,
    ancestorPids,
    ts: Date.now(),
  };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));

  // Any event is a fresh heartbeat for this session. Any *other* state file
  // whose claude-CLI PID (ancestorPids[0]) matches ours is a superseded
  // session — e.g. the one the user just /clear'd or /compact'd. Prune it
  // so a stale mascot doesn't linger until STALE_MS expires.
  pruneSupersededSessions(outDir, sessionId, ancestorPids[0]);
}

function pruneSupersededSessions(stateDir, currentSessionId, currentClaudePid) {
  if (typeof currentClaudePid !== 'number') return;
  let entries;
  try { entries = fs.readdirSync(stateDir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('focus-')) continue;
    const otherSessionId = name.slice(0, -'.json'.length);
    if (otherSessionId === currentSessionId) continue;
    const full = path.join(stateDir, name);
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const otherClaudePid = Array.isArray(data.ancestorPids) ? data.ancestorPids[0] : null;
      if (otherClaudePid === currentClaudePid) {
        try { fs.unlinkSync(full); } catch {}
      }
    } catch {
      // Partial write or bad JSON — leave it; the watcher's sweep will handle it.
    }
  }
}

function getAncestorPids(startPid, depth) {
  const out = [];
  let pid = startPid;
  for (let i = 0; i < depth; i++) {
    try {
      const raw = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString().trim();
      const ppid = Number(raw);
      if (!Number.isFinite(ppid) || ppid <= 1) break;
      out.push(ppid);
      pid = ppid;
    } catch {
      break;
    }
  }
  return out;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function resolveState(ev, toolName, toolInput) {
  switch (ev) {
    case 'session-start':
      return { state: 'idle', msg: '$ claude started' };
    case 'user-prompt':
      return { state: 'thinking', msg: '$ thinking...' };
    case 'pre-tool':
      return mapTool(toolName, toolInput);
    case 'post-tool':
      return { state: 'thinking', msg: '$ ...' };
    case 'stop':
      return { state: 'done', msg: '\u2713 done' };
    case 'notification':
      return { state: 'waiting', msg: '? needs input' };
    default:
      return { state: 'idle', msg: '' };
  }
}

function mapTool(toolName, toolInput) {
  const n = toolName || '';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n)) {
    const f = toolInput.file_path || toolInput.path || '';
    const base = f ? f.split('/').pop() : 'file';
    return { state: 'planting', msg: '$ edit ' + base };
  }
  if (n === 'Bash') {
    const cmd = String(toolInput.command || '').split('\n')[0].slice(0, 48);
    return { state: 'harvesting', msg: '$ ' + (cmd || 'bash') };
  }
  if (/^(Grep|Glob|Read|LS|NotebookRead)$/.test(n)) {
    const hint = toolInput.pattern || toolInput.file_path || toolInput.path || '';
    const short = hint ? String(hint).slice(0, 32) : '';
    return { state: 'walking', msg: '$ ' + n.toLowerCase() + (short ? ' ' + short : '') };
  }
  if (/^(Task|Agent)/.test(n)) {
    return { state: 'walking', msg: '$ agent' };
  }
  if (n === 'WebFetch' || n === 'WebSearch') {
    return { state: 'walking', msg: '$ ' + n.toLowerCase() };
  }
  return { state: 'thinking', msg: n ? '$ ' + n.toLowerCase() : '$ tool' };
}

function logError(e) {
  try {
    const dir = path.join(os.homedir(), '.claude', 'rice-state');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, '.errors.log'),
      new Date().toISOString() + ' ' + (e && e.stack ? e.stack : String(e)) + '\n');
  } catch {}
}
