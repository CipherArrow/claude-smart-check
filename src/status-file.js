// Per-pane status channel for external consumers (tmux status bar, etc).
//
// The monitor's state lives in-memory inside a detached, unref'd process — nothing
// outside it can see whether a given pane is being watched, waiting on a rate-limit
// reset, or backing off from overload. This writes a small JSON snapshot per pane on
// every tick so a cheap shell script (see bin/tmux-status.sh) can render an indicator
// without talking to the monitor process directly.
//
// Timestamps are epoch SECONDS, not ms — bash readers on macOS can't do `date +%s%3N`
// (BSD date has no %N), so seconds keeps the reader script portable and dependency-free.
//
// Mirrors the pane-keyed write/read/clear shape of events.js (StopFailure markers).

import { mkdir, writeFile, readFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const STATUS_DIR = join(homedir(), '.claude-auto-retry', 'status');

// tmux pane ids look like "%2"; keep the filename to a safe charset.
function fileFor(paneKey, dir) {
  const safe = String(paneKey).replace(/[^A-Za-z0-9_-]/g, '_');
  return join(dir, `${safe}.json`);
}

// Atomic (tmp + rename) so a reader never sees a half-written file. updatedAt is always
// stamped here (not caller-supplied) so staleness checks reflect the actual write time.
export async function writeStatus(paneKey, data, dir = STATUS_DIR) {
  if (!paneKey) return null;
  await mkdir(dir, { recursive: true });
  const file = fileFor(paneKey, dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...data, updatedAt: Math.floor(Date.now() / 1000) });
  await writeFile(tmp, body);
  await rename(tmp, file);
  return file;
}

export async function readStatus(paneKey, dir = STATUS_DIR) {
  if (!paneKey) return null;
  try {
    return JSON.parse(await readFile(fileFor(paneKey, dir), 'utf-8'));
  } catch {
    return null;
  }
}

export async function clearStatus(paneKey, dir = STATUS_DIR) {
  try { await unlink(fileFor(paneKey, dir)); } catch { /* already gone */ }
}
