import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeSmartState, readSmartState, clearSmartState,
  writeSmartCommand, writeSmartCommandForKey, consumeSmartCommand,
  sweepStaleSmartState, listSmartStates, socketIdFromEnv,
} from '../src/smartcheck-state.js';
import { sanitizeKey } from '../src/pane-key.js';

const FIELDS = { currentModel: 'fallback', pinned: false, enabled: true, primaryUnavailable: false, halted: false, lastFlagAt: 123, cleanTurns: 2, lastHandledBanner: 'x|Opus 4.8', pendingFallback: true };

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'smartcheck-test-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

describe('smart-check durable state', () => {
  it('round-trips fields and stamps claudePid + updatedAt', () => withDir(async (dir) => {
    await writeSmartState('%1', process.pid, FIELDS, dir);
    const back = await readSmartState('%1', process.pid, dir);
    assert.equal(back.currentModel, 'fallback');
    assert.equal(back.pendingFallback, true);
    assert.equal(back.claudePid, process.pid);
    assert.ok(back.updatedAt > 0);
  }));

  it('rejects a PID mismatch (recycled pane id, new claude)', () => withDir(async (dir) => {
    await writeSmartState('%1', 12345, FIELDS, dir);
    assert.equal(await readSmartState('%1', 99999, dir), null);
  }));

  it('clearSmartState removes the file; missing file is a no-op', () => withDir(async (dir) => {
    await writeSmartState('%1', process.pid, FIELDS, dir);
    await clearSmartState('%1', dir);
    assert.equal(await readSmartState('%1', process.pid, dir), null);
    await clearSmartState('%1', dir); // no throw
  }));

  it('sweep removes state for dead PIDs and keeps live ones', () => withDir(async (dir) => {
    await writeSmartState('%1', process.pid, FIELDS, dir);   // alive (this test process)
    await writeSmartState('%2', 2 ** 30, FIELDS, dir);        // certainly dead
    const removed = await sweepStaleSmartState(dir);
    assert.equal(removed, 1);
    assert.ok(await readSmartState('%1', process.pid, dir));
  }));

  it('listSmartStates enumerates state files but not command markers', () => withDir(async (dir) => {
    await writeSmartState('%1', process.pid, FIELDS, dir);
    await writeSmartCommand('%1', 'stay', dir);
    const list = await listSmartStates(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].currentModel, 'fallback');
  }));
});

describe('smart-check command markers', () => {
  it('write → consume returns the command and removes the marker', () => withDir(async (dir) => {
    await writeSmartCommand('%1', 'stay', dir);
    assert.equal(await consumeSmartCommand('%1', dir), 'stay');
    assert.equal(await consumeSmartCommand('%1', dir), null);
  }));

  it('rejects unknown commands at write time', () => withDir(async (dir) => {
    assert.equal(await writeSmartCommand('%1', 'reboot', dir), null);
    assert.equal((await readdir(dir).catch(() => [])).length, 0);
  }));

  it('a stale marker is consumed but not applied', () => withDir(async (dir) => {
    const file = await writeSmartCommand('%1', 'back', dir);
    // Rewrite with an ancient timestamp (bypassing the writer) to simulate staleness.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify({ cmd: 'back', ts: Date.now() - 10 * 60_000 }));
    assert.equal(await consumeSmartCommand('%1', dir), null);
    assert.equal((await readdir(dir)).filter((f) => f.endsWith('.cmd.json')).length, 0);
  }));

  it('key-addressed write matches the pane-addressed consume', () => withDir(async (dir) => {
    // Compute the key exactly as the monitor's consume does (env-dependent socket).
    const key = `${sanitizeKey(socketIdFromEnv())}_${sanitizeKey('%1')}`;
    await writeSmartCommandForKey(key, 'resume', dir);
    assert.equal(await consumeSmartCommand('%1', dir), 'resume');
  }));
});
