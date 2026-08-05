#!/usr/bin/env bash
# The background heartbeat: poll GitHub and the agents, reap what has landed, and
# regenerate the dashboard — on a loop, without a model in the way.
#
#   watch.sh --start [--interval 120]   # background, survives this shell
#   watch.sh --stop
#   watch.sh --status
#   watch.sh --once                     # one cycle in the foreground
#
# Each cycle: poll.sh → autoreap.sh → render-board.sh. Output goes to watch.log, and
# anything notable (a PR changing state, a workspace reaped) is appended to
# events.log, which is the short file worth reading.

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

PIDFILE="$BOARD_DIR/watch.pid"
LOG="$BOARD_DIR/watch.log"
EVENTS="$BOARD_DIR/events.log"
INTERVALFILE="$BOARD_DIR/watch.interval"
# --start may override the configured cadence, so remember what is actually running.
# Without this, --status reported the default and computed its staleness threshold
# from a number the daemon was not using.
if [ -f "$INTERVALFILE" ]; then
  interval="$(cat "$INTERVALFILE")"
else
  interval="$(cfg '.cadence.watchSeconds' 120)"
fi

cycle() {
  local stamp; stamp="$(now)"
  # poll.sh prints its own delta section; keep the whole thing in watch.log and lift
  # only the interesting lines into events.log.
  local out; out="$("$SKILL_DIR/scripts/poll.sh" 2>&1 || true)"
  printf '\n──── %s ────\n%s\n' "$stamp" "$out" >> "$LOG"

  printf '%s\n' "$out" | sed -n '/── Deltas since last poll/,$p' | grep -E '^  [A-Za-z]' \
    | sed "s|^|$stamp  |" >> "$EVENTS" || true
  printf '%s\n' "$out" | sed -n '/── Agents/,/── Workspaces/p' | grep -E 'NEEDS-OPERATOR|blocked=' \
    | sed "s|^|$stamp  needs-operator:|" >> "$EVENTS" || true

  local synced; synced="$("$SKILL_DIR/scripts/sync.sh" 2>&1 || true)"
  if [ -n "$synced" ]; then
    printf '%s\n' "$synced" >> "$LOG"
    # `stray:` and `drift:` are standing conditions, true every cycle until someone
    # acts. events.log is for things that just changed — appending them each minute
    # buries the state transitions it exists to record. They stay in watch.log.
    printf '%s\n' "$synced" | grep -vE '^  (stray|drift):' | sed "s|^|$stamp  |" >> "$EVENTS" || true
  fi

  local reap; reap="$("$SKILL_DIR/scripts/autoreap.sh" --quiet 2>&1 || true)"
  if [ -n "$reap" ]; then
    printf '%s\n' "$reap" >> "$LOG"
    printf '%s\n' "$reap" | sed "s|^|$stamp  |" >> "$EVENTS"
  fi

  "$SKILL_DIR/scripts/render-board.sh" >> "$LOG" 2>&1 || true
}

