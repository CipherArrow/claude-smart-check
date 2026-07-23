#!/bin/sh
# smartcheck-probe: verify the /model and /effort behaviors smart-check depends on.
#
# Run this YOURSELF (it drives a scratch claude session with your credentials):
#   sh bin/smartcheck-probe.sh
#
# It checks, in a throwaway tmux session:
#   1. Does `/model Opus 4.8` apply directly (prints "Set model to Opus 4.8") or open a picker?
#   2. Does `/effort Max` apply directly (prints "Set effort level to max") or cycle/menu?
#   3. Exact confirmation wording/casing (compare with smartCheck.*.confirm in ~/.claude-auto-retry.json)
# and then restores Fable 5 + High and kills the scratch session.
#
# If any confirmation wording differs from the config, edit ~/.claude-auto-retry.json —
# no code changes needed. Slash commands are handled locally by Claude Code (no API tokens).

set -u
S=smartcheck-probe-$$

send() {  # send literal text then Enter after a settle (mirrors the monitor's sendCommand)
  tmux send-keys -t "$S" -l "$1"
  sleep 0.4
  tmux send-keys -t "$S" Enter
}

capture() { tmux capture-pane -t "$S" -p | grep -v '^ *$' | tail -12; }

echo "Starting scratch claude in tmux session $S (dir: $HOME)..."
tmux new-session -d -s "$S" -x 180 -y 45 -c "$HOME" 'command claude' || { echo "tmux failed"; exit 1; }
sleep 8

# First-run trust prompt: never auto-confirm a security dialog — show it and let the
# human decide.
if tmux capture-pane -t "$S" -p | grep -q 'Is this a project you created or one you trust'; then
  echo
  echo "Claude Code is showing its folder-trust prompt for: $HOME"
  echo "Press Enter to confirm YOU trust it (or Ctrl-C to abort the probe):"
  read -r _
  tmux send-keys -t "$S" Enter
  sleep 5
fi

echo; echo "=== initial screen ==="; capture

echo; echo "--- probe 1: /model claude-opus-4-8 ---"
send '/model claude-opus-4-8'; sleep 3
capture
echo '(expect: "Set model to Opus 4.8". Probed 2026-07-22: display names are REJECTED'
echo ' ("Model '\''Fable 5'\'' not found") — only IDs/aliases work as the argument.)'

echo; echo "--- probe 2: /effort Max ---"
send '/effort Max'; sleep 3
capture
echo '(expect: "Set effort level to max". If nothing/cycling happened, bare /effort cycling is the fallback.)'

echo; echo "--- restore: /model claude-fable-5[1m] + /effort High ---"
send '/model claude-fable-5[1m]'; sleep 3
send '/effort High'; sleep 3
capture

echo; echo "Press Enter to kill the scratch session (or Ctrl-C to keep it and inspect: tmux attach -t $S)"
read -r _
tmux kill-session -t "$S" 2>/dev/null
echo "Done. If any wording differed, update the confirm/pickerOption strings in ~/.claude-auto-retry.json."
