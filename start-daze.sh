#!/usr/bin/env bash
# DAZE one-click launcher for Linux and WSL.
#
#   ./start-daze.sh            build and start
#   ./start-daze.sh check      dry run: report what would happen, start nothing
#
# Builds the web app and starts the DAZE server, then opens the UI. There is no
# local model server: Pi supplies the model.
#
# The web app is ALWAYS rebuilt. The frontend is compiled into apps/web/dist and
# the server only serves that directory, so a stale dist is what you would
# otherwise see no matter what changed in src.
set -euo pipefail
cd "$(dirname "$0")"

DAZE_PORT="${DAZE_PORT:-8848}"
DAZE_AGENT="${DAZE_AGENT:-pi}"
DAZE_URL="http://127.0.0.1:${DAZE_PORT}/api/projects"

DRY=0
for arg in "$@"; do
	[ "$arg" = "check" ] && DRY=1
done

echo "============================================================"
echo "  DAZE"
echo "------------------------------------------------------------"
echo "  repo   : $(pwd)"
echo "  agent  : ${DAZE_AGENT}"
echo "  daze   : port ${DAZE_PORT}"
[ "$DRY" = "1" ] && echo "  mode   : dry run - nothing will be started"
echo "============================================================"
echo

# --------------------------------------------------------------- build helper
# The Linux process observer is a committed binary; build it if it is missing
# and the toolchain is present.
if [ ! -x native/agentwatch-linux/agentwatch-linux ]; then
	if command -v clang >/dev/null 2>&1; then
		echo "[obs] building the eBPF process observer ..."
		[ "$DRY" = "1" ] || (cd native/agentwatch-linux && ./build.sh)
	else
		echo "[obs] agentwatch-linux missing and clang not found; processes will be polled" >&2
	fi
fi

# --------------------------------------------------------------- pi providers
# In WSL, point pi at the model services on the Windows host. Their loopback is
# not WSL's loopback, and the host address changes when WSL restarts, so this
# runs on every launch.
if grep -qi microsoft /proc/version 2>/dev/null; then
	echo "[pi] configuring WSL pi providers ..."
	[ "$DRY" = "1" ] || bash scripts/wsl-pi-config.sh
fi

# ------------------------------------------------------------------- install
if [ ! -d node_modules ]; then
	echo "[1/2] installing dependencies ... this happens only once"
	[ "$DRY" = "1" ] || npm install --no-audit --no-fund
else
	echo "[1/2] dependencies present"
fi

# --------------------------------------------------------------------- build
echo "[2/2] building web app ..."
[ "$DRY" = "1" ] || npm run build

# -------------------------------------------------------------------- server
if curl -fsS -m 3 -o /dev/null "$DAZE_URL" 2>/dev/null; then
	echo "[run] DAZE already running on port ${DAZE_PORT}"
else
	echo "[run] starting DAZE server ... agent=${DAZE_AGENT}"
	if [ "$DRY" = "1" ]; then
		echo "      dry run: would run npm start with DAZE_AGENT=${DAZE_AGENT}"
	else
		DAZE_AGENT="$DAZE_AGENT" nohup npm start >/tmp/daze-server.log 2>&1 &
		for _ in $(seq 1 60); do
			if curl -fsS -m 3 -o /dev/null "$DAZE_URL" 2>/dev/null; then break; fi
			sleep 1
		done
	fi
fi

echo
echo "============================================================"
echo "  open   : http://localhost:${DAZE_PORT}"
echo "  log    : /tmp/daze-server.log"
echo "============================================================"
echo

[ "$DRY" = "1" ] && { echo "Dry run complete."; exit 0; }

# Open a browser when one is available (WSL: the Windows browser via wslview).
if command -v wslview >/dev/null 2>&1; then
	wslview "http://localhost:${DAZE_PORT}" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
	xdg-open "http://localhost:${DAZE_PORT}" >/dev/null 2>&1 || true
else
	echo "Open http://localhost:${DAZE_PORT} in a browser."
fi
