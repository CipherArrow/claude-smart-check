import { stripAnsi, isRateLimited, findRateLimitMessage, isRateLimitOptionsPrompt, menuStepsToWaitOption, detectOverload, overloadMatch, detectSafeguard, safeguardMatch, isWorking, downgradeMatch, confirmationCount, isInputEmpty, isPickerOpen, menuStepsToOption, liveTailText } from './patterns.js';
import { parseResetTime, calculateWaitMs } from './time-parser.js';
import { capturePane, sendKeys, sendKey, sendCommand, getPaneCommand, isProcessForeground } from './tmux.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { readStopFailureEvent, clearStopFailureEvent, isRetryableError } from './events.js';
import { writeStatus, clearStatus, sweepStaleStatus } from './status-file.js';
import { writeSmartState, readSmartState, clearSmartState, consumeSmartCommand, sweepStaleSmartState } from './smartcheck-state.js';

const DEFAULT_FOREGROUND_COMMANDS = ['node', 'claude', 'npx', 'tsx', 'bun', 'deno'];
const SHELL_COMMANDS = ['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'];
// Only a usage-limit banner in the live tail counts — quoted limit text in scrollback
// (a conversation about limits) or a banner the session already scrolled past is not the
// current state and must not drive a retry. Matches the overload path's tail discipline.
const RATE_LIMIT_TAIL_LINES = 12;

export function createMonitorState() {
  return {
    status: 'monitoring', waitUntil: 0, attempts: 0, lastRateLimitMessage: null,
    // Overload-retry sub-state, kept distinct from the usage-reset fields above.
    overloadAttempts: 0, overloadTotalWaitMs: 0, overloadWaitUntil: 0,
    // viaEvent marks the current backoff window as event-triggered (edge: one send per
    // failure). The scraper stays active alongside the event path — see the tick logic.
    viaEvent: false,
    // Safeguard/AUP false-positive retry sub-state (bounded, seconds-scale).
    safeguardAttempts: 0, safeguardWaitUntil: 0,
    // Smart-check model/effort recovery sub-state — see the smartcheck tick.
    smart: createSmartState(),
  };
}

export function createSmartState() {
  return {
    // In-memory phase machinery (rebuilt from scratch on monitor restart; the durable
    // fields below rehydrate it via smart.pendingFallback re-entry).
    phase: null, phaseDeadline: 0, phaseStartedAt: 0, preSendCount: 0, effortCycles: 0,
    escSends: 0, pickerTried: false, wasWorking: false,
    forceBack: false, pendingRephrase: false, fingerprint: null,
    // 'usage-retry' while the restore-before-continue detour is active: the usage-limit
    // wait expired with the session on the fallback model, so the primary is restored
    // FIRST and then control returns to the waiting branch to send the continue.
    afterBack: null,
    // Durable session fields, mirrored to the per-pane smartcheck state file so a
    // reconcile-replaced monitor keeps the session's model facts.
    currentModel: 'unknown',   // 'primary' | 'fallback' | 'below' | 'unknown'
    pinned: false,             // `smart-check stay`: never auto-restore the primary
    enabled: true,             // `smart-check on|off` (config smartCheck.enabled gates globally)
    primaryUnavailable: false, // primary model unusable (credits) — stay on fallback
    halted: false,             // switched below the fallback model — no automation at all
    lastFlagAt: 0, cleanTurns: 0, lastHandledBanner: null, pendingFallback: false,
  };
}

const SMART_DURABLE_FIELDS = ['currentModel', 'pinned', 'enabled', 'primaryUnavailable', 'halted', 'lastFlagAt', 'cleanTurns', 'lastHandledBanner', 'pendingFallback'];

export function smartDurableFields(smart) {
  const out = {};
  for (const k of SMART_DURABLE_FIELDS) out[k] = smart[k];
  return out;
}

export function adoptSmartState(smart, persisted) {
  if (!persisted || typeof persisted !== 'object') return;
  for (const k of SMART_DURABLE_FIELDS) {
    if (persisted[k] !== undefined) smart[k] = persisted[k];
  }
}

async function persistSmart(state, tmuxAdapter) {
  if (!tmuxAdapter.saveSmartState) return;
  try { await tmuxAdapter.saveSmartState(smartDurableFields(state.smart)); } catch { /* best-effort */ }
}

function safeTest(pattern, text) {
  if (!pattern || !text) return false;
  try { return new RegExp(pattern, 'i').test(text); } catch { return false; }
}

function setSmartPhase(smart, phase, deadlineMs, now = Date.now()) {
  smart.phase = phase;
  smart.phaseDeadline = deadlineMs > 0 ? now + deadlineMs : 0;
  smart.phaseStartedAt = now;   // the input-wait budget runs from phase entry
  smart.pickerTried = false;
}

// Apply a CLI control marker. Returns a result token for logging, or null.
export function applySmartCommand(state, cmd) {
  const smart = state.smart;
  const inBackPhase = state.status === 'smartcheck' && smart.phase && smart.phase.startsWith('back-');
  switch (cmd) {
    case 'stay':
      smart.pinned = true;
      smart.forceBack = false;
      if (inBackPhase) abortBackToStatus(state);
      return 'smartcheck-cmd-stay';
    case 'resume':
      smart.pinned = false;
      smart.primaryUnavailable = false;
      smart.halted = false;
      smart.pendingRephrase = false;
      if (smart.currentModel === 'below') smart.currentModel = 'unknown';
      return 'smartcheck-cmd-resume';
    case 'back':
      if (smart.halted) return 'smartcheck-cmd-back-refused';
      smart.primaryUnavailable = false;
      smart.forceBack = true;
      return 'smartcheck-cmd-back';
    case 'rephrase':
      if (!smart.halted) return 'smartcheck-cmd-rephrase-ignored';
      smart.pendingRephrase = true;
      return 'smartcheck-cmd-rephrase';
    case 'on':
      smart.enabled = true;
      return 'smartcheck-cmd-on';
    case 'off':
      smart.enabled = false;
      smart.forceBack = false;
      smart.pendingRephrase = false;
      if (state.status === 'smartcheck') abortBackToStatus(state);
      return 'smartcheck-cmd-off';
    default:
      return null;
  }
}

// --- Overload backoff schedule (pure, testable) ---
// Wait backoffSeconds[i] for attempt i; once the array is exhausted, steadyStateSeconds.
export function overloadBaseWaitMs(attemptIndex, overload) {
  const { backoffSeconds, steadyStateSeconds } = overload;
  const secs = attemptIndex < backoffSeconds.length ? backoffSeconds[attemptIndex] : steadyStateSeconds;
  return secs * 1000;
}

export function applyJitter(ms, jitterPct, rand = Math.random) {
  if (!jitterPct) return ms;
  const factor = 1 + (rand() * 2 - 1) * (jitterPct / 100);  // ±jitterPct%
  return Math.max(0, Math.round(ms * factor));
}

export function nextOverloadWaitMs(attemptIndex, overload, rand = Math.random) {
  return applyJitter(overloadBaseWaitMs(attemptIndex, overload), overload.jitterPct, rand);
}

function resetOverload(state) {
  state.overloadAttempts = 0;
  state.overloadTotalWaitMs = 0;
  state.overloadWaitUntil = 0;
  state.viaEvent = false;
  state._gaveUp = false;
  state._eventHandledBanner = null;
}

function resetSafeguard(state) {
  state.safeguardAttempts = 0;
  state.safeguardWaitUntil = 0;
  state._safeguardGaveUp = false;
  state._gaveUp = false;
}

// --- Smart-check entry/classification ---

// A downgrade banner names the model the harness switched TO; the configured fallback
// model gets the promote-effort treatment, anything else (or an unreadable name — fail
// safe) halts automation for a human decision.
function classifyDowngrade(m, sc) {
  if (m.switchedTo && safeTest(sc.models.fallback.name, m.switchedTo)) return 'fallback';
  return 'below';
}

