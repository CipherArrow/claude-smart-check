// Smart-check durable session state + CLI control channel.
//
// The monitor is a detached process that reconcile may kill and replace at any time, but
// smart-check's session facts — which model the pane is on, whether the primary model is
// unavailable, whether automation is pinned or halted — must survive that replacement: a
// fresh monitor that forgot the pane was mid-fallback would never finish promoting the
// effort level, and one that forgot a pin would resume the switch-back the user disabled.
// So the durable fields live in a per-pane JSON file, PID-validated the same way the
// reconcile exclude list is (a recycled pane id with a NEW claude must not inherit the
// old session's model state).
//
// The same directory doubles as the CLI→monitor control channel: `claude smart-check
// stay|resume|back|rephrase|on|off` writes a short-lived command marker the monitor
// consumes on its next tick — the exact write/consume shape of the StopFailure events.
//
// Mirrors events.js/status-file.js: atomic tmp+rename writes, sanitized <socket>_<pane>
// keys, age-gated consume-on-read markers.

import { mkdir, writeFile, readFile, unlink, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKey } from './pane-key.js';

export const SMARTCHECK_DIR = join(homedir(), '.claude-auto-retry', 'smartcheck');

// Commands the CLI may issue. Anything else in a marker is ignored (consume-and-drop),
// so an older/newer CLI writing an unknown command can't wedge the monitor.
export const SMARTCHECK_COMMANDS = new Set(['stay', 'resume', 'back', 'rephrase', 'on', 'off']);
const COMMAND_MAX_AGE_MS = 120_000;

// Same socket disambiguation as status-file.js: pane ids are only unique per tmux server.
export function socketIdFromEnv(env = process.env) {
  const tmuxEnv = env.TMUX || '';
  return tmuxEnv.split(',')[0] || 'default';
}

function keyFor(paneKey, socketId = socketIdFromEnv()) {
  return `${sanitizeKey(socketId)}_${sanitizeKey(paneKey)}`;
}

function stateFile(paneKey, dir, socketId) {
  return join(dir, `${keyFor(paneKey, socketId)}.json`);
}

function commandFile(paneKey, dir, socketId) {
  return join(dir, `${keyFor(paneKey, socketId)}.cmd.json`);
}

async function atomicWrite(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, file);
}

// --- Durable session state ---

export async function writeSmartState(paneKey, claudePid, fields, dir = SMARTCHECK_DIR) {
  if (!paneKey) return null;
  await mkdir(dir, { recursive: true });
  const file = stateFile(paneKey, dir);
  await atomicWrite(file, JSON.stringify({ ...fields, claudePid, updatedAt: Math.floor(Date.now() / 1000) }));
  return file;
}

// PID-validated: state written for a different claude in a recycled pane is stale — the
// caller starts fresh (and the sweep below removes the file eventually).
export async function readSmartState(paneKey, claudePid, dir = SMARTCHECK_DIR, socketId = undefined) {
  if (!paneKey) return null;
  try {
    const data = JSON.parse(await readFile(stateFile(paneKey, dir, socketId), 'utf-8'));
    if (claudePid != null && data.claudePid !== claudePid) return null;
    return data;
  } catch { return null; }
}

export async function clearSmartState(paneKey, dir = SMARTCHECK_DIR) {
  try { await unlink(stateFile(paneKey, dir)); } catch { /* already gone */ }
}

// --- CLI → monitor control markers ---

export async function writeSmartCommand(paneKey, cmd, dir = SMARTCHECK_DIR, socketId = undefined) {
  if (!paneKey || !SMARTCHECK_COMMANDS.has(cmd)) return null;
  await mkdir(dir, { recursive: true });
  const file = commandFile(paneKey, dir, socketId);
  await atomicWrite(file, JSON.stringify({ cmd, ts: Date.now() }));
  return file;
}

// Key-addressed variant for a CLI running OUTSIDE tmux: targets an existing state file's
// key directly (the key already embeds the socket+pane).
export async function writeSmartCommandForKey(key, cmd, dir = SMARTCHECK_DIR) {
  if (!key || !SMARTCHECK_COMMANDS.has(cmd)) return null;
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sanitizeKey(key)}.cmd.json`);
  await atomicWrite(file, JSON.stringify({ cmd, ts: Date.now() }));
  return file;
}

// Consume-on-read: the marker is removed whether or not it turns out to be applicable,
// so a stale/unknown command can never replay.
export async function consumeSmartCommand(paneKey, dir = SMARTCHECK_DIR) {
  if (!paneKey) return null;
  const file = commandFile(paneKey, dir);
  let ev = null;
  try {
    ev = JSON.parse(await readFile(file, 'utf-8'));
  } catch { return null; }
  try { await unlink(file); } catch { /* already gone */ }
  if (!ev || typeof ev.ts !== 'number' || Date.now() - ev.ts > COMMAND_MAX_AGE_MS) return null;
  if (!SMARTCHECK_COMMANDS.has(ev.cmd)) return null;
  return ev.cmd;
}

// --- GC + CLI status enumeration ---

// Remove state/command files whose claude PID is dead (state) or that are simply old
// (commands). Called best-effort on monitor start, like sweepStaleStatus.
export async function sweepStaleSmartState(dir = SMARTCHECK_DIR) {
  let entries;
  try { entries = await readdir(dir); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    const file = join(dir, name);
    try {
      if (name.endsWith('.cmd.json')) {
        const ev = JSON.parse(await readFile(file, 'utf-8'));
        if (typeof ev.ts !== 'number' || Date.now() - ev.ts > COMMAND_MAX_AGE_MS) { await unlink(file); removed++; }
      } else if (name.endsWith('.json')) {
        const data = JSON.parse(await readFile(file, 'utf-8'));
        let alive = false;
        if (typeof data.claudePid === 'number') {
          try { process.kill(data.claudePid, 0); alive = true; } catch { alive = false; }
        }
        if (!alive) { await unlink(file); removed++; }
      } else if (name.endsWith('.tmp')) {
        await unlink(file); removed++;
      }
    } catch {
      try { await unlink(file); removed++; } catch { /* already gone */ }
    }
  }
  return removed;
}

// For `claude smart-check status`: every live state file, keyed for display.
export async function listSmartStates(dir = SMARTCHECK_DIR) {
  let entries;
  try { entries = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith('.cmd.json')) continue;
    try {
      const data = JSON.parse(await readFile(join(dir, name), 'utf-8'));
      out.push({ key: name.replace(/\.json$/, ''), ...data });
    } catch { /* skip corrupt */ }
  }
  return out;
}