case "${1---status}" in
  --once) cycle; printf 'one cycle done — see %s\n' "$EVENTS" ;;

  --start)
    shift
    [ "${1-}" = "--interval" ] && { interval="$2"; shift 2; }
    # One poller per project, each with its own pidfile, log and watchdog inside
    # its own board directory. Separate processes are the failure isolation: a
    # project whose cycle hangs cannot stop any other project from polling.
    if [ "${1-}" = "--all" ]; then
      for k in $(jq -r '.repos[]? | .key // (.name|ascii_downcase|gsub("[^a-z0-9]+";"-"))' "$CONFIG"); do
        SUPERSET_ORCH_PROJECT="$k" "$SKILL_DIR/scripts/watch.sh" --start --interval "$interval" \
          | sed "s/^/[$k] /"
      done
      exit 0
    fi
    printf '%s' "$interval" > "$INTERVALFILE"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      die "already watching (pid $(cat "$PIDFILE")) — stop it first"
    fi
    mkdir -p "$BOARD_DIR"
    # Call `--once`, which runs cycle(), rather than re-listing the steps here.
    # The first version inlined them and silently skipped the two things only cycle()
    # does — the events.log extraction and the cycle markers — so the loop ran for
    # half an hour producing a log with no cycles in it and no events file at all.
    # One definition of a cycle, used by both paths.
    # A cycle is bounded. One hung `--once` used to wedge the loop indefinitely —
    # the process stayed alive, `--status` cheerfully reported "watching", and the
    # board silently froze for twelve hours while PRs merged underneath it. macOS
    # ships no `timeout`, so the watchdog is a background sleeper that kills the
    # cycle's whole process group if it overruns.
    # Between full cycles the loop watches the status inbox locally. An agent
    # writing its status is the one signal that costs nothing to detect — no API,
    # no quota — so agent state lands in about 5s instead of waiting out the
    # interval. Only sync and render run on that path: nothing network touches it.
    nohup env SUPERSET_ORCH_PROJECT="$PROJECT_KEY" bash -c '
      cap='"$((interval * 3))"'
      inbox="'"$WORKSPACES_DIR"'"
      seen=""
      while true; do
        "'"$SKILL_DIR"'/scripts/watch.sh" --once >/dev/null 2>&1 &
        cyc=$!
        ( sleep "$cap"; kill -9 "$cyc" 2>/dev/null ) >/dev/null 2>&1 &
        dog=$!
        wait "$cyc" 2>/dev/null
        kill "$dog" 2>/dev/null    # cycle finished first; retire the watchdog

        waited=0
        while [ "$waited" -lt '"$interval"' ]; do
          sleep 5; waited=$((waited + 5))
          now="$(ls -l "$inbox"/*.json 2>/dev/null | md5 2>/dev/null || echo x)"
          if [ -n "$seen" ] && [ "$now" != "$seen" ]; then
            "'"$SKILL_DIR"'/scripts/sync.sh"          >/dev/null 2>&1 || true
            "'"$SKILL_DIR"'/scripts/render-board.sh"  >/dev/null 2>&1 || true
          fi
          seen="$now"
        done
      done' >/dev/null 2>&1 &
    echo $! > "$PIDFILE"
    disown 2>/dev/null || true
    printf 'watching every %ss (pid %s)\n  log:    %s\n  events: %s\n  board:  %s\n' \
      "$interval" "$(cat "$PIDFILE")" "$LOG" "$EVENTS" "$BOARD_DIR/board.html"
    ;;

  --stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE" "$INTERVALFILE" && printf 'stopped\n'
    else
      rm -f "$PIDFILE" "$INTERVALFILE"; printf 'not running\n'
    fi
    ;;

  --status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      # A live pid is not a working watcher. Judge it by when it last wrote,
      # not by whether the process exists — that distinction cost twelve hours.
      if [ -f "$LOG" ]; then
        age=$(( $(date +%s) - $(stat -f %m "$LOG" 2>/dev/null || stat -c %Y "$LOG") ))
        if [ "$age" -gt $(( interval * 3 )) ]; then
          printf 'STALLED — pid %s is alive but has not written for %sm (interval %ss)\n' \
            "$(cat "$PIDFILE")" "$((age / 60))" "$interval"
          printf '  a cycle is probably hung; restart with: watch.sh --stop && watch.sh --start\n'
        else
          printf 'watching (pid %s, every %ss)\n' "$(cat "$PIDFILE")" "$interval"
        fi
      else
        printf 'watching (pid %s, every %ss) — no log yet\n' "$(cat "$PIDFILE")" "$interval"
      fi
      # `if`, not a trailing `[ ] && cmd` — under `set -e` a false test as the last
      # statement makes the script exit 1, which reads as "the watcher is broken".
      if [ -f "$LOG" ]; then printf '  last cycle: %s\n' "$(date -u -r "$LOG" +%H:%M:%SZ)"; fi
      if [ -f "$EVENTS" ]; then printf '  recent events:\n'; tail -6 "$EVENTS" | sed 's/^/    /'; fi
    else
      printf 'not watching — start with: watch.sh --start\n'
    fi
    ;;

  *) die "usage: watch.sh --start [--interval N] | --stop | --status | --once" ;;
esac