function beginSmartFallback(state, m, working, sc, now = Date.now()) {
  const smart = state.smart;
  smart.afterBack = null;   // a fresh flag owns the pane; any pending resume detour is void
  smart.lastFlagAt = now;
  smart.cleanTurns = 0;
  smart.pendingFallback = true;
  smart.fingerprint = m ? m.fingerprint : `resumed-${now}`;
  smart.escSends = 0;
  smart.effortCycles = 0;
  state.status = 'smartcheck';
  setSmartPhase(smart, working ? 'interrupt' : 'set-model', sc.interruptTimeoutSeconds * 1000, now);
  return working ? 'smartcheck-downgrade-detected' : 'smartcheck-downgrade-detected-idle';
}

function beginSmartHalt(state, m, now = Date.now()) {
  const smart = state.smart;
  smart.afterBack = null;
  smart.halted = true;
  smart.currentModel = 'below';
  smart.lastFlagAt = now;
  smart.lastHandledBanner = m.fingerprint;
  smart.pendingFallback = false;
  smart.phase = null;
  state.status = 'monitoring';
  state._smartHaltBanner = m.line;
  return 'smartcheck-halted';
}

// Shared by the monitoring branch and the safeguard/back-phase handoffs.
function handleSmartDowngrade(state, m, sc, working, now = Date.now()) {
  if (classifyDowngrade(m, sc) === 'fallback') return beginSmartFallback(state, m, working, sc, now);
  if (sc.haltBelowFallback) return beginSmartHalt(state, m, now);
  // Halt disabled by config: acknowledge the banner, do nothing.
  state.smart.lastHandledBanner = m.fingerprint;
  return 'smartcheck-downgrade-ignored';
}

// Give up on the current phase sequence: mark the banner handled (so the persistent
// render can't re-trigger next tick), log loudly, resume plain monitoring.
function smartGiveUp(state, reason) {
  const smart = state.smart;
  smart.lastHandledBanner = smart.fingerprint || smart.lastHandledBanner;
  smart.pendingFallback = false;
  smart.phase = null;
  state.status = 'monitoring';
  state._smartGiveUpReason = reason;
  return 'smartcheck-gave-up';
}

// The nudge is done (or skipped): the pane is on the fallback model at the fallback
// effort; start counting clean turns toward the switch-back.
function completeSmartFallback(state, result) {
  const smart = state.smart;
  smart.currentModel = 'fallback';
  smart.lastHandledBanner = smart.fingerprint || smart.lastHandledBanner;
  smart.pendingFallback = false;
  smart.cleanTurns = 0;
  smart.wasWorking = false;
  smart.phase = null;
  state.status = 'monitoring';
  return result;
}

function completeSmartBack(state) {
  const smart = state.smart;
  smart.currentModel = 'primary';
  smart.cleanTurns = 0;
  smart.pendingFallback = false;
  smart.phase = null;
  if (smart.afterBack === 'usage-retry') {
    // Restore-before-continue detour: hand control straight back to the waiting branch
    // so the very next tick sends the usage retry — now on the primary model + effort.
    smart.afterBack = null;
    state.status = 'waiting';
    state.waitUntil = Date.now();
    return 'smartcheck-back-complete-resume';
  }
  state.status = 'monitoring';
  return 'smartcheck-back-complete';
}

// A back-phase failure/abort while the usage-retry detour is active must NOT strand the
// pane: the continue still has to go out, just on the fallback model. Reroute to the
// waiting branch for an immediate retry instead of plain monitoring.
function abortBackToStatus(state) {
  const smart = state.smart;
  smart.phase = null;
  if (smart.afterBack === 'usage-retry') {
    smart.afterBack = null;
    state.status = 'waiting';
    state.waitUntil = Date.now();
    return true;
  }
  state.status = 'monitoring';
  return false;
}

// Foreground safety: is claude/node the foreground process (safe to send-keys), or did
// it exit to a shell / is some other app focused? Returns { ok, fg, isShell }.
async function checkForeground(tmuxAdapter, pane, config) {
  const isFg = await tmuxAdapter.isClaudeForeground();
  if (isFg === true) return { ok: true, fg: null, isShell: false };
  const fg = await tmuxAdapter.getPaneCommand(pane);
  const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
  if (fgCommands.some(c => fg.toLowerCase().includes(c))) return { ok: true, fg, isShell: false };
  const lc = (fg || '').toLowerCase();
  const isShell = lc !== '' && SHELL_COMMANDS.some(s => lc === s || lc.includes(s));
  return { ok: false, fg, isShell };
}

function enterUsageWait(state, stripped, config) {
  const message = findRateLimitMessage(stripped, config.customPatterns);
  state.lastRateLimitMessage = message;
  const parsed = message ? parseResetTime(message) : null;
  state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
  state.status = 'waiting';
  state._gaveUp = false;
  return 'waiting';
}

function enterOverload(state, overload, rand) {
  const capMs = overload.maxTotalWaitMinutes * 60_000;
  resetOverload(state);
  state.status = 'overload';
  const w = nextOverloadWaitMs(0, overload, rand);
  if (w > capMs) {
    // Degenerate config (first backoff already exceeds the cap): force the cap to
    // trip on the next tick rather than entering a real retry loop.
    state.overloadTotalWaitMs = capMs;
    state.overloadWaitUntil = 0;
    return 'overload-detected';
  }
  state.overloadTotalWaitMs = w;
  state.overloadWaitUntil = Date.now() + w;
  return 'overload-detected';
}

