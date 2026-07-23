import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  downgradeMatch, confirmationCount, isInputEmpty, isPickerOpen, menuStepsToOption,
  safeguardMatch,
} from '../src/patterns.js';
import { DEFAULT_CONFIG, DEFAULT_SMARTCHECK, DEFAULT_SAFEGUARD, loadConfig } from '../src/config.js';
import { createMonitorState, processOneTick, applySmartCommand, smartDurableFields, adoptSmartState } from '../src/monitor.js';

const SC = DEFAULT_SMARTCHECK;

// The silent-downgrade banner, verbatim from a live session (wrapped as rendered).
const BANNER_OPUS = [
  "● Fable 5's safeguards flagged this message. The safeguards are intentionally",
  '  broad right now and may flag safe and routine coding, cybersecurity, or',
  '  biology work. These measures let us bring you Mythos-level capabilities',
  "  sooner, and we're working to refine them. Switched to Opus 4.8. Send feedback",
  '  with /feedback or learn more',
].join('\n');

const BANNER_BELOW = BANNER_OPUS.replace('Switched to Opus 4.8.', 'Switched to Sonnet 4.5.');

// The legacy API-Error flag render (no switch happened) — owned by the safeguard path.
const LEGACY_FLAG = [
  "● API Error: Fable 5's safeguards flagged this message (https://www.anthropic.com/legal/aup).",
  "  Claude Code can't respond to this request with Fable 5.",
  '  Double press esc to edit your last message, or try a different model with /model.',
].join('\n');

const IDLE_CHROME = ['', '│ > │', '⏵⏵ auto mode on   (shift+tab to cycle)', ''].join('\n');
const WORKING_FOOTER = '✻ Cogitating… (esc to interrupt)';

const idleFrame = (...content) => [...content, IDLE_CHROME].join('\n');
const workingFrame = (...content) => [...content, WORKING_FOOTER].join('\n');

function mockTmux(frames) {
  // frames: array of pane captures, one per tick (last one repeats).
  let i = 0;
  const t = {
    _sent: [], _keys: [], _commands: [], _saved: null, _cmdQueue: [],
    capturePane: async () => frames[Math.min(i++, frames.length - 1)],
    getPaneCommand: async () => 'node',
    sendKeys: async (_p, text) => { t._sent.push(text); },
    sendKey: async (_p, key) => { t._keys.push(key); },
    sendCommand: async (_p, text) => { t._commands.push(text); },
    isClaudeForeground: async () => true,
    saveSmartState: async (fields) => { t._saved = fields; },
    readSmartCommand: async () => t._cmdQueue.shift() ?? null,
  };
  return t;
}

const tick = (state, t) => processOneTick(state, t, '%1', DEFAULT_CONFIG, () => true);

// --- pattern detectors ---

describe('downgradeMatch', () => {
  it('matches the live banner and captures the switched-to model', () => {
    const m = downgradeMatch(idleFrame(BANNER_OPUS), SC.downgradePatterns, SC.downgradeAnchors);
    assert.ok(m);
    assert.equal(m.switchedTo, 'Opus 4.8');
  });
  it('captures a below-fallback model name', () => {
    const m = downgradeMatch(idleFrame(BANNER_BELOW), SC.downgradePatterns, SC.downgradeAnchors);
    assert.ok(m);
    assert.equal(m.switchedTo, 'Sonnet 4.5');
  });
  it('does NOT match the legacy API-Error render (no "Switched to" anchor)', () => {
    assert.equal(downgradeMatch(idleFrame(LEGACY_FLAG), SC.downgradePatterns, SC.downgradeAnchors), null);
  });
  it('does NOT match a banner buried in scrollback with real work below it (tail discipline)', () => {
    const work = Array.from({ length: 25 }, (_, i) => `  ⎿ compiled module ${i}`).join('\n');
    assert.equal(downgradeMatch(idleFrame(BANNER_OPUS, work), SC.downgradePatterns, SC.downgradeAnchors), null);
  });
  it('legacy safeguardMatch still owns the API-Error render and ignores the ● banner', () => {
    assert.ok(safeguardMatch(idleFrame(LEGACY_FLAG), DEFAULT_SAFEGUARD.patterns));
    assert.equal(safeguardMatch(idleFrame(BANNER_OPUS), DEFAULT_SAFEGUARD.patterns), null);
  });
});

