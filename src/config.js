import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Transient API-error backoff (529 Overloaded / 500 / 503). Separate block from
// the usage-limit knobs above: those wait in *hours* until a reset, these wait in
// *seconds* on an exponential backoff. See README "Overload backoff".
export const DEFAULT_OVERLOAD = {
  enabled: true,
  // Anchored to Claude Code's actual TERMINAL error render — NOT bare status numbers.
  // A bare "503"/"529" matches ordinary code (res.status(503)), ports, byte counts and
  // quoted logs, which is what caused false "Continue where you left off." injections.
  // Matched as case-insensitive regexes against only the pane tail (see detectOverload).
  //
  // Claude Code (verified against the v2.1.x binary) has TWO render forms:
  //   terminal (retries exhausted):  "API Error: 529 {…}"  / "API Error: 503 no healthy upstream"
  //   transient (still retrying):     "API Error (529 …) · Retrying in 5s · attempt 3/10"
  // We REQUIRE the colon form to skip the parens form, and the retry SUFFIX
  // ("· Retrying in…" / "attempt n/m") is separately suppressed by the working gate
  // in patterns.js — together they ensure we never interrupt Claude's own backoff.
  patterns: [
    // Terminal error line. Covers the full retryable set (429+5xx) in the colon form.
    'API Error:\\s*(429|500|502|503|504|529)\\b',
    // JSON error.type for a sustained overload (survives the collapsed non-JSON render).
    'overloaded_error',
    // API-level 429 uses a dedicated render with no 3-digit code in the generic slot:
    //   "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
    'temporarily limiting requests',
  ],
  backoffSeconds: [30, 60, 120, 240, 300],
  steadyStateSeconds: 300,
  jitterPct: 15,
  maxTotalWaitMinutes: 120,
  // StopFailure event markers older than this are ignored (guards against a recycled
  // tmux pane id replaying a stale failure, or acting on a marker left while down).
  eventMaxAgeSeconds: 120,
  retryMessage: 'Continue where you left off.',
  // Gating: by default we only act when claude is alive at its prompt (the
  // foreground safety check passes). If a 500 ever drops you to the shell, the
  // send-keys is correctly blocked and nothing resumes; flip relaunchOnExit to
  // re-enter via relaunchCommand. Off by default — never type into a shell the
  // user may be using. See README "Gating decision".
  relaunchOnExit: false,
  relaunchCommand: 'claude --continue',
};

// Safeguard / AUP false-positive retry. Distinct from usage limits (hours) and overload
// (5xx, exponential): the model's safeguards flag a message — often a false positive, so
// an immediate re-send usually clears it. Bounded by maxRetries so a *sticky* flag can't
// loop forever. See README "Safeguard retry".
export const DEFAULT_SAFEGUARD = {
  enabled: true,
  // Case-insensitive regexes matched against the pane tail; a match only counts with an
  // `API Error` line nearby (see safeguardMatch) so quoting/discussing these phrases in
  // conversation can't trigger a retry. Match the stable phrases of the render, not the
  // model name (which varies).
  patterns: [
    "safeguards flagged this message",
    "can't respond to this request with",   // "Claude Code can't respond to this request with <model>"
    "legal/aup",                             // the AUP link Anthropic includes
  ],
  maxRetries: 3,          // small — if it keeps flagging, retrying won't help
  retryDelaySeconds: 8,   // brief pause between re-sends (semi-random flag; quick retry helps)
  retryMessage: 'continue',
};

