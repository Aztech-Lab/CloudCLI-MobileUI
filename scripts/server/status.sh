#!/bin/sh
# [local] Show whether CloudCLI-MobileUI runs: PID, port, build, running work, autostart.
#
#   status.sh             the live server       status.sh --staging   the test portal
#   status.sh --json      machine-readable (used by the settings page)
#   options: --port N, --config FILE
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
FORMAT=text
while [ $# -gt 0 ]; do
  case $1 in
    --staging) INSTANCE=staging ;;
    --json) FORMAT=json ;;
    --port) PORT=$2; shift ;;
    --config) CONFIG=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"
need_node
load_config
port_owner "$PORT"
AUTOSTART=n/a
[ "$INSTANCE" = live ] && AUTOSTART=$(autostart_state)

set -- --instance "$INSTANCE" --port "$PORT" --autostart "$AUTOSTART" --format "$FORMAT"
_first_server=${SERVER_PIDS%% *}
_first_foreign=${FOREIGN_PIDS%% *}
[ -n "$_first_server" ] && set -- "$@" --pid "$_first_server"
case $_first_foreign in '' | unknown) ;; *) set -- "$@" --foreign-pid "$_first_foreign" ;; esac
ctl status "$@"