describe('confirmationCount / isInputEmpty / picker helpers', () => {
  it('counts confirmation renders', () => {
    const text = 'Set model to Opus 4.8\nstuff\nSet model to Opus 4.8\n';
    assert.equal(confirmationCount(text, 'Set model to Opus 4\\.8'), 2);
    assert.equal(confirmationCount(text, 'Set model to Fable 5'), 0);
  });
  it('empty boxed input row → empty; typed text → not empty; no row found → not empty', () => {
    assert.equal(isInputEmpty('stuff\n│ > │\nfooter'), true);
    assert.equal(isInputEmpty('stuff\n│ > half a thought │\nfooter'), false);
    assert.equal(isInputEmpty('no input row here at all'), false);
  });
  it('bare prompt forms', () => {
    assert.equal(isInputEmpty('stuff\n❯ '), true);
    assert.equal(isInputEmpty('stuff\n❯ typed'), false);
  });
  it('detects an open picker and computes steps to an option', () => {
    const picker = ['Select model:', '  1. Fable 5', '❯ 2. Default', '  3. Opus 4.8', ''].join('\n');
    assert.equal(isPickerOpen(picker), true);
    assert.equal(isPickerOpen(idleFrame('just prose')), false);
    assert.equal(menuStepsToOption(picker, 'Opus 4\\.8'), 1);
    assert.equal(menuStepsToOption(picker, 'Fable 5'), -1);
    assert.equal(menuStepsToOption(picker, 'Haiku'), null);
  });
});

// --- config validation ---

describe('smartCheck config validation', () => {
  it('defaults are present and enabled', async () => {
    const cfg = await loadConfig('/nonexistent/path.json');
    assert.equal(cfg.smartCheck.enabled, true);
    assert.equal(cfg.smartCheck.models.fallback.command, '/model claude-opus-4-8');
    assert.equal(cfg.smartCheck.effort.maxCycles, 6);
  });
});

// --- state machine: fallback promote sequence ---