// Smart-check: cooperate with Claude Code's own safeguard model-downgrade
// (switchModelsOnFlag). When a flag banner switches the session to the FALLBACK model,
// promote it to the fallback effort and nudge the work onward; once a quiet period passes
// with no further flags, restore the PRIMARY model + effort. A switch to anything below
// the fallback model halts all automation for a human decision. Every matched and typed
// string lives here so a Claude Code wording change is a config edit, not a code fix.
export const DEFAULT_SMARTCHECK = {
  enabled: true,
  // Banner phrases (any one) + an anchor whose capture group 1 is the switched-to model.
  // Both matched in the same chrome-aware live tail the other detectors use.
  downgradePatterns: [
    'safeguards flagged this message',
    'intentionally broad right now',
  ],
  downgradeAnchors: ['Switched to\\s+([A-Za-z0-9 .\\-]+)'],
  // `command` must use a model ID or alias — the display name is rejected (probed
  // 2026-07-22 on v2.1.218: `/model Fable 5` → "Model 'Fable 5' not found"). The
  // confirm/picker renders DO use the display name.
  models: {
    primary: { name: 'Fable 5', command: '/model claude-fable-5[1m]', confirm: 'Set model to Fable 5', pickerOption: 'Fable 5' },
    fallback: { name: 'Opus 4\\.8', command: '/model claude-opus-4-8', confirm: 'Set model to Opus 4\\.8', pickerOption: 'Opus 4\\.8' },
  },
  effort: {
    primary: { command: '/effort High', confirm: 'Set effort level to high', pickerOption: '\\bhigh\\b' },
    fallback: { command: '/effort Max', confirm: 'Set effort level to max', pickerOption: '\\bmax\\b' },
    // Bare-/effort cycling fallback bound. 6 covers a full wrap of the known effort
    // levels, so if `/effort <level>` ignores its argument the cycle always reaches the
    // target instead of stranding the SAVED default on an intermediate level.
    maxCycles: 6,
  },
  nudgeMessage: 'Continue — take into account my last message and what you were in the middle of doing in the project.',
  // A switch to any model other than models.fallback halts automation (no keystrokes at
  // all) until `claude smart-check resume` / `rephrase`. Fail-safe: an unparseable model
  // name is treated as below-fallback.
  haltBelowFallback: true,
  rephraseMessage: 'The previous message was flagged and the session was downgraded. Rewrite my last request so it fully complies with the usage policy while preserving the technical goal, state the rewritten request, then continue the work using it.',
  cleanTurnsBeforeSwitchBack: 3,
  switchBackCooldownMinutes: 10,
  verifyTimeoutSeconds: 30,
  interruptTimeoutSeconds: 60,
  // Extra settle between typing a slash command and the submitting Enter — the command
  // palette popup needs longer than the plain-message SUBMIT_DELAY_MS.
  commandSettleMs: 300,
  // What model to assume for a pane with no prior smart-check state: 'primary' (matches
  // a settings.json that pins the primary model) or 'fallback'.
  assumeModelOnStart: 'primary',
  // Renders that mean the primary model cannot be used right now (usage credits gone,
  // model unavailable). Checked during switch-back; a match pins the session to the
  // fallback so the user is never locked out of coding.
  primaryUnavailablePatterns: [
    'out of .*credits',
    'usage credits .*(exhausted|depleted)',
    'is (currently )?unavailable',
    'insufficient .*credits',
  ],
};

export const DEFAULT_CONFIG = {
  maxRetries: 5,
  pollIntervalSeconds: 5,
  marginSeconds: 60,
  fallbackWaitHours: 5,
  retryMessage: 'Continue where you left off. The previous attempt was rate limited.',
  customPatterns: [],
  overload: DEFAULT_OVERLOAD,
  safeguard: DEFAULT_SAFEGUARD,
  smartCheck: DEFAULT_SMARTCHECK,
};

const CONFIG_PATH = join(homedir(), '.claude-auto-retry.json');

function validNumber(val, min, fallback) {
  return typeof val === 'number' && Number.isFinite(val) && val >= min ? val : fallback;
}

function clamp(val, lo, hi, fallback) {
  if (typeof val !== 'number' || !Number.isFinite(val)) return fallback;
  return Math.min(hi, Math.max(lo, val));
}

