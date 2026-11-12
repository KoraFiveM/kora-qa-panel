#!/usr/bin/env bash
# Test stand-in for /opt/claude-bugfix/apply-fix.sh: echoes its arguments, --show prints a header and a diff.
case "$1" in
  --show) echo "# Fake fix"; echo "Thread $2 · kind bug"; echo "----- kora_fishing.patch"; echo "--- a/x.lua"; echo "+++ b/x.lua";;
  --apply|--revert) echo "fake $1 $2 ${3:-}"; [[ "$2" == 1570000000000000666 ]] && { echo "ERROR: does not apply" >&2; exit 1; } ;;
  *) echo "usage"; exit 2;;
esac
exit 0
