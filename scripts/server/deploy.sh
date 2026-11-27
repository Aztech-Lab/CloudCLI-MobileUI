#!/bin/sh
# [local] Prepare a new build for the server without stopping it.
#
#   deploy.sh                package this clone (already built) into <runtime>.next
#   deploy.sh --build        run `npm run build` first
#   deploy.sh --staging --from <worktree> [--build] [--fresh-db]   build for the test portal
#   options: --config FILE
#
# <runtime>.next is what `npm pack` ships plus the production dependencies installed from
# the checkout's package-lock.json. It becomes the running build on the next
# `restart.sh --deploy`. --fresh-db: the test portal takes a new copy of the database.
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTANCE=live PORT='' CONFIG='' FORCE=0
FROM=
BUILD_FLAG=
FRESH_FLAG=
while [ $# -gt 0 ]; do
  case $1 in
    --build) BUILD_FLAG=--build ;;
    --staging) INSTANCE=staging ;;
    --from) FROM=$(CDPATH='' cd -- "$2" && pwd) || exit 1; shift ;;
    --fresh-db) FRESH_FLAG=--fresh-db ;;
    --config) CONFIG=$2; shift ;;
    -h | --help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done
. "$SCRIPT_DIR/_common.sh"
need_node
if [ -n "$FROM" ]; then
  # shellcheck disable=SC2086
  ctl deploy --instance "$INSTANCE" --from "$FROM" $BUILD_FLAG $FRESH_FLAG || exit $?
else
  # shellcheck disable=SC2086
  ctl deploy --instance "$INSTANCE" $BUILD_FLAG $FRESH_FLAG || exit $?
fi
STAGING_FLAG=
[ "$INSTANCE" = staging ] && STAGING_FLAG=' --staging'
echo "Activate it with: $SCRIPT_DIR/restart.sh --deploy$STAGING_FLAG   (add --detach --delay 30 when running inside CloudCLI)"
