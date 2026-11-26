#!/bin/sh
# [local] Start CloudCLI-MobileUI from the deployed runtime (see config.template.jsonc).
#
#   start.sh                start in the background, log to <logs>/cloudcli.log
#   start.sh --foreground   run in this terminal (Ctrl+C stops it)
#   start.sh --local        listen on 127.0.0.1 only, whatever the config says
#   start.sh --staging      the test portal (stagingPort, its own build and database copy)
#   options: --port N, --config FILE, --wait SECONDS (how long the background start waits)
#
# --service is the background process itself (used by the background start and by
# autostart): it runs the server with its output appended to the log.
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
MODE=background
LOCAL_FLAG=
WAIT=90
while [ $# -gt 0 ]; do
  case $1 in
    --staging) INSTANCE=staging ;;
    --local) LOCAL_FLAG=--local ;;
    --port) PORT=$2; shift ;;
    --config) CONFIG=$2; shift ;;
    --foreground) MODE=foreground ;;
    --service) MODE=service ;;
    --wait) WAIT=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"
need_node
load_config

[ -f "$INST_CLI" ] || die "No build to run at $INST_RUNTIME. Run setup.sh, or deploy.sh and then restart.sh --deploy."

port_owner "$PORT"
if [ -n "$SERVER_PIDS" ]; then
  echo "CloudCLI is already running on port $PORT (PID $SERVER_PIDS)."
  exit 0
fi
[ -z "$FOREIGN_PIDS" ] || die "Port $PORT is in use by PID $FOREIGN_PIDS; not starting."

if [ "$MODE" != background ]; then
  _env=$(ctl env --instance "$INSTANCE" --port "$PORT" $LOCAL_FLAG --format sh) || exit 1
  eval "$_env"
  label='CloudCLI-MobileUI'
  [ "$INSTANCE" = staging ] && label='CloudCLI-MobileUI TEST'
  # Not the runtime folder, so a new build can be swapped in there.
  cd "$HOME" || exit 1
  if [ "$MODE" = service ]; then
    mkdir -p "$(dirname "$INST_SERVER_LOG")"
    # Keep the log from growing without bound: one previous file is kept.
    if [ -f "$INST_SERVER_LOG" ] && [ "$(wc -c <"$INST_SERVER_LOG")" -gt 20971520 ]; then
      mv -f "$INST_SERVER_LOG" "$INST_SERVER_LOG.1"
    fi
    printf '===== %s start: %s on %s:%s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$label" "$HOST" "$PORT" >>"$INST_SERVER_LOG"
    exec node "$INST_CLI" start --port "$PORT" >>"$INST_SERVER_LOG" 2>&1
  fi
  echo "$label -> http://$HOST:$PORT  (Ctrl+C to stop)"
  exec node "$INST_CLI" start --port "$PORT"
fi

# Background: a detached copy of this script in --service mode runs the server.
STAGING_FLAG=
[ "$INSTANCE" = staging ] && STAGING_FLAG=--staging
# shellcheck disable=SC2086
spawn_detached "$INST_SERVER_LOG" /bin/sh "$SCRIPT_DIR/start.sh" --service --port "$PORT" --config "$CONFIG" $STAGING_FLAG $LOCAL_FLAG >/dev/null ||
  die 'Could not start the server process.'
echo "Starting CloudCLI on port $PORT in the background (log: $INST_SERVER_LOG) ..."
if ! ctl wait-health --instance "$INSTANCE" --port "$PORT" --timeout "$WAIT" >/dev/null; then
  die "The server did not answer within $WAIT s. See $INST_SERVER_LOG."
fi
port_owner "$PORT"
if [ -n "$LOCAL_FLAG" ] || [ "$CFG_LISTEN" = 127.0.0.1 ]; then
  echo "CloudCLI is running (PID $SERVER_PIDS): http://127.0.0.1:$PORT"
else
  echo "CloudCLI is running (PID $SERVER_PIDS): http://127.0.0.1:$PORT here, http://<this computer's address>:$PORT from allowed networks"
fi