// --- Smart-check phase tick (state.status === 'smartcheck') ---
// Verified, sequential recovery: every send is confirmed from the pane render before the
// next one fires, every phase has a deadline, and every failure path is a loud no-op
// (give up / abort / pin) rather than blind keystrokes.
async function smartcheckTick(state, tmuxAdapter, pane, config, stripped) {
  const sc = config.smartCheck;
  const smart = state.smart;
  const now = Date.now();
  const working = isWorking(stripped);
  const isBack = !!(smart.phase && smart.phase.startsWith('back-'));

  // Usage limit takes precedence: hand off to the hours-scale wait. pendingFallback
  // survives, so the promote sequence re-enters once monitoring resumes. EXCEPT during
  // the restore-before-continue detour — there the limit banner is exactly why we're
  // here (the wait just expired), and re-entering the wait would recompute a stale
  // reset time and strand the pane.
  if (!smart.afterBack && isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
    smart.phase = null;
    return enterUsageWait(state, stripped, config);
  }

  // A fresh flag banner while switching back: the new flag owns the pane — reclassify
  // (typically: back onto the fallback path, or a below-fallback halt).
  if (isBack) {
    const m = downgradeMatch(stripped, sc.downgradePatterns, sc.downgradeAnchors, { requireBullet: sc.downgradeRequireBullet });
    if (m && m.fingerprint !== smart.lastHandledBanner) {
      const res = handleSmartDowngrade(state, m, sc, working, now);
      await persistSmart(state, tmuxAdapter);
      return res;
    }
  }

  switch (smart.phase) {
    case 'interrupt': {
      // The flagged turn is still streaming on the substitute model at the WRONG effort —
      // stop it before switching. Escape is only ever sent while the working footer is
      // visible (a single Escape at an idle prompt is harmless, but a second one opens
      // the history-rewind UI — so never send into an idle pane).
      if (!working) { setSmartPhase(smart, 'set-model', sc.interruptTimeoutSeconds * 1000, now); return 'smartcheck-interrupted'; }
      if (smart.phaseDeadline && now > smart.phaseDeadline) {
        const r = smartGiveUp(state, 'interrupt-timeout');
        await persistSmart(state, tmuxAdapter);
        return r;
      }
      const fg = await checkForeground(tmuxAdapter, pane, config);
      if (!fg.ok) { state._lastForeground = fg.fg; return 'skipped-not-claude'; }
      if (smart.escSends < 3) {
        smart.escSends++;
        await tmuxAdapter.sendKey(pane, 'Escape');
        return 'smartcheck-escape-sent';
      }
      return 'smartcheck-interrupt-waiting';
    }

    case 'set-model':
    case 'back-model': {
      if (working) {
        // Switch-back: the pane is active again (the user, or a resumed turn) — step
        // aside quietly; a detour's continue is unnecessary if work already resumed.
        // Fallback: the flagged turn is running again on the wrong effort — go stop it.
        if (isBack) { smart.afterBack = null; smart.phase = null; state.status = 'monitoring'; return 'smartcheck-back-aborted'; }
        smart.escSends = 0;
        setSmartPhase(smart, 'interrupt', sc.interruptTimeoutSeconds * 1000, now);
        return 'smartcheck-reinterrupt';
      }
      if (!isInputEmpty(stripped)) {
        // Typed text means the user is present and mid-thought — wait it out on the
        // generous input budget rather than the phase deadline.
        if (now - smart.phaseStartedAt > sc.inputWaitTimeoutSeconds * 1000) {
          if (isBack) { smart.afterBack = null; smart.phase = null; state.status = 'monitoring'; return 'smartcheck-back-aborted'; }
          const r = smartGiveUp(state, 'input-not-empty');
          await persistSmart(state, tmuxAdapter);
          return r;
        }
        return 'smartcheck-waiting-input';
      }
      const fg = await checkForeground(tmuxAdapter, pane, config);
      if (!fg.ok) { state._lastForeground = fg.fg; return 'skipped-not-claude'; }
      const spec = isBack ? sc.models.primary : sc.models.fallback;
      smart.preSendCount = confirmationCount(stripped, spec.confirm);
      await tmuxAdapter.sendCommand(pane, spec.command, sc.commandSettleMs);
      setSmartPhase(smart, isBack ? 'back-verify-model' : 'verify-model', sc.verifyTimeoutSeconds * 1000, now);
      return isBack ? 'smartcheck-back-model-sent' : 'smartcheck-model-sent';
    }

    case 'verify-model':
    case 'back-verify-model': {
      const spec = isBack ? sc.models.primary : sc.models.fallback;
      if (confirmationCount(stripped, spec.confirm) > smart.preSendCount) {
        setSmartPhase(smart, isBack ? 'back-effort' : 'set-effort', sc.interruptTimeoutSeconds * 1000, now);
        return isBack ? 'smartcheck-back-model-verified' : 'smartcheck-model-verified';
      }
      // Switch-back only: an explicit "primary unusable" render (credits exhausted,
      // model unavailable) pins the session to the fallback immediately. During the
      // restore-before-continue detour the pending usage retry still goes out — on the
      // fallback model (never a lockout).
      if (isBack && sc.primaryUnavailablePatterns.some((p) => safeTest(p, liveTailText(stripped)))) {
        smart.primaryUnavailable = true;
        smart.forceBack = false;
        abortBackToStatus(state);
        await persistSmart(state, tmuxAdapter);
        return 'smartcheck-primary-unavailable';
      }
      if (working) {
        if (isBack) { smart.afterBack = null; smart.phase = null; state.status = 'monitoring'; return 'smartcheck-back-aborted'; }
        smart.phaseDeadline = now + sc.verifyTimeoutSeconds * 1000;
        return 'smartcheck-waiting-idle';
      }
      if (now <= smart.phaseDeadline) return 'smartcheck-verifying';
      // Deadline passed with no confirmation. Maybe the command opened its picker.
      if (isPickerOpen(stripped) && !smart.pickerTried) {
        const steps = menuStepsToOption(stripped, spec.pickerOption);
        if (steps !== null) {
          const fgp = await checkForeground(tmuxAdapter, pane, config);
          if (!fgp.ok) { state._lastForeground = fgp.fg; return 'skipped-not-claude'; }
          const key = steps >= 0 ? 'Down' : 'Up';
          for (let i = 0; i < Math.abs(steps); i++) {
            await tmuxAdapter.sendKey(pane, key);
            await new Promise((r) => setTimeout(r, 80));
          }
          await tmuxAdapter.sendKey(pane, 'Enter');
          smart.pickerTried = true;
          smart.phaseDeadline = now + sc.verifyTimeoutSeconds * 1000;
          return 'smartcheck-picker-driven';
        }
        // Unreadable picker layout: close the modal rather than leave it up, then fail.
        await tmuxAdapter.sendKey(pane, 'Escape');
      }
      if (isBack) {
        smart.primaryUnavailable = true;
        smart.forceBack = false;
        abortBackToStatus(state);
        await persistSmart(state, tmuxAdapter);
        return 'smartcheck-primary-unavailable';
      }
      const r = smartGiveUp(state, 'model-verify-timeout');
      await persistSmart(state, tmuxAdapter);
      return r;
    }

    case 'set-effort':
    case 'back-effort': {
      if (working) {
        // Effort changes are quick; a working pane here means the user (or the model
        // switch's own render churn) got a turn going — wait it out, don't interrupt.
        smart.phaseDeadline = now + sc.interruptTimeoutSeconds * 1000;
        return 'smartcheck-waiting-idle';
      }
      if (!isInputEmpty(stripped)) {
        if (now - smart.phaseStartedAt > sc.inputWaitTimeoutSeconds * 1000) {
          if (isBack) { const res = completeSmartBack(state); await persistSmart(state, tmuxAdapter); return res; }
          setSmartPhase(smart, 'nudge', sc.interruptTimeoutSeconds * 1000, now);
          return 'smartcheck-effort-skipped';
        }
        return 'smartcheck-waiting-input';
      }
      const fg = await checkForeground(tmuxAdapter, pane, config);
      if (!fg.ok) { state._lastForeground = fg.fg; return 'skipped-not-claude'; }
      const spec = isBack ? sc.effort.primary : sc.effort.fallback;
      smart.preSendCount = confirmationCount(stripped, spec.confirm);
      await tmuxAdapter.sendCommand(pane, spec.command, sc.commandSettleMs);
      setSmartPhase(smart, isBack ? 'back-verify-effort' : 'verify-effort', sc.verifyTimeoutSeconds * 1000, now);
      return isBack ? 'smartcheck-back-effort-sent' : 'smartcheck-effort-sent';
    }

    case 'verify-effort':
    case 'back-verify-effort': {
      const spec = isBack ? sc.effort.primary : sc.effort.fallback;
      if (confirmationCount(stripped, spec.confirm) > smart.preSendCount) {
        if (isBack) { const res = completeSmartBack(state); await persistSmart(state, tmuxAdapter); return res; }
        setSmartPhase(smart, 'nudge', sc.interruptTimeoutSeconds * 1000, now);
        return 'smartcheck-effort-verified';
      }
      if (working) {
        smart.phaseDeadline = now + sc.verifyTimeoutSeconds * 1000;
        return 'smartcheck-waiting-idle';
      }
      if (now <= smart.phaseDeadline) return 'smartcheck-verifying';
      // Maybe /effort opened a selector — drive it to the target option.
      if (isPickerOpen(stripped) && !smart.pickerTried) {
        const steps = menuStepsToOption(stripped, spec.pickerOption);
        if (steps !== null) {
          const fgp = await checkForeground(tmuxAdapter, pane, config);
          if (!fgp.ok) { state._lastForeground = fgp.fg; return 'skipped-not-claude'; }
          const key = steps >= 0 ? 'Down' : 'Up';
          for (let i = 0; i < Math.abs(steps); i++) {
            await tmuxAdapter.sendKey(pane, key);
            await new Promise((r) => setTimeout(r, 80));
          }
          await tmuxAdapter.sendKey(pane, 'Enter');
          smart.pickerTried = true;
          smart.phaseDeadline = now + sc.verifyTimeoutSeconds * 1000;
          return 'smartcheck-picker-driven';
        }
        await tmuxAdapter.sendKey(pane, 'Escape');
      }
      // Maybe `/effort <level>` ignores its argument and bare /effort cycles levels:
      // keep cycling (bounded to a full wrap) until the target confirmation appears.
      if (smart.effortCycles < sc.effort.maxCycles) {
        const fgc = await checkForeground(tmuxAdapter, pane, config);
        if (!fgc.ok) { state._lastForeground = fgc.fg; return 'skipped-not-claude'; }
        smart.effortCycles++;
        smart.pickerTried = false;
        await tmuxAdapter.sendCommand(pane, '/effort', sc.commandSettleMs);
        smart.phaseDeadline = now + 10_000;
        return 'smartcheck-effort-cycled';
      }
      // Effort couldn't be verified — the model switch (the important half) stands, so
      // proceed with a loud warning instead of blocking recovery on the effort level.
      if (isBack) { completeSmartBack(state); await persistSmart(state, tmuxAdapter); return 'smartcheck-back-effort-mismatch'; }
      setSmartPhase(smart, 'nudge', sc.interruptTimeoutSeconds * 1000, now);
      return 'smartcheck-effort-mismatch';
    }

    case 'nudge': {
      // Model + effort are set. Resume the flagged work — unless something already did.
      if (working) {
        const res = completeSmartFallback(state, 'smartcheck-fallback-complete-nonudge');
        await persistSmart(state, tmuxAdapter);
        return res;
      }
      if (!isInputEmpty(stripped)) {
        if (now - smart.phaseStartedAt > sc.inputWaitTimeoutSeconds * 1000) {
          const res = completeSmartFallback(state, 'smartcheck-fallback-complete-nonudge');
          await persistSmart(state, tmuxAdapter);
          return res;
        }
        return 'smartcheck-waiting-input';
      }
      const fg = await checkForeground(tmuxAdapter, pane, config);
      if (!fg.ok) { state._lastForeground = fg.fg; return 'skipped-not-claude'; }
      await tmuxAdapter.sendKeys(pane, sc.nudgeMessage);
      const res = completeSmartFallback(state, 'smartcheck-fallback-complete');
      await persistSmart(state, tmuxAdapter);
      return res;
    }

    default: {
      // Unknown/cleared phase — never wedge the monitor in the smartcheck status.
      smart.phase = null;
      state.status = 'monitoring';
      return 'monitoring';
    }
  }
}

