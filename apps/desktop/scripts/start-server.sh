#!/usr/bin/env bash
# ABSENCE server launcher — headless, no GUI, no Electron window.
#
#   ./start-server.sh            start the server (foreground)
#   ./start-server.sh daemon     start in the background (log: server.log)
#   ./start-server.sh stop       stop the background daemon
#
# Works inside the unpacked tar.gz release (Absence-<version>/) — it runs the
# bundled server on the Electron binary itself, so Node.js does not need to be
# installed. The UI is served from the same origin on port 8848.
set -euo pipefail
cd "$(dirname "$0")"

BIN=./absence
BUNDLE=resources/apps/server-bundle.cjs
PORT="${ABSENCE_PORT:-8848}"
URL="http://127.0.0.1:${PORT}/api/projects"

[ -x "$BIN" ] || { echo "error: $BIN not found (run from the unpacked Absence-<version>/ directory)" >&2; exit 1; }
[ -f "$BUNDLE" ] || { echo "error: $BUNDLE not found — this does not look like an unpacked Absence release" >&2; exit 1; }

# The Electron binary in Node mode: the server bundle's runtime.
export ELECTRON_RUN_AS_NODE=1
# The native process observer is shipped beside the bundle; the server's own
# path heuristic assumes a checkout layout, so point it there explicitly.
export ABSENCE_AGENTWATCH_LINUX="$PWD/resources/native/agentwatch-linux/agentwatch-linux"
export ABSENCE_AGENTWATCH="$PWD/resources/native/agentwatch/agentwatch.exe"

start_foreground() {
	if [ -n "${ABSENCE_SUDO:-}" ]; then
		# eBPF needs privileges: rerun the whole script under sudo.
		exec sudo -E "$0" "$@"
	fi
	echo "ABSENCE server → http://127.0.0.1:${PORT}  (Ctrl+C to stop)"
	exec "$BIN" "$BUNDLE"
}

case "${1:-run}" in
run)
	start_foreground
	;;
daemon)
	if curl -fsS -m 3 -o /dev/null "$URL" 2>/dev/null; then
		echo "ABSENCE already running on port ${PORT}"
		exit 0
	fi
	nohup "$BIN" "$BUNDLE" > server.log 2>&1 &
	echo $! > server.pid
	for _ in $(seq 1 30); do
		if curl -fsS -m 3 -o /dev/null "$URL" 2>/dev/null; then break; fi
		sleep 1
	done
	if curl -fsS -m 3 -o /dev/null "$URL" 2>/dev/null; then
		echo "ABSENCE server running → http://127.0.0.1:${PORT}  (pid $(cat server.pid), log: server.log)"
	else
		echo "server did not come up — see server.log" >&2
		exit 1
	fi
	;;
stop)
	if [ -f server.pid ]; then
		kill "$(cat server.pid)" 2>/dev/null && rm -f server.pid
		echo "stopped"
	else
		echo "no server.pid found (was it started with 'daemon'?)"
	fi
	;;
*)
	echo "usage: $0 [run|daemon|stop]" >&2
	exit 1
	;;
esac