describe('smartcheck fallback sequence', () => {
  it('runs detect → escape (only while working) → /model → verify → /effort → verify → nudge', async () => {
    const state = createMonitorState();
    state.smart.currentModel = 'primary';
    const t = mockTmux([
      workingFrame(BANNER_OPUS),                                   // 1: detect (working → interrupt)
      workingFrame(BANNER_OPUS),                                   // 2: escape sent
      idleFrame(BANNER_OPUS),                                      // 3: idle → set-model next
      idleFrame(BANNER_OPUS),                                      // 4: /model sent
      idleFrame(BANNER_OPUS, 'Set model to Opus 4.8'),             // 5: verified → set-effort
      idleFrame(BANNER_OPUS, 'Set model to Opus 4.8'),             // 6: /effort sent
      idleFrame('Set model to Opus 4.8', 'Set effort level to max'), // 7: verified → nudge
      idleFrame('Set effort level to max'),                        // 8: nudge sent, complete
    ]);
    assert.equal(await tick(state, t), 'smartcheck-downgrade-detected');
    assert.equal(state.status, 'smartcheck');
    assert.equal(await tick(state, t), 'smartcheck-escape-sent');
    assert.deepEqual(t._keys, ['Escape']);
    assert.equal(await tick(state, t), 'smartcheck-interrupted');
    assert.equal(await tick(state, t), 'smartcheck-model-sent');
    assert.deepEqual(t._commands, [SC.models.fallback.command]);
    assert.equal(await tick(state, t), 'smartcheck-model-verified');
    assert.equal(await tick(state, t), 'smartcheck-effort-sent');
    assert.deepEqual(t._commands, [SC.models.fallback.command, SC.effort.fallback.command]);
    assert.equal(await tick(state, t), 'smartcheck-effort-verified');
    assert.equal(await tick(state, t), 'smartcheck-fallback-complete');
    assert.deepEqual(t._sent, [DEFAULT_SMARTCHECK.nudgeMessage]);
    assert.equal(state.status, 'monitoring');
    assert.equal(state.smart.currentModel, 'fallback');
    assert.equal(state.smart.pendingFallback, false);
    assert.ok(t._saved);
    assert.equal(t._saved.currentModel, 'fallback');
  });

  it('never sends Escape when the banner arrives at an idle prompt', async () => {
    const state = createMonitorState();
    const t = mockTmux([idleFrame(BANNER_OPUS), idleFrame(BANNER_OPUS)]);
    assert.equal(await tick(state, t), 'smartcheck-downgrade-detected-idle');
    assert.equal(await tick(state, t), 'smartcheck-model-sent');
    assert.deepEqual(t._keys, []);
  });

  it('a handled banner still on screen does not re-trigger; banner leaving the tail resets the dedupe', async () => {
    const state = createMonitorState();
    state.smart.currentModel = 'fallback';
    const m = downgradeMatch(idleFrame(BANNER_OPUS), SC.downgradePatterns, SC.downgradeAnchors);
    state.smart.lastHandledBanner = m.fingerprint;
    const t = mockTmux([idleFrame(BANNER_OPUS), idleFrame('plain work output'), idleFrame(BANNER_OPUS)]);
    assert.equal(await tick(state, t), 'monitoring');          // same banner → ignored
    assert.equal(await tick(state, t), 'monitoring');          // banner gone → dedupe cleared
    assert.equal(state.smart.lastHandledBanner, null);
    assert.equal(await tick(state, t), 'smartcheck-downgrade-detected-idle'); // fresh incident
  });

  it('verify timeout without a picker gives up loudly and marks the banner handled', async () => {
    const state = createMonitorState();
    const t = mockTmux([idleFrame(BANNER_OPUS), idleFrame(BANNER_OPUS), idleFrame(BANNER_OPUS), idleFrame(BANNER_OPUS)]);
    await tick(state, t);                       // detect (idle)
    await tick(state, t);                       // /model sent
    state.smart.phaseDeadline = Date.now() - 1; // force the verify deadline
    assert.equal(await tick(state, t), 'smartcheck-gave-up');
    assert.equal(state.status, 'monitoring');
    assert.equal(await tick(state, t), 'monitoring'); // handled fingerprint → no re-entry loop
  });

  it('drives the model picker if /model opened one instead of applying', async () => {
    const state = createMonitorState();
    const picker = ['Select model:', '❯ 1. Fable 5', '  2. Opus 4.8', ''].join('\n');
    const t = mockTmux([
      idleFrame(BANNER_OPUS),
      idleFrame(BANNER_OPUS),
      picker,
      idleFrame('Set model to Opus 4.8'),
    ]);
    await tick(state, t);                       // detect
    await tick(state, t);                       // /model sent
    state.smart.phaseDeadline = Date.now() - 1;
    assert.equal(await tick(state, t), 'smartcheck-picker-driven');
    assert.deepEqual(t._keys, ['Down', 'Enter']);
    assert.equal(await tick(state, t), 'smartcheck-model-verified');
  });

  it('falls back to cycling bare /effort when the argument form is not confirmed', async () => {
    const state = createMonitorState();
    state.status = 'smartcheck';
    state.smart.phase = 'verify-effort';
    state.smart.fingerprint = 'f';
    state.smart.preSendCount = 0;
    state.smart.phaseDeadline = Date.now() - 1;
    const t = mockTmux([
      idleFrame('Set effort level to xhigh'),                 // cycle 1 → not max yet
      idleFrame('Set effort level to xhigh'),                 // (deadline forced again)
      idleFrame('Set effort level to xhigh', 'Set effort level to max'), // reached max
    ]);
    assert.equal(await tick(state, t), 'smartcheck-effort-cycled');
    assert.deepEqual(t._commands, ['/effort']);
    state.smart.phaseDeadline = Date.now() - 1;
    assert.equal(await tick(state, t), 'smartcheck-effort-cycled');
    assert.equal(await tick(state, t), 'smartcheck-effort-verified');
  });
});

