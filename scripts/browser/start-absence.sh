#!/usr/bin/env bash
# ABSENCE one-click launcher for Linux and WSL.
#
#   scripts/browser/start-absence.sh            build and start
#   scripts/browser/start-absence.sh check      dry run: report what would happen, start nothing
#
# Builds the web app and starts the ABSENCE server, then opens the UI. Pi
# supplies the model.
#
# The web app is rebuilt only when dist/web is missing or older than a web
# source/config file. The frontend is compiled into dist/web at the repo root
# and the server only serves that directory, so a stale dist is what you would
# otherwise see no matter what changed in src — this checks for real, not just
# "does the folder exist".
#
# This launcher lives under scripts/browser/, but always operates on the repo
# root (two levels up).
set -euo pipefail
cd "$(dirname "$0")/../.."

ABSENCE_PORT="${ABSENCE_PORT:-8848}"
ABSENCE_AGENT="${ABSENCE_AGENT:-pi}"
ABSENCE_URL="http://127.0.0.1:${ABSENCE_PORT}/api/projects"

DRY=0
for arg in "$@"; do
	[ "$arg" = "check" ] && DRY=1
done

echo "============================================================"
echo "  ABSENCE"
echo "------------------------------------------------------------"
echo "  repo   : $(pwd)"
echo "  agent  : ${ABSENCE_AGENT}"
echo "  absence   : port ${ABSENCE_PORT}"
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
# Rebuild only when the output is missing or older than any web source. A
# freshly checked-out dist/web (or one built moments ago) is left alone; a
# source edit makes the nearest file newer and triggers the build.
needs_web_build() {
	[ -f dist/web/index.html ] || return 0
	local newer
	newer=$(find apps/web/src packages/core/src \
		apps/web/index.html apps/web/package.json apps/web/vite.config.ts \
		apps/web/tailwind.config.js apps/web/postcss.config.js \
		-type f -newer dist/web/index.html 2>/dev/null | head -n 1)
	[ -n "$newer" ]
}

if needs_web_build; then
	echo "[2/2] building web app ..."
	[ "$DRY" = "1" ] || npm run build
else
	echo "[2/2] web build is up to date - skipping"
fi

# -------------------------------------------------------------------- server
if curl -fsS -m 3 -o /dev/null "$ABSENCE_URL" 2>/dev/null; then
	echo "[run] ABSENCE already running on port ${ABSENCE_PORT}"
else
	echo "[run] starting ABSENCE server ... agent=${ABSENCE_AGENT}"
	if [ "$DRY" = "1" ]; then
		echo "      dry run: would run npm start with ABSENCE_AGENT=${ABSENCE_AGENT}"
	else
		ABSENCE_AGENT="$ABSENCE_AGENT" nohup npm start >/tmp/absence-server.log 2>&1 &
		for _ in $(seq 1 60); do
			if curl -fsS -m 3 -o /dev/null "$ABSENCE_URL" 2>/dev/null; then break; fi
			sleep 1
		done
	fi
fi

echo
echo "============================================================"
echo "  open   : http://localhost:${ABSENCE_PORT}"
echo "  log    : /tmp/absence-server.log"
echo "============================================================"
echo

[ "$DRY" = "1" ] && { echo "Dry run complete."; exit 0; }

# Open a browser when one is available (WSL: the Windows browser via wslview).
if command -v wslview >/dev/null 2>&1; then
	wslview "http://localhost:${ABSENCE_PORT}" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
	xdg-open "http://localhost:${ABSENCE_PORT}" >/dev/null 2>&1 || true
else
	echo "Open http://localhost:${ABSENCE_PORT} in a browser."
fi
