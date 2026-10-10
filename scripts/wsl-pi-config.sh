#!/usr/bin/env bash
# Point the pi inside WSL at the model services running on the Windows host.
#
# A model server bound to the Windows loopback is not reachable from WSL as
# 127.0.0.1 — inside WSL that address is WSL itself. The Windows host is the
# default route's gateway, which is what this script resolves and rewrites the
# loopback host into:
#
#   ip route show | grep -i default | awk '{ print $3 }'
#
# The address changes when WSL restarts, so this runs on every launch rather than
# once: a stale gateway is the difference between "connecting" and "refused".
#
# Source of truth for the providers is the Windows pi config, so a provider added
# there is picked up here without a second edit. Override with:
#   ABSENCE_WIN_PI_DIR   (default: the Windows user's %USERPROFILE%/.pi/agent)
set -euo pipefail

WIN_HOME="${ABSENCE_WIN_HOME:-}"
if [ -z "$WIN_HOME" ]; then
	# The Windows user profile as WSL sees it, e.g. /mnt/c/Users/Name.
	for candidate in /mnt/c/Users/*; do
		if [ -d "$candidate/.pi/agent" ]; then WIN_HOME="$candidate"; break; fi
	done
fi

SRC="${ABSENCE_WIN_PI_DIR:-${WIN_HOME:+$WIN_HOME/.pi/agent}}"
DEST="${HOME}/.pi/agent"

GW="$(ip route show | grep -i default | awk '{ print $3 }')"
if [ -z "$GW" ]; then
	echo "start-absence: could not resolve the Windows host address (no default route)" >&2
	echo "            is this really WSL? On native Linux set the providers up yourself." >&2
	exit 0
fi

mkdir -p "$DEST"

if [ -n "${SRC:-}" ] && [ -f "$SRC/models.json" ]; then
	# Rewrite the loopback host to the Windows gateway. pi's own config is the
	# source, so ids, keys and limits stay in one place.
	sed -E "s#http://(127\.0\.0\.1|localhost):#http://${GW}:#g" "$SRC/models.json" > "$DEST/models.json"
	echo "start-absence: pi providers rewritten to ${GW} (from $SRC/models.json)"
else
	echo "start-absence: no Windows pi models.json found at ${SRC:-<none>};"
	echo "            set ABSENCE_WIN_PI_DIR or configure ~/.pi/agent/models.json by hand" >&2
fi

# Carry the default provider/model selection across too, so WSL pi starts on the
# same model the Windows one does.
if [ -n "${SRC:-}" ] && [ -f "$SRC/settings.json" ]; then
	cp "$SRC/settings.json" "$DEST/settings.json"
fi
