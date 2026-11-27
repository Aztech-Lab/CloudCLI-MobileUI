#!/bin/sh
# [local] Set up CloudCLI-MobileUI on this macOS or Linux computer, from a fresh clone:
# checks Node.js and Claude Code, creates the machine config (asks a few questions),
# installs and builds, deploys the runtime, sets the firewall (Linux with ufw; otherwise
# prints advice), starts the server in the background and makes it start when you log in.
# Safe to run again (e.g. after git pull).
#
#   setup.sh                     interactive
#   setup.sh --yes               no questions: defaults (port 3001, this computer only)
#   setup.sh --yes --port 3001 --allow 192.168.1.0/24   reachable from that network
#   --no-autostart  do not start at login   --no-firewall  leave the firewall alone
#   --no-start      do not start the server --skip-build   use the existing build here
#   --config FILE   a config file somewhere else (default: <clone>/_server/config.json)
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
YES=0
AUTOSTART=1
FIREWALL=1
START=1
BUILD=1
ALLOW=
while [ $# -gt 0 ]; do
  case $1 in
    --yes | -y) YES=1 ;;
    --no-autostart) AUTOSTART=0 ;;
    --no-firewall) FIREWALL=0 ;;
    --no-start) START=0 ;;
    --skip-build) BUILD=0 ;;
    --port) PORT=$2; shift ;;
    --allow) ALLOW="$ALLOW $2"; shift ;;
    --config) CONFIG=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nSETUP STOPPED: %s\n' "$*" >&2; exit 1; }

# --- 1. Prerequisites -------------------------------------------------------------------
step 'Checking Node.js and Claude Code'
command -v node >/dev/null 2>&1 || fail 'Node.js is not installed (or not on PATH). Install the current LTS (https://nodejs.org, or your package manager / nvm) and run setup again.'
node "$SERVERCTL" check-node || fail 'Install a newer Node.js and run setup again.'
command -v npm >/dev/null 2>&1 || fail 'npm was not found next to Node.js.'

CLAUDE_PATH=$(command -v claude 2>/dev/null)
if [ -z "$CLAUDE_PATH" ]; then
  for candidate in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"; do
    [ -x "$candidate" ] && { CLAUDE_PATH=$candidate; break; }
  done
fi
if [ -n "$CLAUDE_PATH" ]; then
  # Recorded in the config: autostart runs with a minimal environment.
  echo "Claude Code: $CLAUDE_PATH"
else
  echo 'WARNING: Claude Code was not found. Install it (https://docs.anthropic.com/en/docs/claude-code),'
  echo '         log in once by running "claude", then restart the server. Setup continues.'
fi

# --- 2. Machine config --------------------------------------------------------------------
step 'Machine config'
if [ -n "$CONFIG" ]; then
  CONFIG_PATH=$(CDPATH='' cd -- "$(dirname -- "$CONFIG")" 2>/dev/null && pwd)/$(basename -- "$CONFIG") ||
    fail "The folder of $CONFIG does not exist."
elif [ -n "${CLOUDCLI_SERVER_CONFIG:-}" ]; then
  CONFIG_PATH=$CLOUDCLI_SERVER_CONFIG
else
  CONFIG_PATH="$CLONE_ROOT/_server/config.json"
fi
if [ -f "$CONFIG_PATH" ]; then
  echo "Using the existing config: $CONFIG_PATH"
