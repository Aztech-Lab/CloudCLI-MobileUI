#!/bin/sh
# [local] Start CloudCLI-MobileUI when you log in (the live server, in the background).
#
#   autostart.sh on       macOS: a LaunchAgent in ~/Library/LaunchAgents
#                         Linux: a systemd user unit in ~/.config/systemd/user (enabled)
#   autostart.sh off      remove it (a running server keeps running)
#   autostart.sh status   on | off | disabled | unsupported   (--json for machine-readable)
#   options: --config FILE
#
# Linux: user units start at your first login and stop at your last logout. To keep the
# server running without a login session (e.g. a headless box), run once:
#   sudo loginctl enable-linger "$USER"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
ACTION=status
JSON=0
while [ $# -gt 0 ]; do
  case $1 in
    on | off | status) ACTION=$1 ;;
    --json) JSON=1 ;;
    --config) CONFIG=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"
need_node
load_config

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
# systemd expands % specifiers and $ variables in ExecStart; double them to keep them literal.
systemd_escape() { printf '%s' "$1" | sed -e 's/%/%%/g' -e 's/\$/$$/g' -e 's/"/\\"/g'; }

START_SCRIPT="$SCRIPT_DIR/start.sh"
OS=$(uname -s)
case "$ACTION:$OS" in
  on:Darwin)
    plist=$(launchd_plist)
    mkdir -p "$(dirname "$plist")"
    # launchd starts jobs with a minimal PATH: give the server the PATH of this shell, so it
    # finds node and claude. AbandonProcessGroup: a restart launched from a chat inside the
    # server must survive the server's exit.
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$(launchd_label)")</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$(xml_escape "$START_SCRIPT")</string>
    <string>--service</string>
    <string>--config</string>
    <string>$(xml_escape "$CONFIG")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml_escape "$PATH")</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>AbandonProcessGroup</key><true/>
</dict>
</plist>
EOF
    launchctl enable "gui/$(id -u)/$(launchd_label)" 2>/dev/null
    ;;
  off:Darwin)
    # Only the file: unloading the job would stop a server it started.
    rm -f "$(launchd_plist)"
    ;;
  on:Linux)
    command -v systemctl >/dev/null 2>&1 || die 'systemd is not available here; start start.sh from your own login script instead.'
    unit_file=$(systemd_unit_file)
    mkdir -p "$(dirname "$unit_file")"
    # KillMode=process: stopping the unit ends the server only, and a restart launched from a
    # chat inside the server survives the server's exit.
    cat >"$unit_file" <<EOF
[Unit]
Description=CloudCLI-MobileUI (web UI for Claude Code)
After=network-online.target

[Service]
Type=simple
Environment="PATH=$(systemd_escape "$PATH")"
ExecStart=/bin/sh "$(systemd_escape "$START_SCRIPT")" --service --config "$(systemd_escape "$CONFIG")"
KillMode=process

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload && systemctl --user enable "$(systemd_unit)" ||
      die "Could not enable $(systemd_unit) (is a systemd user session running?)."
    if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'yes'; then
      echo "Note: it starts at your first login and stops at your last logout. To keep it running"
      echo "without a login session, run once: sudo loginctl enable-linger $USER"
    fi
    ;;
  off:Linux)
    if [ -f "$(systemd_unit_file)" ]; then
      systemctl --user disable "$(systemd_unit)" >/dev/null 2>&1
      rm -f "$(systemd_unit_file)"
      systemctl --user daemon-reload >/dev/null 2>&1
    fi
    ;;
  status:*) ;;
  *) die "Autostart is not supported on $OS." ;;
esac

STATE=$(autostart_state)
if [ "$JSON" = 1 ]; then
  printf '{"state":"%s","name":"%s"}\n' "$STATE" "$CFG_AUTOSTART_NAME"
else
  case $STATE in
    on) echo "Autostart is on: CloudCLI starts when you log in ($(if [ "$OS" = Darwin ]; then launchd_plist; else systemd_unit_file; fi))." ;;
    off) echo 'Autostart is off.' ;;
    disabled) echo "Autostart is installed but disabled; 'autostart.sh on' switches it back on." ;;
    *) echo "Autostart: $STATE" ;;
  esac
fi
case "$ACTION:$STATE" in
  on:on | off:off | status:*) exit 0 ;;
  *) exit 1 ;;
esac