export async function processOneTick(state, tmuxAdapter, pane, config, isAlive, rand = Math.random) {
  if (!isAlive()) return 'exit';

  // Capture generously (was 20, then 50): a live banner can sit far above the bottom behind
  // a tall task widget + input box + footer — ~90 lines in the wild (#38). The detectors
  // chrome-strip and tail-window this, so extra lines are free headroom, and the capture
  // itself bounds how far back the rate-limit scan can reach (a stale banner deeper in
  // scrollback stays out); 120 clears a large widget with margin.
  const raw = await tmuxAdapter.capturePane(pane, 120);
  const stripped = stripAnsi(raw);
  const overload = config.overload;
  const sc = config.smartCheck;

  // Smart-check CLI control markers (stay/resume/back/rephrase/on/off) apply in ANY
  // status — they only mutate smart-check's own fields (and can abort its phases), so
  // consuming them here can't disturb the other branches. Logged via _smartCmdApplied.
  state._smartCmdApplied = null;
  if (sc && sc.enabled && tmuxAdapter.readSmartCommand) {
    const cmd = await tmuxAdapter.readSmartCommand();
    if (cmd) {
      state._smartCmdApplied = applySmartCommand(state, cmd);
      await persistSmart(state, tmuxAdapter);
    }
  }

  // Below-fallback halt: EVERYTHING stops — no retries, no menu driving, no nudges —
  // until `smart-check resume` (automation back on, model unknown) or `smart-check
  // rephrase` (queued below). The user decides; the monitor only watches.
  if (sc && sc.enabled && state.smart.enabled && state.smart.halted) {
    if (state.smart.pendingRephrase && !isWorking(stripped) && isInputEmpty(stripped)) {
      const fg = await checkForeground(tmuxAdapter, pane, config);
      if (!fg.ok) { state._lastForeground = fg.fg; return 'skipped-not-claude'; }
      await tmuxAdapter.sendKeys(pane, sc.rephraseMessage);
      state.smart.pendingRephrase = false;
      state.smart.halted = false;   // automation resumes; model stays 'below' until reclassified
      await persistSmart(state, tmuxAdapter);
      return 'smartcheck-rephrased';
    }
    return 'smartcheck-halted-idle';
  }

  // Handle the interactive /rate-limit-options menu before any other logic. A bare
  // Enter here confirms the highlighted default, which on some Claude Code versions
  // is "Upgrade your plan". Navigate to "Stop and wait for limit to reset" wherever
  // it sits, confirm it, then enter the normal (hours-scale) wait state.
  if (tmuxAdapter.sendKey && isRateLimitOptionsPrompt(stripped, RATE_LIMIT_TAIL_LINES)
      && Date.now() >= (state._menuCooldownUntil || 0)) {
    const cooldown = config.pollIntervalSeconds * 1000 * 2;

    // Foreground safety: never send arrow/Enter keys unless Claude/node is the
    // foreground process. Otherwise, if the user switched the pane to another app
    // while the menu was up, we'd drive that app's UI instead.
    const fgOk = await checkForeground(tmuxAdapter, pane, config);
    if (!fgOk.ok) {
      state._lastForeground = fgOk.fg;
      state._menuCooldownUntil = Date.now() + cooldown;
      return 'skipped-not-claude';
    }

    const steps = menuStepsToWaitOption(stripped, RATE_LIMIT_TAIL_LINES);
    if (steps === null) {
      // Layout unreadable — refuse to press Enter (could confirm "Upgrade").
      state._menuCooldownUntil = Date.now() + cooldown;
      return 'menu-unreadable';
    }
    const key = steps >= 0 ? 'Down' : 'Up';
    for (let i = 0; i < Math.abs(steps); i++) {
      await tmuxAdapter.sendKey(pane, key);
      await new Promise(r => setTimeout(r, 80));
    }
    await tmuxAdapter.sendKey(pane, 'Enter');
    // Parse the reset time straight from the menu text, so the wait does not depend
    // on the limit banner still being visible afterward.
    const message = findRateLimitMessage(stripped, config.customPatterns);
    state.lastRateLimitMessage = message;
    const parsed = message ? parseResetTime(message) : null;
    state.waitUntil = Date.now() + calculateWaitMs(parsed, config.marginSeconds, config.fallbackWaitHours);
    state.status = 'waiting';
    state._menuCooldownUntil = Date.now() + cooldown;
    return 'menu-confirmed';
  }

  if (state.status === 'waiting') {
    // Keep counting down UNLESS the session has resumed working. A working pane means
    // the user manually continued (often to unstick a wrong/stale wait) — falling through
    // to the isWorking gate below returns us to monitoring, so a SECOND, genuine limit that
    // follows is detected instead of being masked until the old timer expires (issue #39).
    if (Date.now() < state.waitUntil && !isWorking(stripped)) return 'waiting';
    if (!isAlive()) return 'exit';

    // Stop driving the session if the limit cleared OR Claude has already resumed and
    // is working again. Without the isWorking gate the usage path re-sends the retry
    // message every poll (up to maxRetries) while the limit banner lingers in the
    // captured scrollback after a successful resume — spamming an actively-working
    // session (and a banner re-printed by another process keeps it "rate-limited" the
    // whole time). isWorking ⇒ the session continued; never inject into it.
    if (!isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES) || isWorking(stripped)) {
      state.status = 'monitoring'; state.attempts = 0; state._gaveUp = false;
      return 'user-continued';
    }

    if (state.attempts >= config.maxRetries) {
      // Stay in 'waiting' to avoid re-detecting the stale rate limit on the next tick
      // and creating an infinite max-retries loop. This IS a give-up (no further
      // retries will be sent while the banner persists) even though `status` stays
      // 'waiting' — flagged so external consumers (tmux status bar) don't render a
      // perpetually-resetting countdown for a monitor that has stopped acting.
      state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      state._gaveUp = true;
      return 'max-retries';
    }

    // Restore-before-continue: the wait expired with the session still on the fallback
    // model — put the primary model + effort back FIRST (verified, via the smartcheck
    // back phases) so the "continue" resumes in the pre-limit state. cleanTurns is
    // deliberately waived here (no turns can complete during an hours-scale wait); the
    // flag cooldown still applies. /model and /effort are handled locally by Claude
    // Code, so they work fine while the API is still limited. If the primary turns out
    // to be unavailable, the detour pins the fallback and the retry goes out anyway.
    {
      const scw = config.smartCheck;
      const sw = state.smart;
      if (scw && scw.enabled && sw.enabled && sw.currentModel === 'fallback'
          && !sw.pinned && !sw.primaryUnavailable && !sw.halted && !sw.afterBack
          && Date.now() - sw.lastFlagAt >= scw.switchBackCooldownMinutes * 60_000) {
        sw.afterBack = 'usage-retry';
        state.status = 'smartcheck';
        setSmartPhase(sw, 'back-model', scw.interruptTimeoutSeconds * 1000);
        return 'smartcheck-back-before-retry';
      }
    }

    // Primary check: is the Claude process in the foreground process group?
    // On macOS, pane_current_command reports "zsh" instead of the child process,
    // so we use `ps -o stat=` to check the '+' (foreground) flag directly.
    // `true` short-circuits past pane_current_command (fixes macOS).
    // `false`/`null` falls back to pane_current_command for safety.
    const isFg = await tmuxAdapter.isClaudeForeground();
    if (isFg !== true) {
      const fg = await tmuxAdapter.getPaneCommand(pane);
      const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
      if (!fgCommands.some(c => fg.toLowerCase().includes(c))) {
        state.waitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
        state._lastForeground = fg;
        return 'skipped-not-claude';
      }
    }

    // Increment attempts and set cooldown BEFORE sendKeys so that a failure
    // (e.g. pane destroyed) still consumes a retry and avoids tight-loop errors.
    state.attempts++;
    state.waitUntil = Date.now() + 30_000;
    await tmuxAdapter.sendKeys(pane, config.retryMessage);
    return 'retried';
  }

  if (state.status === 'overload') {
    if (Date.now() < state.overloadWaitUntil) return 'overload-waiting';
    if (!isAlive()) return 'exit';

    // Event-triggered window: a StopFailure marker put us here. Edge-triggered — send
    // exactly once per failure, then return to monitoring to await the next marker. We
    // do NOT re-check the scraper for "still overloaded" (the marker was authoritative).
    if (state.viaEvent) {
      // Self-recovery: Claude resumed during the backoff → don't interrupt it.
      if (isWorking(stripped)) { resetOverload(state); state.status = 'monitoring'; return 'overload-cleared'; }
      // A usage limit appearing mid-wait still takes precedence.
      if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) { resetOverload(state); return enterUsageWait(state, stripped, config); }

      const foregroundOk = await checkForeground(tmuxAdapter, pane, config);
      if (!foregroundOk.ok) {
        state._lastForeground = foregroundOk.fg;
        state.viaEvent = false; state.status = 'monitoring';
        if (foregroundOk.isShell && overload.relaunchOnExit) {
          state.overloadAttempts++;
          await tmuxAdapter.sendKeys(pane, overload.relaunchCommand);
          return 'overload-relaunched';
        }
        return foregroundOk.isShell ? 'overload-exited-to-shell' : 'skipped-not-claude';
      }

      state.overloadAttempts++;          // next failure backs off further
      state.viaEvent = false;
      state.status = 'monitoring';
      // Remember the banner we just retried via the event path so the always-on scraper
      // doesn't re-detect this same, uncleared render next tick and open a second backoff.
      const handled = overloadMatch(stripped, overload.patterns);
      state._eventHandledBanner = handled ? `${handled.pattern} ${handled.line}` : null;
      await tmuxAdapter.sendKeys(pane, overload.retryMessage);
      return 'overload-retried';
    }

    const capMs = overload.maxTotalWaitMinutes * 60_000;

    // Usage-limit takes precedence: hand off to the (hours-scale) reset path.
    if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
      resetOverload(state);
      return enterUsageWait(state, stripped, config);
    }

    // Overload text gone → recovered. Back to plain monitoring.
    if (!detectOverload(stripped, overload.patterns)) {
      state.status = 'monitoring';
      resetOverload(state);
      return 'overload-cleared';
    }

    // Terminal-state gate: if Claude is actively working (its own internal retry
    // or a fresh response is streaming), the error is NOT terminal. Defer without
    // consuming an attempt so we never double-drive a live session.
    if (isWorking(stripped)) {
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 2);
      return 'overload-working';
    }

    // Mandatory cap: give up loudly rather than hammer a genuinely-down endpoint
    // or mask a real outage. Long cooldown to avoid re-detecting the stale error.
    if (state.overloadTotalWaitMs >= capMs) {
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      state._gaveUp = true;
      return 'overload-gave-up';
    }

    // Foreground safety, reused from the usage path: only act when claude/node is
    // the foreground process. (See the gating decision in the README.)
    const isFg = await tmuxAdapter.isClaudeForeground();
    let foregroundOk = isFg === true;
    let fg = null;
    if (!foregroundOk) {
      fg = await tmuxAdapter.getPaneCommand(pane);
      const fgCommands = config.foregroundCommands || DEFAULT_FOREGROUND_COMMANDS;
      foregroundOk = fgCommands.some(c => fg.toLowerCase().includes(c));
    }

    if (!foregroundOk) {
      // Distinguish "claude exited to the shell" (error visible above a shell
      // prompt) from "some other foreground app", for diagnostics + opt-in relaunch.
      const lc = (fg || '').toLowerCase();
      const isShell = lc !== '' && SHELL_COMMANDS.some(s => lc === s || lc.includes(s));
      state._lastForeground = fg;
      if (isShell && overload.relaunchOnExit) {
        state.overloadAttempts++;
        const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
        state.overloadTotalWaitMs += w;
        state.overloadWaitUntil = Date.now() + w;
        await tmuxAdapter.sendKeys(pane, overload.relaunchCommand);
        return 'overload-relaunched';
      }
      state.overloadWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      return isShell ? 'overload-exited-to-shell' : 'skipped-not-claude';
    }

    // Alive at the prompt → send the retry, then schedule the next backoff window.
    // Increment + schedule BEFORE sendKeys so a send failure still consumes the slot.
    state.overloadAttempts++;
    const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
    state.overloadTotalWaitMs += w;
    state.overloadWaitUntil = Date.now() + w;
    await tmuxAdapter.sendKeys(pane, overload.retryMessage);
    return 'overload-retried';
  }

  if (state.status === 'safeguard') {
    if (Date.now() < state.safeguardWaitUntil) return 'safeguard-waiting';
    if (!isAlive()) return 'exit';
    const safeguard = config.safeguard;

    // Handoff: if the flag render turns out to be (or becomes) the model-switch banner,
    // smart-check owns it — re-sending "continue" here would submit the flagged turn on
    // the downgraded model at the wrong effort. Mirrors the monitoring-branch gate.
    if (sc && sc.enabled && state.smart.enabled && !state.smart.halted) {
      const dg = downgradeMatch(stripped, sc.downgradePatterns, sc.downgradeAnchors, { requireBullet: sc.downgradeRequireBullet });
      if (dg && dg.fingerprint !== state.smart.lastHandledBanner) {
        resetSafeguard(state);
        const res = handleSmartDowngrade(state, dg, sc, isWorking(stripped));
        await persistSmart(state, tmuxAdapter);
        return res;
      }
    }

    // A usage limit or Claude resuming takes precedence / means recovery.
    if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
      resetSafeguard(state); return enterUsageWait(state, stripped, config);
    }
    // In flight (our retry, or the user typing continued things). Defer WITHOUT consuming
    // or resetting — a tick landing mid-retry must not zero the counter, or a sticky flag
    // re-enters with a fresh budget and the maxRetries bound never trips (verified: it
    // retried indefinitely). Mirrors the overload branch. Recovery is decided at the next
    // idle tick: flag gone -> cleared; flag still there -> the count stands.
    if (isWorking(stripped)) {
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 2);
      return 'safeguard-working';
    }

    // Flag gone → recovered.
    if (!detectSafeguard(stripped, safeguard.patterns)) {
      resetSafeguard(state); state.status = 'monitoring'; return 'safeguard-cleared';
    }

    // Sticky flag: give up loudly rather than loop. Long cooldown so we don't re-detect
    // the stale error every tick.
    if (state.safeguardAttempts >= safeguard.maxRetries) {
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 12);
      state._gaveUp = true;
      // Give up LOUDLY — once. Subsequent holds are silent or the warn re-logs ~1/min
      // for as long as the sticky banner sits at the prompt.
      if (state._safeguardGaveUp) return 'safeguard-holding';
      state._safeguardGaveUp = true;
      return 'safeguard-gave-up';
    }

    // Foreground safety: only send when claude/node is foreground.
    const fg = await checkForeground(tmuxAdapter, pane, config);
    if (!fg.ok) {
      state._lastForeground = fg.fg;
      state.safeguardWaitUntil = Date.now() + (config.pollIntervalSeconds * 1000 * 6);
      return 'skipped-not-claude';
    }

    // Increment + schedule BEFORE send so a send failure still consumes the slot.
    state.safeguardAttempts++;
    state.safeguardWaitUntil = Date.now() + (safeguard.retryDelaySeconds * 1000);
    await tmuxAdapter.sendKeys(pane, safeguard.retryMessage);
    return 'safeguard-retried';
  }

  if (state.status === 'smartcheck') {
    return smartcheckTick(state, tmuxAdapter, pane, config, stripped);
  }

  // --- monitoring ---
  // Usage-limit (hours-scale reset) takes precedence over overload (seconds-scale). No
  // !isWorking gate here: it would widen every WORKING_PATTERN from "skip one injection" to
  // "never detect the limit at all", and those patterns are NOT all live-only — `Retrying
  // in …`/`attempt N/M` match transcript text (a flaky deploy/test log), so a stuck session
  // with such a line lingering would never be retried. The waiting branch's `|| isWorking`
  // guard already stops injection into a working session, which is enough to prevent the
  // background-agent spam; the cost of dropping the gate is only a cosmetic re-detection
  // cycle (detect → wait → user-continued) that never actually injects.
  if (isRateLimited(stripped, config.customPatterns, RATE_LIMIT_TAIL_LINES)) {
    return enterUsageWait(state, stripped, config);
  }

  // --- Smart-check detection & bookkeeping (see smartcheckTick for the phases) ---
  const smart = state.smart;
  const workingNow = isWorking(stripped);
  const smartBanner = sc && sc.enabled
    ? downgradeMatch(stripped, sc.downgradePatterns, sc.downgradeAnchors, { requireBullet: sc.downgradeRequireBullet })
    : null;
  const smartActive = sc && sc.enabled && smart.enabled;
  if (smartActive) {
    // Banner left the capture entirely → a future identical render is a fresh incident
    // (mirrors _eventHandledBanner).
    if (!smartBanner && smart.lastHandledBanner) {
      smart.lastHandledBanner = null;
      await persistSmart(state, tmuxAdapter);
    }

    // A fresh downgrade banner: classify (fallback promote vs below-fallback halt).
    // Deliberately NOT isWorking-gated — the banner lands exactly when the substitute
    // model may still be streaming; working just selects the interrupt entry phase.
    if (smartBanner && smartBanner.fingerprint !== smart.lastHandledBanner) {
      const res = handleSmartDowngrade(state, smartBanner, sc, workingNow);
      await persistSmart(state, tmuxAdapter);
      return res;
    }

    // Clean-turn bookkeeping: a working→idle edge with no live banner at the idle tick.
    if (smart.currentModel === 'fallback' && smart.wasWorking && !workingNow && !smartBanner) {
      smart.cleanTurns++;
      await persistSmart(state, tmuxAdapter);
    }

    // Monitor restarted (reconcile replacement) or got diverted mid-fallback: resume
    // the promote sequence — every step is idempotent.
    if (smart.pendingFallback) {
      smart.wasWorking = workingNow;
      beginSmartFallback(state, smartBanner, workingNow, sc);
      await persistSmart(state, tmuxAdapter);
      return 'smartcheck-resumed-fallback';
    }

    // Deferred primary failure: nominally back on the primary model but the pane shows a
    // primary-unusable render (credits ran out after a verified switch). Pin + re-promote
    // so the session stays usable on the fallback.
    if (smart.currentModel === 'primary' && !workingNow
        && sc.primaryUnavailablePatterns.some((p) => safeTest(p, liveTailText(stripped)))) {
      smart.primaryUnavailable = true;
      beginSmartFallback(state, null, false, sc);
      await persistSmart(state, tmuxAdapter);
      return 'smartcheck-primary-unavailable';
    }
  }
  smart.wasWorking = workingNow;

  // Event-driven overload (authoritative and faster; see DESIGN-NOTES §1). A StopFailure
  // marker for this pane means the turn ended in a retryable API error — no scraping, no
  // ambiguity. It runs first, but does NOT replace the scraper below: the event path only
  // covers overloaded/server_error, so a transient render the hook can't emit (an API 429,
  // "temporarily limiting requests") is still caught by the scraper.
  if (overload && overload.enabled && tmuxAdapter.readEvent) {
    const ev = await tmuxAdapter.readEvent();
    if (ev) {
      // Consume-side guard: trust no writer. The hook entry in settings.json freezes the
      // cli.js path + matcher at install time, so an OLDER hook binary (whose matcher and
      // RETRYABLE set still include rate_limit) can keep writing markers after an upgrade.
      // Consume-and-ignore anything non-retryable — a misclassified marker must not start a
      // backoff (the scraper below still gets its normal shot on the next tick).
      if (!isRetryableError(ev.error)) {
        await tmuxAdapter.clearEvent();             // consume so it can't re-fire
        state._ignoredEventError = ev.error;
        return 'event-ignored';
      }
      await tmuxAdapter.clearEvent();               // consume
      if (isWorking(stripped)) { resetOverload(state); return 'overload-cleared'; } // self-recovered
      const capMs = overload.maxTotalWaitMinutes * 60_000;
      if (state.overloadTotalWaitMs >= capMs) { state._gaveUp = true; return 'overload-gave-up'; }
      const w = nextOverloadWaitMs(state.overloadAttempts, overload, rand);
      state.overloadTotalWaitMs += w;
      state.overloadWaitUntil = Date.now() + w;
      state.status = 'overload';
      state.viaEvent = true;
      state._overloadMatch = { pattern: 'StopFailure', line: `error=${ev.error}` };
      return 'overload-detected';
    }
  }

  // Scraper safety net. Runs on every monitoring tick, even when the hook is live: the
  // event path can't emit some terminal renders (an API 429, "temporarily limiting
  // requests"), and the anchored overload patterns can't misfire on a session/usage limit
  // (no "API Error" line). Already isWorking-gated + raw-distance-bounded, so it won't
  // re-fire on a recovered/scrolled overload; and while a backoff is active (status ===
  // 'overload') the tick returns above before reaching here.
  if (overload && overload.enabled && !isWorking(stripped)) {
    const match = overloadMatch(stripped, overload.patterns);
    if (match) {
      // Don't re-fire on the same banner the event path just retried and that hasn't
      // cleared — that incident is owned by the (edge-triggered) event path until the render
      // changes or a fresh marker arrives. Otherwise the always-on scraper opens a second
      // backoff (extra injection + resetOverload defeats the give-up cap).
      if (state._eventHandledBanner === `${match.pattern} ${match.line}`) return 'monitoring';
      state._overloadMatch = match;  // surfaced in the 'overload-detected' log line
      return enterOverload(state, overload, rand);
    }
    state._eventHandledBanner = null;  // banner gone → a future match is a fresh incident
  }

  // Safeguard/AUP false-positive: enter a bounded, seconds-scale retry loop. Independent
  // of the overload path (different render, different recovery). Only when Claude is idle.
  // Suppressed whenever the downgrade banner is in the tail (even an already-handled one):
  // a combined render must belong to smart-check — re-sending "continue" here would submit
  // the flagged turn on the downgraded model.
  const safeguard = config.safeguard;
  if (safeguard && safeguard.enabled && !workingNow && !smartBanner) {
    const match = safeguardMatch(stripped, safeguard.patterns);
    if (match) {
      resetSafeguard(state);
      state.status = 'safeguard';
      state.safeguardWaitUntil = Date.now() + (safeguard.retryDelaySeconds * 1000);
      state._safeguardMatch = match;
      return 'safeguard-detected';
    }
  }

  // Smart-check switch-back: quiet period satisfied (or `smart-check back` forced it),
  // pane idle with an empty prompt, nothing pinning us to the fallback → restore the
  // primary model + effort. Runs LAST so every live-error path above takes precedence.
  if (smartActive && !smart.pinned && !smart.primaryUnavailable && !workingNow
      && (smart.currentModel === 'fallback' || smart.forceBack)) {
    const quietOk = smart.currentModel === 'fallback'
      && smart.cleanTurns >= sc.cleanTurnsBeforeSwitchBack
      && (Date.now() - smart.lastFlagAt) >= sc.switchBackCooldownMinutes * 60_000;
    if ((smart.forceBack || quietOk) && isInputEmpty(stripped)) {
      const fg = await checkForeground(tmuxAdapter, pane, config);
      if (fg.ok) {
        smart.forceBack = false;
        state.status = 'smartcheck';
        setSmartPhase(smart, 'back-model', sc.interruptTimeoutSeconds * 1000);
        return 'smartcheck-back-started';
      }
      state._lastForeground = fg.fg;
    }
  }

  return 'monitoring';
}

