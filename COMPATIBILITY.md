# COMPATIBILITY.md — how the base tool works and how smart-check rides on it

For humans and AI agents installing or debugging this project. smart-check is not a
separate daemon: it is a state-machine extension **inside** claude-auto-retry's existing
per-pane monitor, which is why the two integrate seamlessly — one process, one injection
channel, one set of safety gates.

## The base tool (claude-auto-retry) in one page

- **Launcher** (`src/launcher.js`): the `claude()` shell function (installed into
  bashrc/zshrc between `# >>> claude-auto-retry >>>` markers) runs the launcher instead of
  the raw binary. Inside tmux it spawns claude in-place and forks a detached
  **monitor** for the pane; outside tmux it creates a `claude-retry-<pid>-<ts>` session
  first. It also stamps `CLAUDE_AUTO_RETRY_PANE` into claude's env (used by the hook).
- **Monitor** (`src/monitor.js`): one detached Node process per pane. Every 5 s (default)
  it runs `tmux capture-pane` (120 lines), strips ANSI + trailing UI chrome, and runs
  detectors over the live tail. It types with `tmux send-keys` — literal text, then Enter
  after a settle — and ONLY when the pane's foreground process is claude/node.
- **Detection paths** (`src/patterns.js`), in precedence order inside a tick:
  1. interactive rate-limit menu (arrow-key driven to "Stop and wait");
  2. usage/session limit banner → hours-scale wait until the printed reset time, then a
     "continue" retry (bounded by `maxRetries`);
  3. transient API overload (`API Error: 5xx/429`-anchored) → seconds-scale exponential
     backoff, also fed by an event channel: a **StopFailure hook** in
     `~/.claude/settings.json` writes a pane-keyed marker on `overloaded|server_error`;
  4. safeguard/AUP flag in its API-Error render (no model switch) → bounded "continue"
     re-sends.
- **Reconcile** (`src/reconcile.js` + systemd `--user` timer, every 5 min): finds live
  claude panes without a monitor and arms one — coverage self-heals after crashes and
  covers sessions started without the wrapper.
- **Status files** (`~/.claude-auto-retry/status/<socket>_<pane>.json`): per-tick JSON
  snapshots consumed by the POSIX tmux status script.

## Where smart-check plugs in

| Piece | Integration |
|---|---|
| Detector | `downgradeMatch` in `patterns.js` — anchored on the "Switched to (<model>)" line, captures the model name; runs in the monitoring branch AFTER the rate-limit check and BEFORE overload/safeguard |
| State machine | new `smartcheck` status in `processOneTick` with phases `interrupt → set-model → verify-model → set-effort → verify-effort → nudge` and the `back-*` mirror for the restore |
| Precedence | usage-limit beats smart-check everywhere; smart-check beats the legacy safeguard path whenever the downgrade banner is present (prevents double-typing); a HALT beats *everything* (early-return before all injection branches) |
| Durable state | `~/.claude-auto-retry/smartcheck/<socket>_<pane>.json`, PID-validated, written on every change, kept across monitor SIGTERM (reconcile replacement) and cleared when claude exits — a replaced monitor resumes an interrupted fallback via `pendingFallback` |
| CLI channel | `<key>.cmd.json` markers written by `claude smart-check <cmd>`, consumed (and age-gated, 120 s) at the top of every monitor tick |
| Launcher | `claude smart-check …` is intercepted by the launcher and routed to the CLI — the shell wrapper needed no changes |
| Status bar | extra flat keys (`smartModel`, `smartPhase`, `smartPinned`, `smartHalted`, `smartCleanTurns`) in the status JSON; the status script renders `·O`, `📌`, `🔵AR⇄`, `🔴AR HALT` |

## The interplay rules that matter when debugging

1. **During a usage-limit wait, smart-check is dormant.** No model switching while
   limited — the waiting branch owns the pane.
2. **Restore-before-continue:** when the wait expires and the session sits on the
   fallback model, the monitor detours through the verified restore (`/model` + `/effort`
   are local commands and work while limited), then hands back to the waiting branch,
   which sends the continue. Any detour failure (primary unavailable, user activity)
   re-routes so the continue is never stranded. `cleanTurns` is waived on this path; the
   flag cooldown is not.
3. **The legacy safeguard path still exists** for the API-Error flag render where NO
   model switch happened (`switchModelsOnFlag` off, or older harness) — smart-check and it
   are mutually exclusive by render anchoring plus an explicit suppression gate.
4. **HALT stops the base tool too:** while halted, even rate-limit retries and menu
   driving are skipped. Only `smart-check resume`/`rephrase` (or claude exiting) ends it.
5. **Model commands must use IDs** (`/model claude-opus-4-8`), not display names —
   display names are rejected by Claude Code (verified v2.1.218). Note `/model <id>` also
   updates the user's saved default model for new sessions; the restore puts it back.

## Coexisting installs

- **Upgrading from stock claude-auto-retry (≤0.6.x):** `npm install -g .` from this repo
  replaces the package in place. Wrapper, hook, and timer entries all reference paths that
  keep resolving — do NOT re-run `install`/`install-hook`/`install-timer` unless they were
  never installed. Replace running monitors afterwards:
  `pkill -f 'node .*src/monitor\.js' && claude-auto-retry reconcile`.
- **Never `npm install -g claude-auto-retry` from the npm registry afterwards** — that
  reverts to stock upstream and silently removes smart-check. Upgrade path: merge upstream
  git into this fork, `npm test`, reinstall from the local path (see `FORK-NOTES.md`).
- **Other `claude` wrappers** (aliases, retry scripts): the wrapper function must end up
  the outermost layer or the monitor never arms on launch (reconcile will still catch the
  pane within 5 min). Check `type claude` — it should be the marker-delimited function.
- **Multiple tmux servers** (`tmux -L …`) are supported: all state is keyed by
  socket + pane id.
