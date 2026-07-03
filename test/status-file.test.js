import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStatus, readStatus, clearStatus } from '../src/status-file.js';

describe('per-pane status file', () => {
  let dir;
  before(async () => { dir = await mkdtemp(join(tmpdir(), 'car-status-')); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips a pane-keyed status snapshot', async () => {
    await writeStatus('%2', { status: 'monitoring', waitUntil: 0, overloadWaitUntil: 0, attempts: 0, overloadAttempts: 0 }, dir);
    const s = await readStatus('%2', dir);
    assert.equal(s.status, 'monitoring');
    assert.equal(typeof s.updatedAt, 'number');
  });

  it('stamps updatedAt in epoch seconds, overwriting any caller-supplied value', async () => {
    const before_ = Math.floor(Date.now() / 1000);
    await writeStatus('%2', { status: 'monitoring', updatedAt: 1 }, dir);
    const s = await readStatus('%2', dir);
    assert.ok(s.updatedAt >= before_, 'updatedAt should be a real current-time stamp, not the caller value');
  });

  it('sanitizes the pane id into the filename', async () => {
    await writeStatus('%7', { status: 'monitoring' }, dir);
    const files = await readdir(dir);
    assert.ok(files.includes('_7.json'), files.join(','));
  });

  it('returns null for an absent pane', async () => {
    assert.equal(await readStatus('%99', dir), null);
  });

  it('ignores an unparseable status file', async () => {
    await writeFile(join(dir, '_4.json'), 'not json');
    assert.equal(await readStatus('%4', dir), null);
  });

  it('clear() removes the status file', async () => {
    await writeStatus('%5', { status: 'waiting' }, dir);
    await clearStatus('%5', dir);
    assert.equal(await readStatus('%5', dir), null);
  });

  it('clear() on an absent pane is a no-op', async () => {
    await assert.doesNotReject(clearStatus('%no-such-pane', dir));
  });

  it('write is a no-op without a pane key', async () => {
    assert.equal(await writeStatus('', { status: 'monitoring' }, dir), null);
  });

  it('overwrites a previous snapshot for the same pane', async () => {
    await writeStatus('%6', { status: 'monitoring' }, dir);
    await writeStatus('%6', { status: 'waiting', waitUntil: 12345 }, dir);
    const s = await readStatus('%6', dir);
    assert.equal(s.status, 'waiting');
    assert.equal(s.waitUntil, 12345);
  });
});
