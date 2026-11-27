#!/bin/sh
# [local] Stop CloudCLI-MobileUI: only the CloudCLI server listening on the configured port;
# refuses when another program holds the port. Asks first if work is running.
#
#   stop.sh                      stop the live server
#   stop.sh --staging            stop the test portal
#   stop.sh --force              do not ask about running work
#   stop.sh --detach --delay 5   run detached (when called from inside the server)
#   options: --port N, --config FILE
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
DELAY=
DETACH=0
while [ $# -gt 0 ]; do
  case $1 in
    --staging) INSTANCE=staging ;;
    --port) PORT=$2; shift ;;
    --force) FORCE=1 ;;
    --detach) DETACH=1 ;;
    --delay) DELAY=$2; shift ;;
    --config) CONFIG=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"
need_node
load_config
if [ -z "$DELAY" ]; then
  DELAY=0
  [ "$DETACH" = 1 ] && DELAY=5
fi

if [ "$FORCE" != 1 ]; then
  confirm_active_work Stop || exit 2
fi

if [ "$DETACH" = 1 ]; then
  STAGING_FLAG=
  [ "$INSTANCE" = staging ] && STAGING_FLAG=--staging
  # shellcheck disable=SC2086
  _pid=$(spawn_detached "$INST_RESTART_LOG" /bin/sh "$SCRIPT_DIR/stop.sh" --force --delay "$DELAY" \
    --port "$PORT" --config "$CONFIG" $STAGING_FLAG) || die 'Could not start the detached stop.'
  echo "Stop of port $PORT scheduled in $DELAY s (detached, PID $_pid). Log: $INST_RESTART_LOG"
  exit 0
fi

LOG_FILE=$INST_RESTART_LOG
log "stop requested (delay=${DELAY}s, port=$PORT)"
[ "$DELAY" -gt 0 ] && sleep "$DELAY"
if stop_cloudcli; then
  log 'stopped'
  exit 0
fi
exit 1