export async function startMonitor(pane, pid) {
  const config = await loadConfig();
  const logger = createLogger();
  const state = createMonitorState();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;

  await logger.info(`Monitor started for pane ${pane} (claude PID: ${pid})`);

  // Best-effort GC of status files left behind by monitors that died without cleaning up
  // (SIGKILL, host sleep/crash). Runs once per monitor start, not per tick.
  sweepStaleStatus().catch(() => {});
  sweepStaleSmartState().catch(() => {});

  // Rehydrate smart-check's durable session fields (PID-validated: a recycled pane id
  // with a NEW claude starts fresh). A monitor replaced mid-fallback resumes the promote
  // sequence via pendingFallback in the monitoring branch.
  const persistedSmart = await readSmartState(pane, pid).catch(() => null);
  if (persistedSmart) {
    adoptSmartState(state.smart, persistedSmart);
    await logger.info(`Smart-check state rehydrated: model=${state.smart.currentModel}${state.smart.halted ? ' HALTED' : ''}${state.smart.pinned ? ' pinned' : ''}${state.smart.primaryUnavailable ? ' primary-unavailable' : ''}${state.smart.pendingFallback ? ' pending-fallback' : ''}`);
  } else if (config.smartCheck?.enabled) {
    state.smart.currentModel = config.smartCheck.assumeModelOnStart === 'fallback' ? 'fallback' : 'primary';
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Best-effort: fire the unlink and exit without waiting on the promise. Signal
    // handlers are not the place to await — a hung filesystem must not block the
    // process from actually terminating on SIGTERM/SIGINT.
    clearStatus(pane).catch(() => {}).finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const eventMaxAgeMs = (config.overload?.eventMaxAgeSeconds || 120) * 1000;
  const tmuxAdapter = {
    capturePane, sendKeys, sendKey, sendCommand, getPaneCommand,
    isClaudeForeground: () => isProcessForeground(pid),
    // Pane-keyed StopFailure markers (written by the hook). The daemon owns the pane,
    // so this is a direct read — no session-id resolution needed.
    readEvent: () => readStopFailureEvent(pane, eventMaxAgeMs),
    clearEvent: () => clearStopFailureEvent(pane),
    // Smart-check durable state + CLI control channel. State is kept on monitor
    // SIGTERM (reconcile replacement must not wipe session facts) and cleared only
    // when claude itself exits.
    saveSmartState: (fields) => writeSmartState(pane, pid, fields),
    readSmartCommand: () => consumeSmartCommand(pane),
  };
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };

  const loop = async () => {
    try {
      const result = await processOneTick(state, tmuxAdapter, pane, config, isAlive);
      consecutiveErrors = 0;

      if (result === 'exit') {
        await clearStatus(pane).catch(() => {});
        await clearSmartState(pane).catch(() => {});
        await logger.info('Claude exited. Monitor shutting down.');
        process.exit(0);
      }

      // Published for external consumers (e.g. a tmux status-bar segment) — best-effort,
      // never let a write failure interrupt the monitor loop. pollIntervalSeconds travels
      // with every snapshot so the reader can derive its own staleness threshold instead
      // of assuming a fixed interval (a configured pollIntervalSeconds far above the old
      // hardcoded 30s stale-check would otherwise make a healthy monitor's segment blank
      // out for a large fraction of every tick). gaveUp flags the terminal states where
      // `status` alone doesn't tell a reader the monitor has stopped acting.
      await writeStatus(pane, {
        status: state.status,
        waitUntil: Math.floor(state.waitUntil / 1000),
        overloadWaitUntil: Math.floor(state.overloadWaitUntil / 1000),
        safeguardWaitUntil: Math.floor(state.safeguardWaitUntil / 1000),
        attempts: state.attempts,
        overloadAttempts: state.overloadAttempts,
        safeguardAttempts: state.safeguardAttempts,
        pollIntervalSeconds: config.pollIntervalSeconds,
        gaveUp: !!state._gaveUp,
        // Flat, grep-friendly smart-check keys for the tmux status segment + CLI status.
        smartModel: state.smart.currentModel,
        smartPhase: state.smart.phase || '',
        smartPinned: !!(state.smart.pinned || state.smart.primaryUnavailable),
        smartHalted: !!state.smart.halted,
        smartCleanTurns: state.smart.cleanTurns,
      }).catch(() => {});
      if (state._smartCmdApplied) {
        await logger.info(`Smart-check command applied: ${state._smartCmdApplied}`);
        state._smartCmdApplied = null;
      }
      if (result === 'waiting' && state.lastRateLimitMessage) {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate limit detected: "${state.lastRateLimitMessage}". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'menu-confirmed') {
        const secs = Math.round((state.waitUntil - Date.now()) / 1000);
        await logger.info(`Rate-limit options menu: selected "Stop and wait for limit to reset". Waiting ${secs}s...`);
        state.lastRateLimitMessage = null;
      }
      if (result === 'menu-unreadable') await logger.warn('Rate-limit options menu detected but its layout could not be read; not pressing Enter (would risk confirming "Upgrade your plan"). Will recheck.');
      if (result === 'retried') await logger.info(`Sent retry message (attempt ${state.attempts})`);
      if (result === 'user-continued') await logger.info('User already continued. Attempt counter reset.');
      if (result === 'max-retries') await logger.warn(`Max retries (${config.maxRetries}) reached. Monitor still active but will not send further retries until rate limit clears.`);
      if (result === 'skipped-not-claude') await logger.warn(`Foreground is "${state._lastForeground}", not Claude. Skipping send-keys. (Add to foregroundCommands in ~/.claude-auto-retry.json if this is wrong)`);
      if (result === 'event-ignored') await logger.warn(`Ignored StopFailure marker with non-retryable error="${state._ignoredEventError}". If this is "rate_limit", an outdated hook is installed — re-run "claude-auto-retry install-hook".`);
      if (result === 'overload-detected') {
        const secs = Math.round((state.overloadWaitUntil - Date.now()) / 1000);
        const m = state._overloadMatch;
        const why = m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : '';
        await logger.warn(`Overload/transient API error detected (sustained)${why}. Backing off ${secs}s before retry. NOTE: Claude Code retries 5xx/529 internally — this only fires on terminal overload.`);
      }
      if (result === 'overload-retried') {
        const secs = Math.round((state.overloadWaitUntil - Date.now()) / 1000);
        await logger.info(`Overload retry sent (attempt ${state.overloadAttempts}). Next backoff ${secs}s. Cumulative wait ${Math.round(state.overloadTotalWaitMs / 1000)}s.`);
      }
      if (result === 'overload-working') await logger.info('Overload text present but Claude is working (internal retry/streaming). Deferring — not terminal.');
      if (result === 'overload-cleared') await logger.info('Overload cleared. Resuming normal monitoring.');
      if (result === 'overload-relaunched') await logger.warn(`Claude exited to shell on overload; relaunched via "${config.overload.relaunchCommand}" (relaunchOnExit on, attempt ${state.overloadAttempts}).`);
      if (result === 'overload-exited-to-shell') await logger.warn(`Overload error left claude exited to the shell ("${state._lastForeground}"). Not auto-relaunching (relaunchOnExit off). Re-run "claude --continue" to resume, or set overload.relaunchOnExit:true.`);
      if (result === 'overload-gave-up') await logger.warn(`Overload backoff cap reached (maxTotalWaitMinutes=${config.overload.maxTotalWaitMinutes}). Giving up — endpoint may be genuinely down (check status.claude.com). Will not retry until the error clears.`);
      if (result === 'safeguard-detected') {
        const m = state._safeguardMatch;
        await logger.warn(`Safeguard/AUP flag detected${m ? ` [matched /${m.pattern}/ in: "${m.line}"]` : ''} — often a false positive. Will retry up to ${config.safeguard.maxRetries}x every ${config.safeguard.retryDelaySeconds}s.`);
      }
      if (result === 'safeguard-retried') await logger.info(`Safeguard retry sent (attempt ${state.safeguardAttempts}/${config.safeguard.maxRetries}).`);
      if (result === 'safeguard-cleared') await logger.info('Safeguard flag cleared. Resuming normal monitoring.');
      if (result === 'safeguard-gave-up') await logger.warn(`Safeguard flag persisted after ${config.safeguard.maxRetries} retries. Giving up — the flag is likely sticky for this content/model; try /model to switch models or rephrase. Will not retry until it clears.`);
      // Smart-check results — one line per state change, quiet on the wait/verify ticks.
      if (result === 'smartcheck-downgrade-detected' || result === 'smartcheck-downgrade-detected-idle') {
        await logger.warn(`Smart-check: safeguard downgrade banner detected (switched to "${state.smart.fingerprint?.split('|').pop() || 'fallback model'}"). Promoting to ${config.smartCheck.models.fallback.command} + ${config.smartCheck.effort.fallback.command}${result.endsWith('idle') ? '' : ' (interrupting the in-flight turn first)'}.`);
      }
      if (result === 'smartcheck-halted') await logger.warn(`Smart-check: HALTED — flag switched the session BELOW the fallback model ("${state._smartHaltBanner || 'unreadable banner'}"). No automation will run. Decide with: claude smart-check resume | rephrase (or edit the prompt yourself).`);
      if (result === 'smartcheck-escape-sent') await logger.info('Smart-check: sent Escape to stop the downgraded in-flight turn.');
      if (result === 'smartcheck-model-sent') await logger.info(`Smart-check: sent "${config.smartCheck.models.fallback.command}"; verifying...`);
      if (result === 'smartcheck-model-verified') await logger.info('Smart-check: fallback model confirmed. Setting effort...');
      if (result === 'smartcheck-effort-sent') await logger.info(`Smart-check: sent "${config.smartCheck.effort.fallback.command}"; verifying...`);
      if (result === 'smartcheck-effort-cycled') await logger.info(`Smart-check: /effort argument unverified — cycling bare /effort (${state.smart.effortCycles}/${config.smartCheck.effort.maxCycles}).`);
      if (result === 'smartcheck-effort-mismatch') await logger.warn('Smart-check: could not verify the target effort level — proceeding anyway (model switch stands). Check /effort manually.');
      if (result === 'smartcheck-effort-skipped') await logger.warn('Smart-check: input box stayed non-empty — skipped the effort change. Check /effort manually.');
      if (result === 'smartcheck-picker-driven') await logger.info('Smart-check: command opened a picker; drove the selection with arrow keys.');
      if (result === 'smartcheck-fallback-complete') await logger.info('Smart-check: fallback complete (model + effort verified, nudge sent). Counting clean turns toward switch-back.');
      if (result === 'smartcheck-fallback-complete-nonudge') await logger.info('Smart-check: fallback complete (session already active — nudge skipped).');
      if (result === 'smartcheck-resumed-fallback') await logger.info('Smart-check: resuming an interrupted fallback sequence (monitor restart or diversion).');
      if (result === 'smartcheck-back-started') await logger.info(`Smart-check: quiet period satisfied — restoring ${config.smartCheck.models.primary.command} + ${config.smartCheck.effort.primary.command}.`);
      if (result === 'smartcheck-back-model-sent') await logger.info(`Smart-check: sent "${config.smartCheck.models.primary.command}"; verifying...`);
      if (result === 'smartcheck-back-model-verified') await logger.info('Smart-check: primary model confirmed. Restoring effort...');
      if (result === 'smartcheck-back-complete') await logger.info('Smart-check: switch-back complete — session restored to the primary model + effort.');
      if (result === 'smartcheck-back-before-retry') await logger.info('Smart-check: usage-limit wait expired on the fallback model — restoring the primary model + effort BEFORE sending the continue.');
      if (result === 'smartcheck-back-complete-resume') await logger.info('Smart-check: primary model + effort restored; handing back to the usage path to send the continue.');
      if (result === 'smartcheck-back-effort-mismatch') await logger.warn('Smart-check: primary model restored but the effort level could not be verified. Check /effort manually.');
      if (result === 'smartcheck-back-aborted') await logger.info('Smart-check: switch-back stepped aside (session active again). Will retry at the next idle window.');
      if (result === 'smartcheck-primary-unavailable') await logger.warn('Smart-check: primary model UNAVAILABLE (credits exhausted or model unusable). Pinned to the fallback model — the session stays fully usable. Re-enable restore attempts with: claude smart-check resume');
      if (result === 'smartcheck-gave-up') await logger.warn(`Smart-check: gave up (${state._smartGiveUpReason || 'unknown'}). No further keystrokes for this banner; fix manually (/model, /effort) if needed.`);
      if (result === 'smartcheck-rephrased') await logger.warn('Smart-check: sent the rephrase request. Automation re-enabled; model treated as unknown until the next verified switch.');
      if (result === 'smartcheck-downgrade-ignored') await logger.warn('Smart-check: downgrade to a non-fallback model observed but haltBelowFallback is off — acknowledged without action.');
    } catch (err) {
      consecutiveErrors++;
      await logger.error(`Monitor tick error: ${err.message}`).catch(() => {});
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        await clearStatus(pane).catch(() => {});
        await logger.error(`${MAX_CONSECUTIVE_ERRORS} consecutive errors. Pane likely destroyed. Exiting.`).catch(() => {});
        process.exit(1);
      }
    }
  };

  // Use recursive setTimeout instead of setInterval to prevent concurrent
  // tick execution when a tick takes longer than the poll interval.
  const scheduleNext = () => {
    setTimeout(async () => {
      await loop();
      scheduleNext();
    }, config.pollIntervalSeconds * 1000);
  };
  loop().then(scheduleNext);
}

// Direct execution: node monitor.js <pane> <pid>
const isDirectRun = process.argv[1]?.endsWith('monitor.js') && process.argv.length >= 4;
if (isDirectRun) {
  startMonitor(process.argv[2], parseInt(process.argv[3], 10));
}
