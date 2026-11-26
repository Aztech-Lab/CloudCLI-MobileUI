#!/bin/sh
# [local] Restart CloudCLI-MobileUI: stop -> (optionally activate a prepared build) -> start.
# Progress goes to <logs>/restart.log (restart-staging.log for the test portal).
#
#   restart.sh                     restart now (asks first if work is running)
#   restart.sh --deploy            also make <runtime>.next (from deploy.sh) the running build;
#                                  the previous one is kept in the backups folder
#   restart.sh --detach --delay 30 run detached after 30 s. Use this whenever the caller runs
#                                  INSIDE the server (e.g. a chat in CloudCLI): the restart
#                                  then survives the server going down.
#   --staging  the test portal instead.  --force  do not ask about running work.
#   --local    listen on 127.0.0.1 only.  --port N, --config FILE
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
DELAY=
DEPLOY_FLAG=
LOCAL_FLAG=
DETACH=0
while [ $# -gt 0 ]; do
  case $1 in
    --delay) DELAY=$2; shift ;;
    --deploy) DEPLOY_FLAG=--deploy ;;
    --staging) INSTANCE=staging ;;
    --local) LOCAL_FLAG=--local ;;
    --port) PORT=$2; shift ;;
    --force) FORCE=1 ;;
    --detach) DETACH=1 ;;
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
STAGING_FLAG=
[ "$INSTANCE" = staging ] && STAGING_FLAG=--staging

if [ "$FORCE" != 1 ]; then
  confirm_active_work Restart || exit 2
fi

if [ "$DETACH" = 1 ]; then
  # shellcheck disable=SC2086
  _pid=$(spawn_detached "$INST_RESTART_LOG" /bin/sh "$SCRIPT_DIR/restart.sh" --force --delay "$DELAY" \
    --port "$PORT" --config "$CONFIG" $STAGING_FLAG $LOCAL_FLAG $DEPLOY_FLAG) || die 'Could not start the detached restart.'
  echo "Restart of port $PORT scheduled in $DELAY s (detached, PID $_pid). Progress: $INST_RESTART_LOG"
  exit 0
fi

LOG_FILE=$INST_RESTART_LOG
log "restart requested (delay=${DELAY}s, port=$PORT, local=${LOCAL_FLAG:-no}, deploy=${DEPLOY_FLAG:-no})"
[ "$DELAY" -gt 0 ] && sleep "$DELAY"

if ! stop_cloudcli; then
  log 'restart aborted'
  exit 1
fi

if [ -n "$DEPLOY_FLAG" ]; then
  ctl activate --instance "$INSTANCE" --port "$PORT" ||
    log 'ERROR: activating the new build failed; starting what is there'
fi

log "starting CloudCLI (log: $INST_SERVER_LOG)"
# shellcheck disable=SC2086
if /bin/sh "$SCRIPT_DIR/start.sh" --port "$PORT" --config "$CONFIG" $STAGING_FLAG $LOCAL_FLAG; then
  log 'restart done: server is up'
else
  _code=$?
  log "ERROR: start failed (exit $_code); see $INST_SERVER_LOG"
  exit "$_code"
fi