function validateOverload(raw) {
  // Shallow-merge so a partial user block keeps the documented defaults for the
  // keys it omits (JSON.parse's spread would otherwise replace the whole block).
  const o = { ...DEFAULT_OVERLOAD, ...(raw && typeof raw === 'object' ? raw : {}) };

  o.enabled = typeof o.enabled === 'boolean' ? o.enabled : DEFAULT_OVERLOAD.enabled;

  // Patterns are case-insensitive regexes (see detectOverload). Keep only non-empty
  // strings that actually compile, so a typo'd pattern can't crash the monitor tick.
  const pats = Array.isArray(o.patterns)
    ? o.patterns.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  o.patterns = pats.length > 0 ? pats : [...DEFAULT_OVERLOAD.patterns];

  const backoff = Array.isArray(o.backoffSeconds)
    ? o.backoffSeconds.filter(n => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];
  o.backoffSeconds = backoff.length > 0 ? backoff : [...DEFAULT_OVERLOAD.backoffSeconds];

  o.steadyStateSeconds = validNumber(o.steadyStateSeconds, 1, DEFAULT_OVERLOAD.steadyStateSeconds);
  o.jitterPct = clamp(o.jitterPct, 0, 100, DEFAULT_OVERLOAD.jitterPct);
  o.maxTotalWaitMinutes = validNumber(o.maxTotalWaitMinutes, 0.1, DEFAULT_OVERLOAD.maxTotalWaitMinutes);
  o.eventMaxAgeSeconds = validNumber(o.eventMaxAgeSeconds, 1, DEFAULT_OVERLOAD.eventMaxAgeSeconds);

  if (typeof o.retryMessage !== 'string' || !o.retryMessage) {
    o.retryMessage = DEFAULT_OVERLOAD.retryMessage;
  }
  o.relaunchOnExit = typeof o.relaunchOnExit === 'boolean' ? o.relaunchOnExit : DEFAULT_OVERLOAD.relaunchOnExit;
  if (typeof o.relaunchCommand !== 'string' || !o.relaunchCommand) {
    o.relaunchCommand = DEFAULT_OVERLOAD.relaunchCommand;
  }
  return o;
}

