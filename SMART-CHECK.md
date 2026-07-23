# smart-check — safeguard-downgrade model/effort recovery for Claude Code

`smart-check` is an automation layer (shipped inside this claude-auto-retry fork) that
handles Claude Code's **safeguard model downgrade** for you. When model safeguards flag a
message, Claude Code (with `"switchModelsOnFlag": true`) prints a banner like:

> ● Fable 5's safeguards flagged this message. The safeguards are intentionally broad
> right now and may flag safe and routine coding, cybersecurity, or biology work. …
> Switched to Opus 4.8. …

…and silently continues on the substitute model at your *default* effort — then never
switches back. smart-check turns that into a managed, reversible fallback:

## What it does

1. **Fallback promote** — on the downgrade banner:
   - If a turn is streaming, press `Escape` **once per poll while the working footer is
     visible** (never into an idle prompt — a second idle Escape opens the history-rewind UI).
   - Submit the fallback model command (`/model claude-opus-4-8`) and **verify** it by
     watching for the `Set model to Opus 4.8` confirmation in the pane.
   - Only after that, submit the fallback effort (`/effort Max`) and verify it.
   - Send a short nudge so the model resumes the flagged work.
2. **Quiet-period restore** — after N clean completed turns (default 3) **and** a cooldown
   since the flag (default 10 min), while the pane is idle with an empty input box:
   `/model` back to the primary (verified) → `/effort` back to the primary level (verified).
3. **Below-fallback halt** — if the banner switched the session to anything *other than*
   the configured fallback model (or the model name is unreadable — fail safe), **all
   automation stops**: zero keystrokes, loud log line, `🔴AR HALT` in the tmux status bar.
   You decide: `claude smart-check resume`, `claude smart-check rephrase` (asks the model
   to rewrite the flagged request compliantly and continue), or fix the prompt yourself.
4. **Primary-unavailable pin** — if the restore can't verify (usage credits exhausted,
   model unavailable), the session **pins to the fallback** and stays fully usable; no
   more restore attempts until `claude smart-check resume`. You are never locked out.
5. **Restore-before-continue** — if a usage-limit wait (the base tool's feature) expires
   while the session is on the fallback, smart-check restores the primary model + effort
   *first*, then lets the usage path send its "continue" — the session resumes in its
   pre-limit state. (`/model` and `/effort` are handled locally by Claude Code, so they
   work while the API is still limited.) If the primary is unavailable, it pins and the
   continue still goes out on the fallback.

## CLI

```
claude smart-check            # status (also: claude-auto-retry smart-check)
claude smart-check back       # restore the primary model + effort NOW
claude smart-check stay       # pin this session to the fallback (no auto-restore)
claude smart-check resume     # re-enable automation (clears pin / halt / unavailable)
claude smart-check rephrase   # only while HALTED: rewrite-and-continue request
claude smart-check on|off     # per-session enable/disable
```

Run inside the target tmux pane, or pass `--pane %N`.

## tmux status bar

`🟢AR` monitoring · `🟢AR·O` on the fallback model · `📌` pinned · `🔵AR⇄` a switch
sequence is in flight · `🔴AR HALT` halted awaiting your decision.

## Configuration

Everything smart-check *matches* or *types* is a knob in `~/.claude-auto-retry.json`
(`smartCheck` block — defaults shown in `src/config.js`, `DEFAULT_SMARTCHECK`):

| Key | Meaning |
|---|---|
| `downgradePatterns` / `downgradeAnchors` | Banner phrases + the "Switched to (…)" anchor whose capture group is the model name |
| `models.primary` / `models.fallback` | `name` (classify), `command` (**model IDs, not display names** — `/model Fable 5` is rejected), `confirm` (verification render), `pickerOption` |
| `effort.primary` / `effort.fallback` | Same shape; `maxCycles` bounds the bare-`/effort` cycling fallback |
| `nudgeMessage` / `rephraseMessage` | What gets typed to resume / to rewrite after a halt |
| `haltBelowFallback` | Halt on non-fallback switches (default true) |
| `cleanTurnsBeforeSwitchBack`, `switchBackCooldownMinutes` | The quiet period |
| `verifyTimeoutSeconds`, `interruptTimeoutSeconds`, `commandSettleMs` | Timing |
| `primaryUnavailablePatterns` | Renders meaning "primary can't be used right now" |
| `assumeModelOnStart` | Model assumed for a pane with no recorded state |

If a Claude Code update changes any wording, fix it here — no code changes. The probe
script (`sh bin/smartcheck-probe.sh`, run it yourself) verifies the `/model` / `/effort`
behavior against your installed Claude Code version.

## Security

- **No network access.** Zero runtime dependencies; Node stdlib only. Nothing is
  transmitted anywhere — no telemetry, no phoning home. Audit it: the code never imports
  `http`/`https`/`net`/`dgram`.
- **What it reads:** your tmux pane text (via `tmux capture-pane`, locally, 120 lines) and
  its own files under `~/.claude-auto-retry/`. It does not read Claude Code transcripts,
  credentials, or your shell history.
- **What it writes:** state/log files under `~/.claude-auto-retry/`, and — only during
  install — a shell function in `~/.bashrc`/`~/.zshrc`, a `StopFailure` hook entry in
  `~/.claude/settings.json`, and systemd `--user` units. All installs are idempotent and
  reversible (`uninstall`, `uninstall-hook`, `uninstall-timer`).
- **What it types, and when:** keystrokes go only to panes whose **foreground process is
  claude/node** (checked before every send — it will never type into your shell or
  another app). Every slash command is **verify-or-give-up**: the expected confirmation
  must appear in the pane, with a count-based check so stale renders can't false-verify;
  on timeout it tries the picker UI once, then stops with a loud log line. Escapes are
  sent only while the working footer is visible. Retries are bounded everywhere.
- **Halt = zero keystrokes.** A downgrade below the fallback model stops every injection
  path (including the base tool's rate-limit retries) until you explicitly resume. The
  automation cooperates with the safeguard rather than fighting it: it never re-submits
  flagged content to the model that flagged it, and it never works around a below-fallback
  enforcement decision on its own.
- **Trust boundaries:** the config file is user-owned trusted input (regexes are compiled
  defensively; invalid ones are dropped). CLI control markers are age-gated (120 s) and
  consumed-on-read. Per-pane state is PID-validated so a recycled tmux pane id can't
  inherit another session's state.
- **What it costs:** `/model` and `/effort` are local Claude Code commands (no API
  tokens). The nudge/rephrase messages are ordinary prompts and use your plan like any
  message you'd type.

## Requirements

Linux (primary target; any distro — the installer detects Arch/Debian/RHEL/Alpine for the
tmux dependency), Node.js ≥ 18, tmux ≥ 2.1, Claude Code running under the bundled wrapper
(or any tmux pane — the reconcile timer picks up unwrapped sessions too). macOS plumbing
exists upstream (launchd) but smart-check is tested on Linux.
