# Local fork notes (smart-check)

This is a **local fork** of [claude-auto-retry](https://github.com/cheapestinference/claude-auto-retry)
carrying the smart-check feature (safeguard-downgrade model/effort recovery). The globally
installed copy comes from THIS directory, not the npm registry.

## ⚠ Never upgrade from the registry directly

`npm install -g claude-auto-retry` (no path) would replace the global install with stock
upstream and **silently remove smart-check**. The weekly update-check timer is notify-only
and will never do this by itself — but don't do it by hand either.

## Safe upgrade procedure (when upstream releases something you want)

Remotes: `origin` = the published fork (CipherArrow/claude-smart-check), `upstream` =
cheapestinference/claude-auto-retry.

```sh
cd ~/Projects/claude-auto-retry-fork
git fetch upstream
git merge upstream/main        # resolve conflicts — smart-check touches:
                               #   src/monitor.js  src/patterns.js  src/config.js
                               #   src/smartcheck-state.js (fork-only)  src/tmux.js
                               #   src/launcher.js  bin/cli.js  bin/tmux-status.sh
npm test                       # all green before installing
npm install -g ~/Projects/claude-auto-retry-fork
pkill -f 'node .*src/monitor\.js' && claude-auto-retry reconcile
```

Keep the fork's `package.json` version ABOVE upstream's (bump the minor after each merge)
so the update-check notifier stays quiet.

## What Claude Code updates can and cannot break

Smart-check runs entirely outside the harness (tmux capture-pane + send-keys). A Claude
Code update can only affect it by changing *strings*: the downgrade banner wording, the
"Set model to …" / "Set effort level to …" confirmations, or the `/model` / `/effort`
argument handling. All of those are config knobs in `~/.claude-auto-retry.json`
(`smartCheck` block) — fix wording drift there, no code changes. Every injection is
verify-or-give-up: if a render changes, the monitor logs a loud warning and stops typing
rather than guessing. Re-run `sh bin/smartcheck-probe.sh` after a Claude Code update if
model/effort behavior seems off.

## How the two layers interact (usage limits × smart-check)

- While a usage-limit wait is active, smart-check does nothing (the limit path has
  precedence everywhere; the switch-back trigger sits behind the rate-limit check).
- When the wait expires with the session on the fallback model, the monitor restores the
  primary model + effort FIRST (verified `/model` → `/effort`, both local commands that
  work while limited), *then* sends the continue — so the session resumes in its
  pre-limit state. If the primary is unavailable (credits), it pins the fallback and the
  continue still goes out. cleanTurns is waived for this path (no turns can complete
  during a wait); the flag cooldown still applies.
- A `smart-check` HALT (downgraded below the fallback model) stops the usage retries too:
  nothing is typed into a halted pane until you `resume`/`rephrase`.