function validateSafeguard(raw) {
  const s = { ...DEFAULT_SAFEGUARD, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.enabled = typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_SAFEGUARD.enabled;
  const pats = Array.isArray(s.patterns)
    ? s.patterns.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  s.patterns = pats.length > 0 ? pats : [...DEFAULT_SAFEGUARD.patterns];
  s.maxRetries = validNumber(s.maxRetries, 1, DEFAULT_SAFEGUARD.maxRetries);
  s.retryDelaySeconds = validNumber(s.retryDelaySeconds, 1, DEFAULT_SAFEGUARD.retryDelaySeconds);
  if (typeof s.retryMessage !== 'string' || !s.retryMessage) {
    s.retryMessage = DEFAULT_SAFEGUARD.retryMessage;
  }
  return s;
}

// Keep only non-empty strings that compile as regexes (same policy as the other
// pattern lists); fall back to the defaults when nothing survives.
function validPatterns(raw, defaults) {
  const pats = Array.isArray(raw)
    ? raw.filter(p => {
        if (typeof p !== 'string' || p.length === 0) return false;
        try { new RegExp(p); return true; } catch { return false; }
      })
    : [];
  return pats.length > 0 ? pats : [...defaults];
}

function validString(val, fallback) {
  return typeof val === 'string' && val ? val : fallback;
}

function validateModelSpec(raw, defaults) {
  const m = { ...defaults, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of Object.keys(defaults)) {
    m[key] = validString(m[key], defaults[key]);
    // name/confirm/pickerOption are used as regexes — an invalid one must not crash a tick.
    if (key !== 'command') {
      try { new RegExp(m[key]); } catch { m[key] = defaults[key]; }
    }
  }
  return m;
}

function validateSmartCheck(raw) {
  const s = { ...DEFAULT_SMARTCHECK, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.enabled = typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_SMARTCHECK.enabled;
  s.downgradePatterns = validPatterns(s.downgradePatterns, DEFAULT_SMARTCHECK.downgradePatterns);
  s.downgradeAnchors = validPatterns(s.downgradeAnchors, DEFAULT_SMARTCHECK.downgradeAnchors);
  const rawModels = raw && typeof raw === 'object' && raw.models && typeof raw.models === 'object' ? raw.models : {};
  s.models = {
    primary: validateModelSpec(rawModels.primary, DEFAULT_SMARTCHECK.models.primary),
    fallback: validateModelSpec(rawModels.fallback, DEFAULT_SMARTCHECK.models.fallback),
  };
  const rawEffort = raw && typeof raw === 'object' && raw.effort && typeof raw.effort === 'object' ? raw.effort : {};
  s.effort = {
    primary: validateModelSpec(rawEffort.primary, DEFAULT_SMARTCHECK.effort.primary),
    fallback: validateModelSpec(rawEffort.fallback, DEFAULT_SMARTCHECK.effort.fallback),
    maxCycles: validNumber(rawEffort.maxCycles, 1, DEFAULT_SMARTCHECK.effort.maxCycles),
  };
  s.nudgeMessage = validString(s.nudgeMessage, DEFAULT_SMARTCHECK.nudgeMessage);
  s.haltBelowFallback = typeof s.haltBelowFallback === 'boolean' ? s.haltBelowFallback : DEFAULT_SMARTCHECK.haltBelowFallback;
  s.rephraseMessage = validString(s.rephraseMessage, DEFAULT_SMARTCHECK.rephraseMessage);
  s.cleanTurnsBeforeSwitchBack = validNumber(s.cleanTurnsBeforeSwitchBack, 1, DEFAULT_SMARTCHECK.cleanTurnsBeforeSwitchBack);
  s.switchBackCooldownMinutes = validNumber(s.switchBackCooldownMinutes, 0, DEFAULT_SMARTCHECK.switchBackCooldownMinutes);
  s.verifyTimeoutSeconds = validNumber(s.verifyTimeoutSeconds, 5, DEFAULT_SMARTCHECK.verifyTimeoutSeconds);
  s.interruptTimeoutSeconds = validNumber(s.interruptTimeoutSeconds, 5, DEFAULT_SMARTCHECK.interruptTimeoutSeconds);
  s.commandSettleMs = clamp(s.commandSettleMs, 50, 5000, DEFAULT_SMARTCHECK.commandSettleMs);
  s.assumeModelOnStart = s.assumeModelOnStart === 'fallback' || s.assumeModelOnStart === 'opus' ? 'fallback' : 'primary';
  // Accept the fableUnavailablePatterns spelling from early docs as an alias.
  const unavailRaw = s.primaryUnavailablePatterns ?? s.fableUnavailablePatterns;
  s.primaryUnavailablePatterns = validPatterns(unavailRaw, DEFAULT_SMARTCHECK.primaryUnavailablePatterns);
  delete s.fableUnavailablePatterns;
  return s;
}

function validate(cfg) {
  cfg.maxRetries = validNumber(cfg.maxRetries, 1, DEFAULT_CONFIG.maxRetries);
  cfg.pollIntervalSeconds = validNumber(cfg.pollIntervalSeconds, 1, DEFAULT_CONFIG.pollIntervalSeconds);
  cfg.marginSeconds = validNumber(cfg.marginSeconds, 0, DEFAULT_CONFIG.marginSeconds);
  cfg.fallbackWaitHours = validNumber(cfg.fallbackWaitHours, 0.1, DEFAULT_CONFIG.fallbackWaitHours);
  if (typeof cfg.retryMessage !== 'string' || !cfg.retryMessage) {
    cfg.retryMessage = DEFAULT_CONFIG.retryMessage;
  }
  if (!Array.isArray(cfg.customPatterns)) {
    cfg.customPatterns = DEFAULT_CONFIG.customPatterns;
  } else {
    cfg.customPatterns = cfg.customPatterns.filter(p => {
      if (typeof p !== 'string') return false;
      try { new RegExp(p); return true; } catch { return false; }
    });
  }
  if (cfg.foregroundCommands !== undefined) {
    if (!Array.isArray(cfg.foregroundCommands) || cfg.foregroundCommands.length === 0) {
      delete cfg.foregroundCommands;
    }
  }
  cfg.overload = validateOverload(cfg.overload);
  cfg.safeguard = validateSafeguard(cfg.safeguard);
  cfg.smartCheck = validateSmartCheck(cfg.smartCheck);
  return cfg;
}

export async function loadConfig(path = CONFIG_PATH) {
  try {
    const raw = await readFile(path, 'utf-8');
    return validate({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
