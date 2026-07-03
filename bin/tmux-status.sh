#!/usr/bin/env bash
# tmux status-bar segment for claude-auto-retry.
# Usage in ~/.tmux.conf: #(~/.local/lib/node_modules/claude-auto-retry/bin/tmux-status.sh '#{pane_id}')
#
# Prints nothing if the pane has no monitor, or the monitor's status file is stale
# (monitor process died without cleaning up — e.g. `kill -9`, machine sleep during a
# tmux-server-less state). Kept dependency-free (no jq/node) so this can run every
# few seconds from every attached client without noticeable cost.

pane="$1"
[ -z "$pane" ] && exit 0

safe=$(printf '%s' "$pane" | tr -c 'A-Za-z0-9_-' '_')
file="$HOME/.claude-auto-retry/status/${safe}.json"
[ -f "$file" ] || exit 0

json=$(cat "$file" 2>/dev/null) || exit 0
status=$(printf '%s' "$json" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
updated=$(printf '%s' "$json" | grep -o '"updatedAt":[0-9]*' | head -1 | grep -o '[0-9]*')
[ -z "$status" ] || [ -z "$updated" ] && exit 0

now=$(date +%s)
age=$(( now - updated ))
# Stale = monitor crashed/orphaned without cleanup. Hide rather than show a stuck icon.
[ "$age" -gt 30 ] && exit 0

case "$status" in
  waiting)
    waitUntil=$(printf '%s' "$json" | grep -o '"waitUntil":[0-9]*' | head -1 | grep -o '[0-9]*')
    remain=$(( waitUntil - now ))
    [ "$remain" -lt 0 ] && remain=0
    if [ "$remain" -ge 3600 ]; then
      printf '⏳AR %dh%02dm' $(( remain / 3600 )) $(( (remain % 3600) / 60 ))
    else
      printf '⏳AR %dm' $(( remain / 60 ))
    fi
    ;;
  overload)
    overloadWaitUntil=$(printf '%s' "$json" | grep -o '"overloadWaitUntil":[0-9]*' | head -1 | grep -o '[0-9]*')
    remain=$(( overloadWaitUntil - now ))
    [ "$remain" -lt 0 ] && remain=0
    printf '🟠AR %ds' "$remain"
    ;;
  monitoring)
    printf '🟢AR'
    ;;
  *)
    exit 0
    ;;
esac