// --- state machine: below-fallback halt ---

describe('smartcheck halt (below fallback)', () => {
  it('halts with ZERO keystrokes and stays halted across ticks', async () => {
    const state = createMonitorState();
    const t = mockTmux([idleFrame(BANNER_BELOW), idleFrame(BANNER_BELOW), idleFrame(LEGACY_FLAG)]);
    assert.equal(await tick(state, t), 'smartcheck-halted');
    assert.equal(state.smart.halted, true);
    assert.equal(state.smart.currentModel, 'below');
    assert.equal(await tick(state, t), 'smartcheck-halted-idle');
    // Even a legacy safeguard render must not trigger "continue" while halted.
    assert.equal(await tick(state, t), 'smartcheck-halted-idle');
    assert.deepEqual(t._sent, []);
    assert.deepEqual(t._keys, []);
    assert.deepEqual(t._commands, []);
  });

  it('`back` is refused while halted; `resume` clears the halt', async () => {
    const state = createMonitorState();
    state.smart.halted = true;
    state.smart.currentModel = 'below';
    const t = mockTmux([idleFrame('quiet'), idleFrame('quiet')]);
    t._cmdQueue.push('back');
    await tick(state, t);
    assert.equal(state._smartCmdApplied, 'smartcheck-cmd-back-refused');
    assert.equal(state.smart.forceBack, false);
    t._cmdQueue.push('resume');
    await tick(state, t);
    assert.equal(state.smart.halted, false);
    assert.equal(state.smart.currentModel, 'unknown');
  });

  it('`rephrase` sends the rephrase message once idle and re-enables automation', async () => {
    const state = createMonitorState();
    state.smart.halted = true;
    state.smart.currentModel = 'below';
    const t = mockTmux([idleFrame('quiet')]);
    t._cmdQueue.push('rephrase');
    assert.equal(await tick(state, t), 'smartcheck-rephrased');
    assert.deepEqual(t._sent, [DEFAULT_SMARTCHECK.rephraseMessage]);
    assert.equal(state.smart.halted, false);
    assert.equal(state.smart.currentModel, 'below'); // stays 'below' until reclassified
  });
});

// --- state machine: switch-back ---

function fallbackSteadyState() {
  const state = createMonitorState();
  state.smart.currentModel = 'fallback';
  state.smart.cleanTurns = DEFAULT_SMARTCHECK.cleanTurnsBeforeSwitchBack;
  state.smart.lastFlagAt = Date.now() - (DEFAULT_SMARTCHECK.switchBackCooldownMinutes + 1) * 60_000;
  return state;
}