else
  [ -n "$PORT" ] || PORT=3001
  if [ "$YES" != 1 ] && [ -t 0 ]; then
    printf 'Port for the web UI [%s]: ' "$PORT"
    read -r answer
    case $answer in '' | *[!0-9]*) ;; *) PORT=$answer ;; esac
    if [ -z "$ALLOW" ]; then
      echo 'Phones and tablets reach the server over your network. List the networks allowed to'
      echo 'connect (comma-separated, e.g. 192.168.1.0/24), or leave empty for this computer only.'
      hint=
      if command -v ip >/dev/null 2>&1; then
        hint=$(ip -4 -o addr show scope global 2>/dev/null | awk '{ print $4; exit }')
      elif [ "$(uname -s)" = Darwin ]; then
        hint=$(ipconfig getifaddr en0 2>/dev/null)
      fi
      [ -n "$hint" ] && echo "(This computer is $hint.)"
      printf 'Allowed networks: '
      read -r ALLOW
    fi
  fi
  ALLOW=$(printf '%s' "$ALLOW" | tr ',;' '  ' | awk '{ $1 = $1; gsub(/ /, ","); print }')
  LISTEN=127.0.0.1
  [ -n "$ALLOW" ] && LISTEN=0.0.0.0
  set -- init-config --config "$CONFIG_PATH" --port "$PORT" --listen "$LISTEN"
  [ -n "$ALLOW" ] && set -- "$@" --allow "$ALLOW"
  [ -n "$CLAUDE_PATH" ] && set -- "$@" --claude-path "$CLAUDE_PATH"
  node "$SERVERCTL" "$@" || fail 'Could not write the config (see above). Check the port and networks.'
  echo 'Edit it any time (comments explain each setting), then restart.'
fi
CONFIG=$CONFIG_PATH
PORT=
load_config

# --- 3. Install and build -----------------------------------------------------------------
if [ "$BUILD" = 1 ]; then
  step 'Installing dependencies (npm ci) - this takes a few minutes'
  (cd "$CLONE_ROOT" && npm ci --no-audit --no-fund) ||
    fail 'npm ci failed (see above). AGENTS_DEPLOY.md > Troubleshooting covers native module errors.'
  step 'Building (npm run build)'
  (cd "$CLONE_ROOT" && npm run build) || fail 'The build failed (see above).'
fi

# --- 4. Runtime ---------------------------------------------------------------------------
step "Preparing the runtime in $INST_RUNTIME"
ctl deploy --instance live || fail "Deploy failed; details in $CFG_LOGS/deploy.log."

# --- 5. Firewall --------------------------------------------------------------------------
if [ "$FIREWALL" != 1 ]; then
  printf '\nFirewall: skipped (--no-firewall).\n'
elif [ -n "$CFG_ALLOW" ]; then
  step 'Firewall'
  /bin/sh "$SCRIPT_DIR/firewall.sh" --config "$CONFIG" ||
    echo 'WARNING: firewall rules were not set. Run firewall.sh later.'
fi

# --- 6. Start -----------------------------------------------------------------------------
port_owner "$PORT"
if [ -n "$SERVER_PIDS" ]; then
  step 'Server'
  echo "A server already runs on port $PORT (PID $SERVER_PIDS). The new build is ready;"
  echo "switch to it with: $SCRIPT_DIR/restart.sh --deploy"
elif [ -n "$FOREIGN_PIDS" ]; then
  fail "Port $PORT is used by another program. Change \"port\" in $CONFIG and run setup again."
else
  ctl activate --instance live
  if [ "$START" != 1 ]; then
    printf '\nNot started (--no-start). Start it with: %s/start.sh\n' "$SCRIPT_DIR"
  else
    step 'Starting the server in the background'
    /bin/sh "$SCRIPT_DIR/start.sh" --config "$CONFIG" || fail "The server did not start; see $INST_SERVER_LOG."
  fi
fi

# --- 7. Autostart -------------------------------------------------------------------------
if [ "$AUTOSTART" != 1 ]; then
  printf '\nAutostart: skipped (--no-autostart).\n'
else
  step 'Start at login'
  /bin/sh "$SCRIPT_DIR/autostart.sh" on --config "$CONFIG" || echo 'WARNING: autostart was not set up (see above).'
fi

# --- Done ---------------------------------------------------------------------------------
step 'Done'
echo "Open http://127.0.0.1:$PORT on this computer and create your account (the first one is the only one)."
[ -n "$CFG_ALLOW" ] && echo "Other devices on $CFG_ALLOW use http://<this computer's address>:$PORT - create the account first."
echo "Manage it with the scripts in $SCRIPT_DIR (status, restart, stop, autostart), or in Settings > MobileUI > Server."
exit 0
