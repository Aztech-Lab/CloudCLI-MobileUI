#!/bin/sh
# [local] Limit who can reach CloudCLI's port(s) to the config's firewallAllow networks.
#
#   firewall.sh            Linux with ufw: add the rules (asks for sudo). Otherwise, and on
#                          macOS (whose application firewall cannot filter by network),
#                          print what to set up by hand.
#   firewall.sh --remove   remove the rules again (ufw)
#   options: --config FILE
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
REMOVE=0
while [ $# -gt 0 ]; do
  case $1 in
    --remove) REMOVE=1 ;;
    --config) CONFIG=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"
need_node
load_config

PORTS=$CFG_PORT
[ -n "$CFG_STAGING_PORT" ] && PORTS="$PORTS $CFG_STAGING_PORT"
if [ "$REMOVE" != 1 ] && [ -z "$CFG_ALLOW" ]; then
  echo "No networks in firewallAllow (listen address: $CFG_LISTEN); no firewall rules needed."
  [ "$CFG_LISTEN" = 127.0.0.1 ] || echo 'Warning: the server listens on the network but no networks are allowed in the config.'
  exit 0
fi
LOG_FILE="$CFG_LOGS/firewall.log"

print_manual() {
  echo
  echo "Set this up by hand: allow TCP port(s) $PORTS only from: ${CFG_ALLOW:-<your networks>}"
  if [ "$(uname -s)" = Darwin ]; then
    cat <<EOF
macOS: the application firewall (System Settings > Network > Firewall) can only allow or block
an app for every network. To limit by network, use pf, for example in /etc/pf.anchors/cloudcli:
EOF
    for p in $PORTS; do
      echo "  block in proto tcp from any to any port $p"
      for net in $CFG_ALLOW; do echo "  pass in proto tcp from $net to any port $p"; done
    done
    echo 'then add  anchor "cloudcli"  and  load anchor "cloudcli" from "/etc/pf.anchors/cloudcli"  to /etc/pf.conf'
    echo 'and run  sudo pfctl -f /etc/pf.conf -e.  Or keep listenAddress at 127.0.0.1 and use a VPN such as Tailscale.'
  else
    echo 'Linux without ufw, e.g. with nftables or iptables:'
    for p in $PORTS; do
      for net in $CFG_ALLOW; do echo "  sudo iptables -A INPUT -p tcp --dport $p -s $net -j ACCEPT"; done
      echo "  sudo iptables -A INPUT -p tcp --dport $p -j DROP"
    done
    echo "(make them permanent with your distribution's firewall tooling)"
  fi
}

if [ "$(uname -s)" != Linux ] || ! command -v ufw >/dev/null 2>&1; then
  print_manual
  exit 0
fi

SUDO=
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || { print_manual; exit 1; }
  SUDO=sudo
fi
echo "Changing ufw rules for port(s) $PORTS (sudo may ask for your password) ..."
failed=0
for p in $PORTS; do
  if [ "$REMOVE" = 1 ]; then
    for net in $CFG_ALLOW; do $SUDO ufw delete allow from "$net" to any port "$p" proto tcp >/dev/null 2>&1; done
    $SUDO ufw delete deny "$p/tcp" >/dev/null 2>&1
    log "OK: port $p rules removed"
    continue
  fi
  # ufw uses the first matching rule: deny the port, then put the allow rules in front of it.
  $SUDO ufw deny "$p/tcp" >/dev/null || failed=1
  for net in $CFG_ALLOW; do
    $SUDO ufw insert 1 allow from "$net" to any port "$p" proto tcp >/dev/null || failed=1
  done
  log "port $p allow=[$CFG_ALLOW] others denied$([ "$failed" = 1 ] && echo ' (with errors)')"
done
if $SUDO ufw status 2>/dev/null | grep -q 'Status: inactive'; then
  echo 'Note: ufw is inactive; the rules apply once it is enabled (allow SSH first if you use it: sudo ufw allow OpenSSH; sudo ufw enable).'
fi
[ "$failed" = 0 ] || { print_manual; exit 1; }
exit 0