describe('smartcheck switch-back', () => {
  it('runs the full restore: /model primary → verify → /effort → verify → complete', async () => {
    const state = fallbackSteadyState();
    const t = mockTmux([
      idleFrame('done working'),
      idleFrame('done working'),
      idleFrame('Set model to Fable 5'),
      idleFrame('Set model to Fable 5'),
      idleFrame('Set model to Fable 5', 'Set effort level to high'),
    ]);
    assert.equal(await tick(state, t), 'smartcheck-back-started');
    assert.equal(await tick(state, t), 'smartcheck-back-model-sent');
    assert.deepEqual(t._commands, [SC.models.primary.command]);
    assert.equal(await tick(state, t), 'smartcheck-back-model-verified');
    assert.equal(await tick(state, t), 'smartcheck-back-effort-sent');
    assert.deepEqual(t._commands, [SC.models.primary.command, SC.effort.primary.command]);
    assert.equal(await tick(state, t), 'smartcheck-back-complete');
    assert.equal(state.smart.currentModel, 'primary');
    assert.equal(state.status, 'monitoring');
  });

  it('each gate individually blocks the trigger', async () => {
    for (const mutate of [
      (s) => { s.smart.cleanTurns = 1; },
      (s) => { s.smart.lastFlagAt = Date.now(); },
      (s) => { s.smart.pinned = true; },
      (s) => { s.smart.primaryUnavailable = true; },
      (s) => { s.smart.enabled = false; },
    ]) {
      const state = fallbackSteadyState();
      mutate(state);
      const t = mockTmux([idleFrame('quiet')]);
      assert.equal(await tick(state, t), 'monitoring');
      assert.equal(state.status, 'monitoring');
    }
    // Non-empty input box blocks too.
    const state = fallbackSteadyState();
    const t = mockTmux(['stuff\n│ > mid-thought │\n']);
    assert.equal(await tick(state, t), 'monitoring');
    // Working pane blocks.
    const state2 = fallbackSteadyState();
    const t2 = mockTmux([workingFrame('busy')]);
    assert.equal(await tick(state2, t2), 'monitoring');
  });

  it('`back` forces the switch-back past the quiet period', async () => {
    const state = createMonitorState();
    state.smart.currentModel = 'fallback';
    state.smart.lastFlagAt = Date.now(); // cooldown NOT satisfied
    const t = mockTmux([idleFrame('quiet'), idleFrame('quiet')]);
    t._cmdQueue.push('back');
    assert.equal(await tick(state, t), 'smartcheck-back-started');
    assert.equal(state._smartCmdApplied, 'smartcheck-cmd-back');
  });

  it('primary unavailable during verify pins the fallback and disables auto-restore', async () => {
    const state = fallbackSteadyState();
    const t = mockTmux([
      idleFrame('quiet'),
      idleFrame('quiet'),
      idleFrame('⚠ Fable 5 is currently unavailable'),
      idleFrame('quiet'),
    ]);
    await tick(state, t);   // back-started
    await tick(state, t);   // /model primary sent
    assert.equal(await tick(state, t), 'smartcheck-primary-unavailable');
    assert.equal(state.smart.primaryUnavailable, true);
    assert.equal(state.status, 'monitoring');
    // Trigger conditions still look satisfied, but the pin blocks re-attempts.
    state.smart.cleanTurns = 99;
    assert.equal(await tick(state, t), 'monitoring');
  });

  it('user resuming work aborts the switch-back quietly and keeps cleanTurns', async () => {
    const state = fallbackSteadyState();
    const t = mockTmux([idleFrame('quiet'), workingFrame('user typed something')]);
    await tick(state, t);   // back-started
    assert.equal(await tick(state, t), 'smartcheck-back-aborted');
    assert.equal(state.status, 'monitoring');
    assert.equal(state.smart.cleanTurns, DEFAULT_SMARTCHECK.cleanTurnsBeforeSwitchBack);
    assert.deepEqual(t._commands, []);
  });
});

// --- restore-before-continue (usage-limit resume detour) ---

const LIMIT_BANNER = "⚠ You've hit your session limit · resets 3:00pm";

