# Security Policy

This tool watches tmux panes and **types into them**. That makes its security boundaries
worth stating precisely. The full design-level security model is in
[SMART-CHECK.md § Security](SMART-CHECK.md#security); this file is about reporting.

## Supported versions

Only the latest release on `master` is supported. There is no backporting.

## What counts as a vulnerability here

Please report anything that breaks the tool's stated guarantees, especially:

- **Injection-target escape** — any way the monitor can be made to type into something
  other than the Claude Code TUI (a shell, another app), i.e. a bypass of the
  foreground-process gate.
- **Attacker-controlled keystrokes** — any way pane content, state files, or config
  parsing can cause the monitor to type text an attacker chose, rather than the user's
  own fixed config strings / Escape / arrow keys.
- **Network activity** — the tool claims zero network access; any code path that opens a
  socket is a bug of the highest severity.
- **Cross-user impact** — any way one user's monitor/state can affect another user's
  session (state files are meant to be same-user only).
- **Install-time surprises** — the install steps modifying anything beyond the documented
  files (`~/.bashrc`/`~/.zshrc` marker block, the StopFailure hook entry in
  `~/.claude/settings.json`, systemd `--user` units, `~/.claude-auto-retry/`).

## Known, accepted limitations (not vulnerabilities)

- **Trigger spoofing:** pane text is untrusted; content that *displays* a fake downgrade
  or rate-limit banner can trigger the predefined action sequences (interrupt, model
  switch, nudge, halt). The blast radius is limited to those fixed actions inside the
  Claude TUI. This is inherent to screen-scraping and documented; mitigations that
  tighten matching are welcome as hardening PRs.
- **Same-user local processes** can write the control markers or config — there is no
  privilege boundary between a user and their own automation. Protecting against an
  attacker who already runs code as your user is out of scope.
- The nudge/rephrase messages are ordinary prompts and consume the user's plan.

## How to report

Use **GitHub's private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability"). Please include the Claude Code version,
tmux version, and a pane capture or transcript demonstrating the issue. Do not open a
public issue for anything exploitable before a fix lands.

Best-effort response by a solo maintainer; fixes for confirmed boundary breaks
(injection-target escape, attacker-controlled keystrokes, network activity) take priority
over everything else in the project.
