# shellcheck shell=sh
# [local] Shared helpers for the macOS/Linux scripts in this folder (sourced; POSIX sh).
# The calling script sets SCRIPT_DIR first. Machine settings come from the config file
# (see config.template.jsonc), read through lib/serverctl.mjs, which the Windows scripts
# use too.
#
# Globals each script initialises (never taken from the environment) before calling these:
# INSTANCE (live|staging), PORT (empty until load_config), CONFIG (empty = default),
# FORCE (1 = do not ask).

CLONE_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)
SERVERCTL="$SCRIPT_DIR/lib/serverctl.mjs"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js was not found on PATH. Install it (see package.json \"engines\") and try again."
}

# ctl <command> [args...]: runs the helper, adding --config when one was given.
ctl() {
  _ctl_command=$1
  shift
  if [ -n "$CONFIG" ]; then
    node "$SERVERCTL" "$_ctl_command" --config "$CONFIG" "$@"
  else
    node "$SERVERCTL" "$_ctl_command" "$@"
  fi
}

# Sets CFG_* (machine config) and INST_* (the chosen instance), then PORT and CONFIG.
load_config() {
  if [ -n "$PORT" ]; then
    _cfg=$(ctl config --instance "$INSTANCE" --port "$PORT" --format sh) || exit $?
  else
    _cfg=$(ctl config --instance "$INSTANCE" --format sh) || exit $?
  fi
  eval "$_cfg"
  PORT=$INST_PORT
  CONFIG=$CFG_CONFIG_PATH
}

# PIDs listening on TCP port $1, one per line (nothing when they cannot be seen).
listener_pids() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
  elif command -v ss >/dev/null 2>&1; then
    ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  fi
}

is_cloudcli_pid() {
  ps -o args= -p "$1" 2>/dev/null | grep -Eq 'node.*cli\.js"? +start'
}

# Sets SERVER_PIDS (CloudCLI servers: node ... cli.js start) and FOREIGN_PIDS (anything else)
# for port $1. A listener whose PID cannot be seen counts as foreign ("unknown").
port_owner() {
  SERVER_PIDS=
  FOREIGN_PIDS=
  for _pid in $(listener_pids "$1"); do
    if is_cloudcli_pid "$_pid"; then
      SERVER_PIDS="$SERVER_PIDS $_pid"
    else
      FOREIGN_PIDS="$FOREIGN_PIDS $_pid"
    fi
  done
  SERVER_PIDS=${SERVER_PIDS# }
  FOREIGN_PIDS=${FOREIGN_PIDS# }
  if [ -z "$SERVER_PIDS" ] && [ -z "$FOREIGN_PIDS" ] && ctl port-open --instance "$INSTANCE" --port "$1"; then
    FOREIGN_PIDS=unknown
  fi
}

# log <message>: appends a timestamped line to LOG_FILE and echoes it.
log() {
  _line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  mkdir -p "$(dirname "$LOG_FILE")"
  printf '%s\n' "$_line" >>"$LOG_FILE"
  printf '%s\n' "$_line"
}

# confirm_active_work <Action>: if work is running, show it and ask (or refuse without a terminal).
confirm_active_work() {
  ctl work --instance "$INSTANCE" --port "$PORT" --action "$(printf '%s' "$1" | tr 'A-Z' 'a-z')" && return 0
  if [ "$FORCE" = 1 ]; then
    echo '--force given: continuing anyway.'
    return 0
  fi
  if [ -t 0 ]; then
    printf '%s anyway? [y/N] ' "$1"
    read -r _answer
    case $_answer in y | Y | yes | YES) return 0 ;; esac
    return 1
  fi
  echo 'Not asking (no terminal). Wait and try again, or add --force.'
  return 1
}

# Stops the CloudCLI server on PORT, and only that: refuses when another program holds it.
stop_cloudcli() {
  port_owner "$PORT"
  if [ -n "$FOREIGN_PIDS" ]; then
    log "ERROR: port $PORT is held by PID $FOREIGN_PIDS, which is not CloudCLI (or cannot be identified: install lsof); not stopping it"
    return 1
  fi
  if [ -z "$SERVER_PIDS" ]; then
    log "nothing is listening on port $PORT"
    return 0
  fi
  for _pid in $SERVER_PIDS; do
    log "stopping PID $_pid"
    kill "$_pid" 2>/dev/null
  done
  _i=0
  while [ "$_i" -lt 30 ]; do
    ctl port-open --instance "$INSTANCE" --port "$PORT" || return 0
    # shellcheck disable=SC2086
    [ "$_i" -eq 15 ] && kill -9 $SERVER_PIDS 2>/dev/null
    sleep 1
    _i=$((_i + 1))
  done
  log "ERROR: port $PORT is still in use"
  return 1
}

# spawn_detached <log> <command> [args...]: runs it in its own session (survives the caller,
# e.g. a chat inside the server it restarts), output appended to the log.
spawn_detached() {
  _spawn_log=$1
  shift
  node "$SERVERCTL" spawn-detached --log "$_spawn_log" --cwd "$HOME" -- "$@"
}

# Autostart names derived from the config's autostartName.
launchd_label() { printf 'local.%s' "$CFG_AUTOSTART_NAME" | tr 'A-Z' 'a-z'; }
launchd_plist() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(launchd_label)"; }
systemd_unit() { printf '%s.service' "$CFG_AUTOSTART_NAME" | tr 'A-Z' 'a-z'; }
systemd_unit_file() { printf '%s/systemd/user/%s' "${XDG_CONFIG_HOME:-$HOME/.config}" "$(systemd_unit)"; }

# on | off | disabled (registered but switched off) | unsupported
autostart_state() {
  case $(uname -s) in
    Darwin)
      [ -f "$(launchd_plist)" ] || { echo off; return; }
      if launchctl print-disabled "gui/$(id -u)" 2>/dev/null | grep -Eq "\"$(launchd_label)\" => (true|disabled)"; then
        echo disabled
      else
        echo on
      fi
      ;;
    Linux)
      [ -f "$(systemd_unit_file)" ] || { echo off; return; }
      if systemctl --user is-enabled "$(systemd_unit)" >/dev/null 2>&1; then echo on; else echo disabled; fi
      ;;
    *) echo unsupported ;;
  esac
}