describe('smartcheck restore-before-continue', () => {
  function limitedFallbackState() {
    const state = createMonitorState();
    state.status = 'waiting';
    state.waitUntil = Date.now() - 1;      // reset timer expired
    state.smart.currentModel = 'fallback';
    state.smart.lastFlagAt = Date.now() - (DEFAULT_SMARTCHECK.switchBackCooldownMinutes + 1) * 60_000;
    return state;
  }

  it('restores primary model + effort BEFORE sending the usage continue', async () => {
    const state = limitedFallbackState();
    const t = mockTmux([
      idleFrame(LIMIT_BANNER),                                     // 1: wait expired → detour
      idleFrame(LIMIT_BANNER),                                     // 2: /model primary sent
      idleFrame(LIMIT_BANNER, 'Set model to Fable 5'),             // 3: verified
      idleFrame(LIMIT_BANNER, 'Set model to Fable 5'),             // 4: /effort sent
      idleFrame(LIMIT_BANNER, 'Set model to Fable 5', 'Set effort level to high'), // 5: verified → resume
      idleFrame(LIMIT_BANNER),                                     // 6: continue sent
    ]);
    assert.equal(await tick(state, t), 'smartcheck-back-before-retry');
    assert.equal(await tick(state, t), 'smartcheck-back-model-sent');
    assert.equal(await tick(state, t), 'smartcheck-back-model-verified');
    assert.equal(await tick(state, t), 'smartcheck-back-effort-sent');
    assert.equal(await tick(state, t), 'smartcheck-back-complete-resume');
    assert.equal(state.status, 'waiting');
    assert.equal(state.smart.currentModel, 'primary');
    assert.deepEqual(t._sent, []);                       // nothing typed yet but commands
    assert.equal(await tick(state, t), 'retried');       // the continue, AFTER the restore
    assert.deepEqual(t._sent, [DEFAULT_CONFIG.retryMessage]);
    assert.deepEqual(t._commands, [SC.models.primary.command, SC.effort.primary.command]);
  });

  it('primary unavailable during the detour pins the fallback and still sends the continue', async () => {
    const state = limitedFallbackState();
    const t = mockTmux([
      idleFrame(LIMIT_BANNER),                                       // detour
      idleFrame(LIMIT_BANNER),                                       // /model primary sent
      idleFrame(LIMIT_BANNER, '⚠ Fable 5 is currently unavailable'), // unavailable → pin
      idleFrame(LIMIT_BANNER),                                       // continue on fallback
    ]);
    assert.equal(await tick(state, t), 'smartcheck-back-before-retry');
    assert.equal(await tick(state, t), 'smartcheck-back-model-sent');
    assert.equal(await tick(state, t), 'smartcheck-primary-unavailable');
    assert.equal(state.smart.primaryUnavailable, true);
    assert.equal(state.status, 'waiting');
    assert.equal(await tick(state, t), 'retried');
    assert.deepEqual(t._sent, [DEFAULT_CONFIG.retryMessage]);
  });

  it('detour is skipped when pinned / unavailable / already primary — retry goes straight out', async () => {
    for (const mutate of [
      (s) => { s.smart.pinned = true; },
      (s) => { s.smart.primaryUnavailable = true; },
      (s) => { s.smart.currentModel = 'primary'; },
      (s) => { s.smart.lastFlagAt = Date.now(); },   // cooldown not elapsed
    ]) {
      const state = limitedFallbackState();
      mutate(state);
      const t = mockTmux([idleFrame(LIMIT_BANNER)]);
      assert.equal(await tick(state, t), 'retried');
      assert.deepEqual(t._commands, []);
    }
  });
});

// --- monitoring bookkeeping ---

