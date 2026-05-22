#!/usr/bin/env bash
#
# watch-signals.sh — tail today's expert-signals jsonl in real time.
#
# Usage:
#   ./scripts/watch-signals.sh
#   ORKAS_DATA=/custom/path ./scripts/watch-signals.sh
#
# Tails `<ORKAS_DATA>/<uid>/local/signals/<yyyy-mm-dd>.jsonl` and pretty-
# prints each new signal as a compact line. ORKAS_DATA defaults to
# ~/.orkas/data.
#
# Requires: jq (brew install jq | apt install jq).

set -u

DATA_ROOT="${ORKAS_DATA:-$HOME/.orkas/data}"
USERS_FILE="$DATA_ROOT/users.json"

# ── Preflight ──────────────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required. Install it first:" >&2
  echo "  macOS:  brew install jq" >&2
  echo "  Linux:  apt install jq" >&2
  exit 1
fi

if [[ ! -f "$USERS_FILE" ]]; then
  echo "ERROR: users.json not found at $USERS_FILE" >&2
  echo "       Launch the app at least once, or set ORKAS_DATA=<your data root>." >&2
  exit 1
fi

ACTIVE_UID=$(jq -r .current_user_id "$USERS_FILE" 2>/dev/null)
if [[ -z "$ACTIVE_UID" || "$ACTIVE_UID" == "null" ]]; then
  echo "ERROR: current_user_id missing in $USERS_FILE" >&2
  exit 1
fi

DAY=$(date +%Y-%m-%d)
SIG_DIR="$DATA_ROOT/$ACTIVE_UID/local/signals"
SIG_FILE="$SIG_DIR/$DAY.jsonl"

mkdir -p "$SIG_DIR"
touch "$SIG_FILE"

# ── Header ─────────────────────────────────────────────────────────────
echo "uid:      $ACTIVE_UID"
echo "signals:  $SIG_FILE"
echo "size:     $(wc -c < "$SIG_FILE" | tr -d ' ') bytes"
echo
echo "=== streaming new signals (Ctrl+C to stop) ==="
echo "    legend: accept=GREEN  correction/reject/tool_failure=RED  other=YELLOW"
echo

# ── Stream + colourize by type ─────────────────────────────────────────
# `-n 0` skips the existing file content; only NEW lines after script
# start are printed. Use `tail -F` (capital) to follow rotation if the
# date rolls over mid-watch.
tail -F -n 0 "$SIG_FILE" 2>/dev/null | while IFS= read -r line; do
  # Compact view: time, type, aid (commander when null), turn prefix, metadata
  pretty=$(printf '%s' "$line" | jq -c '{
    ts: .ts[11:19],
    type,
    aid: (.aid // "commander"),
    turn: (.turn_id[:12]),
    meta: (.metadata // {}),
  }' 2>/dev/null) || pretty="$line"

  case "$(printf '%s' "$line" | jq -r .type 2>/dev/null)" in
    accept) color="32" ;;                                # green
    correction|reject|tool_failure) color="31" ;;        # red
    *) color="33" ;;                                     # yellow
  esac
  printf "\033[%sm%s\033[0m\n" "$color" "$pretty"
done
