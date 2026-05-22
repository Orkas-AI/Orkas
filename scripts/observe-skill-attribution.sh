#!/usr/bin/env bash
# observe-skill-attribution.sh
#
# One-shot e2e verifier for the skill-attribution signals
# (skill_advertised / skill_invoked / agent_dispatched + the turn_id JOIN
# guarantee from docs/plans/expert-signals-skill-attribution.md §3.4).
#
# Usage:
#   PC/scripts/observe-skill-attribution.sh [<expected-skill-id>] [<timeout-seconds>]
#
# Defaults: skill_id = e2e-test-skill, timeout = 180s.
# Exits 0 on PASS (both expected signals seen with matching turn_id),
# 1 on FAIL (timeout / mismatch). Designed for manual run: print every
# matched signal as it lands so the operator can see the wire is alive.
#
# Requires: jq. macOS / Linux. Reads $ORKAS_DATA_ROOT or defaults to
# ~/.orkas/data.

set -u

EXPECTED_SKILL="${1:-e2e-test-skill}"
TIMEOUT_SEC="${2:-180}"
DATA="${ORKAS_DATA_ROOT:-$HOME/.orkas/data}"

if ! command -v jq >/dev/null 2>&1; then
  echo "❌ jq not on PATH — install jq first." >&2
  exit 2
fi

USERS_FILE="$DATA/users.json"
if [[ ! -f "$USERS_FILE" ]]; then
  echo "❌ users.json not found at $USERS_FILE — is the app installed?" >&2
  exit 2
fi

UID_VAL=$(jq -r .current_user_id "$USERS_FILE")
TODAY=$(date +%Y-%m-%d)
SIGFILE="$DATA/$UID_VAL/local/signals/$TODAY.jsonl"

mkdir -p "$(dirname "$SIGFILE")"
touch "$SIGFILE"

# Snapshot current line count so we ignore historical signals — `tail -n +N`
# starts streaming from line N, so we want the next-after-current line.
BASELINE=$(wc -l < "$SIGFILE" | tr -d ' ')
NEXT_LINE=$((BASELINE + 1))

echo "──────────────────────────────────────────────────────────"
echo "Skill attribution e2e watch"
echo "  uid:            $UID_VAL"
echo "  sigfile:        $SIGFILE"
echo "  baseline lines: $BASELINE  (will read from line $NEXT_LINE)"
echo "  expected skill: $EXPECTED_SKILL"
echo "  timeout:        ${TIMEOUT_SEC}s"
echo "──────────────────────────────────────────────────────────"
echo "→ Send your test message in the app now."
echo

# State accumulated across the stream.
ADVERTISED_TURN=""    # turn_id of the skill_advertised matching EXPECTED
INVOKED_TURN=""       # turn_id of the skill_invoked matching EXPECTED

# Pure polling — no tail / FIFO. macOS tail's `-n +N` + `-F` interaction is
# unreliable when N is past EOF (BSD tail exits instantly), and even when
# it works the FIFO + fd-3 dance has multiple race-condition tripwires.
# `wc -l` + `sed -n A,B p` against an append-only jsonl is straightforward.
LAST_LINE=$BASELINE
DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))

process_line() {
  local line="$1"
  [[ -z "$line" ]] && return
  local type
  type=$(jq -r 'try .type catch ""' <<<"$line" 2>/dev/null || echo "")
  case "$type" in
    skill_advertised|skill_invoked|agent_dispatched)
      jq -c '{type, turn_id, aid, delta}' <<<"$line"
      ;;
    *)
      return
      ;;
  esac

  case "$type" in
    skill_advertised)
      if jq -e --arg id "$EXPECTED_SKILL" \
            '.delta.skill_ids // [] | any(. == $id)' <<<"$line" >/dev/null; then
        ADVERTISED_TURN=$(jq -r .turn_id <<<"$line")
        echo "  ✓ advertised matched on turn_id=$ADVERTISED_TURN"
      fi
      ;;
    skill_invoked)
      if jq -e --arg id "$EXPECTED_SKILL" \
            '.delta.skill_id == $id' <<<"$line" >/dev/null; then
        INVOKED_TURN=$(jq -r .turn_id <<<"$line")
        echo "  ✓ invoked    matched on turn_id=$INVOKED_TURN"
      fi
      ;;
  esac
}

while (( $(date +%s) < DEADLINE )); do
  CUR_LINE=$(wc -l < "$SIGFILE" 2>/dev/null | tr -d ' ')
  CUR_LINE=${CUR_LINE:-0}
  if (( CUR_LINE > LAST_LINE )); then
    # Read only the new slice into the loop. `< <(sed …)` is a process
    # substitution so the variable assignments inside survive (a piped
    # `sed | while` would run the loop in a subshell and discard them).
    while IFS= read -r batched_line; do
      process_line "$batched_line"
      # PASS condition: both seen on the SAME turn_id. This proves the
      # JOIN guarantee (plan §3.4): advertising + invocation come from the
      # same agent turn, so the patch suggester can group-by turn_id and
      # correctly attribute the LLM's behaviour.
      if [[ -n "$ADVERTISED_TURN" && -n "$INVOKED_TURN" ]]; then
        if [[ "$ADVERTISED_TURN" == "$INVOKED_TURN" ]]; then
          echo
          echo "✅ PASS — both signals on turn_id=$ADVERTISED_TURN"
          echo "   • skill_advertised system=A.custom contains '$EXPECTED_SKILL'"
          echo "   • skill_invoked    system=A.custom skill_id='$EXPECTED_SKILL'"
          echo "   • turn_id matches → cross-signal JOIN works."
          exit 0
        else
          echo
          echo "❌ FAIL — turn_id mismatch."
          echo "   advertised.turn_id = $ADVERTISED_TURN"
          echo "   invoked.turn_id    = $INVOKED_TURN"
          echo "   Possible cause: buffer drained twice, or drain ran on the"
          echo "   wrong actor's msg id (check bus.ts persistedMsg capture)."
          exit 1
        fi
      fi
    done < <(sed -n "$((LAST_LINE + 1)),${CUR_LINE}p" "$SIGFILE")
    LAST_LINE=$CUR_LINE
  fi
  sleep 0.5
done

echo
echo "❌ TIMEOUT — neither expected signal arrived in ${TIMEOUT_SEC}s."
[[ -n "$ADVERTISED_TURN" ]] && echo "   (saw advertised, missing invoked)"
[[ -n "$INVOKED_TURN"   ]] && echo "   (saw invoked, missing advertised)"
exit 1