describe('smartcheck monitoring bookkeeping', () => {
  it('counts clean turns on working→idle edges while on the fallback model', async () => {
    const state = createMonitorState();
    state.smart.currentModel = 'fallback';
    state.smart.lastFlagAt = Date.now(); // cooldown blocks switch-back during the test
    const t = mockTmux([
      workingFrame('turn 1'), idleFrame('turn 1 done'),
      workingFrame('turn 2'), idleFrame('turn 2 done'),
      idleFrame('still idle'),
    ]);
    await tick(state, t); await tick(state, t);
    assert.equal(state.smart.cleanTurns, 1);
    await tick(state, t); await tick(state, t);
    assert.equal(state.smart.cleanTurns, 2);
    await tick(state, t); // idle→idle: no edge
    assert.equal(state.smart.cleanTurns, 2);
  });

  it('a working→idle edge with the banner still live does not count', async () => {
    const state = createMonitorState();
    state.smart.currentModel = 'fallback';
    const m = downgradeMatch(idleFrame(BANNER_OPUS), SC.downgradePatterns, SC.downgradeAnchors);
    state.smart.lastHandledBanner = m.fingerprint;
    state.smart.lastFlagAt = Date.now();
    const t = mockTmux([workingFrame(BANNER_OPUS), idleFrame(BANNER_OPUS)]);
    await tick(state, t); await tick(state, t);
    assert.equal(state.smart.cleanTurns, 0);
  });

  it('resumes an interrupted fallback via pendingFallback (monitor restart)', async () => {
    const state = createMonitorState();
    state.smart.pendingFallback = true;   // rehydrated from the state file
    const t = mockTmux([idleFrame('rehydrated'), idleFrame('rehydrated')]);
    assert.equal(await tick(state, t), 'smartcheck-resumed-fallback');
    assert.equal(state.status, 'smartcheck');
    assert.equal(await tick(state, t), 'smartcheck-model-sent');
  });

  it('smart-check takes the combined render away from the legacy safeguard path', async () => {
    const state = createMonitorState();
    const combined = idleFrame(LEGACY_FLAG, BANNER_OPUS);
    const t = mockTmux([combined]);
    assert.equal(await tick(state, t), 'smartcheck-downgrade-detected-idle');
    assert.equal(state.status, 'smartcheck');
    assert.deepEqual(t._sent, []); // no "continue"
  });

  it('with smartCheck disabled, the legacy safeguard path still owns the API-Error render', async () => {
    const state = createMonitorState();
    const cfg = { ...DEFAULT_CONFIG, smartCheck: { ...DEFAULT_SMARTCHECK, enabled: false } };
    const t = mockTmux([idleFrame(LEGACY_FLAG)]);
    assert.equal(await processOneTick(state, t, '%1', cfg, () => true), 'safeguard-detected');
  });

  it('deferred primary failure (credits died after a verified switch) pins and re-promotes', async () => {
    const state = createMonitorState();
    state.smart.currentModel = 'primary';
    const t = mockTmux([idleFrame('⚠ You are out of Fable credits')]);
    assert.equal(await tick(state, t), 'smartcheck-primary-unavailable');
    assert.equal(state.smart.primaryUnavailable, true);
    assert.equal(state.status, 'smartcheck'); // re-promoting to fallback @ fallback effort
  });
});

// --- command application + durable fields ---

describe('applySmartCommand / durable fields', () => {
  it('stay aborts an in-flight switch-back and pins', () => {
    const state = createMonitorState();
    state.status = 'smartcheck';
    state.smart.phase = 'back-verify-model';
    assert.equal(applySmartCommand(state, 'stay'), 'smartcheck-cmd-stay');
    assert.equal(state.smart.pinned, true);
    assert.equal(state.status, 'monitoring');
  });
  it('off aborts any smartcheck phase', () => {
    const state = createMonitorState();
    state.status = 'smartcheck';
    state.smart.phase = 'verify-model';
    applySmartCommand(state, 'off');
    assert.equal(state.smart.enabled, false);
    assert.equal(state.status, 'monitoring');
  });
  it('durable fields round-trip through smartDurableFields/adoptSmartState', () => {
    const a = createMonitorState().smart;
    a.currentModel = 'fallback';
    a.cleanTurns = 2;
    a.halted = false;
    a.pinned = true;
    const b = createMonitorState().smart;
    adoptSmartState(b, smartDurableFields(a));
    assert.equal(b.currentModel, 'fallback');
    assert.equal(b.cleanTurns, 2);
    assert.equal(b.pinned, true);
    // in-memory phase machinery is NOT part of the durable set
    assert.equal(smartDurableFields(a).phase, undefined);
  });
});
