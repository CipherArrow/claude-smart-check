# AGENTS.md — install & operate this project on a user's machine

Instructions for an AI coding agent (Claude Code, etc.) installing **claude-smart-check**
(a claude-auto-retry fork with the smart-check layer) for its user. Follow the order; the
safety rules are not optional. Read `COMPATIBILITY.md` first for the architecture.

## Preconditions to verify

1. **Linux** (`uname -s` → Linux). Any distro; Arch is the primary target. macOS is
   untested for smart-check — warn the user and proceed only if they insist.
2. **Node.js ≥ 18** on PATH (`node --version`). Note which Node this is — every installed
   path (shell wrapper, hook, systemd unit) pins the current `node`; nvm users must re-run
   the install steps after switching Node versions.
3. **npm global prefix is user-writable** (`npm config get prefix`). If it is
   `/usr/lib`-ish, either configure `npm config set prefix ~/.npm-global` (and add
   `~/.npm-global/bin` to PATH) or expect a sudo prompt you should NOT auto-answer.
4. **tmux ≥ 2.1** (`tmux -V`). If missing, `claude-auto-retry install` offers a distro
   package install (detects Arch/Debian/RHEL/Alpine; uses sudo — let the USER confirm it).
5. **Claude Code** installed (`which claude`).

## Install steps

```sh
git clone https://github.com/CipherArrow/claude-smart-check ~/Projects/claude-smart-check
cd ~/Projects/claude-smart-check
npm test                       # 400+ tests must pass before touching the user's system
npm install -g .               # provides claude-auto-retry + the smart-check CLI
claude-auto-retry install      # claude() wrapper into ~/.bashrc / ~/.zshrc (marker-delimited, idempotent)
claude-auto-retry install-hook # StopFailure hook into ~/.claude/settings.json — see safety rule 2
claude-auto-retry install-timer # systemd --user reconcile timer (self-healing coverage, every 5 min)
```

Then two things the AGENT MUST ASK THE USER about (do not do silently):

6. **`"switchModelsOnFlag": true` in `~/.claude/settings.json`** — smart-check reacts to
   the model-downgrade banner this setting enables. It is a safeguard-related setting:
   show the user the one-line diff and let them approve or apply it themselves.
7. **Optional config** `~/.claude-auto-retry.json` — defaults are built in and correct for
   Fable 5 (primary) / Opus 4.8 (fallback). Only write this file if the user wants
   different models/efforts/wording. Template: the `smartCheck` block in `SMART-CHECK.md`.

Optional integrations:

8. **tmux status segment** — add to `~/.tmux.conf` status-right:
   `#(claude-auto-retry-tmux-status '#{pane_id}' '#{socket_path}')`
   (both arguments are required; see the README section "tmux status bar indicator").

## Verify the install

```sh
claude-auto-retry version          # expect 0.7.x
source ~/.bashrc                   # or restart the shell
claude smart-check                 # → "No smart-check session state recorded yet." is normal
claude-auto-retry reconcile --dry-run
```

For a full behavioral check of the `/model` / `/effort` commands against the user's
installed Claude Code version, have the USER run `sh bin/smartcheck-probe.sh` themselves —
it starts a real (throwaway) Claude session on their account; an agent must not launch it
without explicit consent.

## Safety rules for the installing agent

1. Run `npm test` BEFORE `npm install -g`; abort on any failure.
2. Never edit `~/.claude/settings.json` beyond what `install-hook` does, and never flip
   `switchModelsOnFlag` without showing the user the exact change first. Preserve every
   existing hook — `install-hook` is additive and idempotent, but verify with a diff.
3. No sudo except the user-confirmed tmux package install.
4. Do not start Claude sessions (probe script included) without the user's say-so — they
   consume the user's plan/limits.
5. If anything looks partially installed (old versions, foreign wrappers around `claude`),
   read `COMPATIBILITY.md` § "Coexisting installs" before proceeding.

## Uninstall

```sh
claude-auto-retry uninstall-timer
claude-auto-retry uninstall-hook
claude-auto-retry uninstall        # removes the shell wrapper
npm uninstall -g claude-auto-retry
rm -rf ~/.claude-auto-retry        # state/logs (optional)
```
