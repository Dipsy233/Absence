#!/usr/bin/env bash
# ===========================================================================
#  ABSENCE desktop build — Linux / WSL
#
#  The bash counterpart of start-absence-app.bat. One command that turns
#  this checkout into a distributable desktop app for Linux. Every artifact
#  lands under dist/desktop/:
#
#    dist/desktop/build/server.cjs      ABSENCE's server + core, compiled to one
#                                       CJS file (no tsx needed at runtime)
#    dist/desktop/build/node_modules    the server's production deps only,
#                                       installed fresh for this platform
#    dist/desktop/release/              electron-builder's output:
#                                       Absence-<version>.AppImage and
#                                       Absence-<version>.tar.gz
#
#  Steps:
#    1. web app          npm run build   -> dist/web
#    2. server bundle    apps/desktop run bundle -> dist/desktop/build/server.cjs
#    3. server deps      apps/desktop run stage  -> dist/desktop/build/node_modules
#       (+ agentwatch-linux, built when its sources are newer than the binary)
#    4. package          apps/desktop run dist   -> dist/desktop/release
#
#  Usage:
#    ./start-absence-app.sh          full build and package
#    ./start-absence-app.sh check    dry run - report what would happen
#    ./start-absence-app.sh pack     same as full build, but skip the installer
#                                    (electron-builder --dir, faster; output is
#                                    dist/desktop/release/linux-unpacked)
#
#  Env:
#    ABSENCE_SKIP_WEB=1   reuse the existing dist/web build (faster iteration)
# ===========================================================================
set -euo pipefail

# The script is at the repo root; resolve the absolute path.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

DRY=0
DIRONLY=0
case "${1:-}" in
	check) DRY=1 ;;
	pack) DIRONLY=1 ;;
	"") ;;
	*)
		echo "usage: $0 [check|pack]" >&2
		exit 2
		;;
esac

echo "============================================================"
echo "  ABSENCE - desktop build (linux)"
echo "------------------------------------------------------------"
echo "  repo    : $REPO"
echo "  output  : $REPO/dist/desktop"
if [ "$DIRONLY" = "1" ]; then echo "  mode    : pack (no AppImage/tar.gz)"; fi
if [ "$DRY" = "1" ]; then echo "  mode    : dry run - nothing will be built"; fi
echo "============================================================"

run() {
	# run <label> <dir> <command...>
	local label="$1" dir="$2"
	shift 2
	if [ "$DRY" = "1" ]; then
		echo "[dry] $label: (cd $dir && $*)"
		return 0
	fi
	echo ""
	echo "--- $label -------------------------------------------------"
	(cd "$dir" && "$@")
}

# ------------------------------------------------------------------ checks
if [ ! -d node_modules ]; then
	echo "node_modules missing - run 'npm install' at the repo root first" >&2
	exit 1
fi
for tool in node npm; do
	command -v "$tool" >/dev/null 2>&1 || { echo "$tool not found on PATH" >&2; exit 1; }
done

# ------------------------------------------------------- 1. web app
if [ "${ABSENCE_SKIP_WEB:-0}" = "1" ] && [ -f dist/web/index.html ]; then
	echo ""
	echo "--- web app ------------------------------------------------"
	echo "ABSENCE_SKIP_WEB=1 - reusing the existing dist/web build"
elif [ -f dist/web/index.html ] && [ "$DRY" = "0" ]; then
	# Rebuild only when a source is newer than the last build.
	newer=$(find apps/web/src packages/core/src -type f -newer dist/web/index.html 2>/dev/null | head -n 1 || true)
	if [ -z "$newer" ]; then
		echo ""
		echo "--- web app ------------------------------------------------"
		echo "dist/web is up to date - skipping (set ABSENCE_SKIP_WEB=0 to force)"
	else
		run "web app" "$REPO" npm run build --workspace @absence/web
	fi
else
	run "web app" "$REPO" npm run build --workspace @absence/web
fi

# ------------------------------------------------------- 2. server bundle
run "server bundle" "apps/desktop" npm run bundle

# ------------------------------------------------------- 3. server deps
# Staging installs the server's production dependencies for *this* platform,
# which is why a linux package has to be built on linux (native modules).
run "server deps" "apps/desktop" npm run stage

# The Linux process observer: built here, packed only into linux targets.
# build.sh skips itself when the binary is newer than every source file.
if [ "$DRY" = "0" ]; then
	if [ -f native/agentwatch-linux/build.sh ]; then
		echo ""
		echo "--- agentwatch-linux ---------------------------------------"
		if [ -x native/agentwatch-linux/agentwatch-linux ] || command -v clang >/dev/null 2>&1; then
			(native/agentwatch-linux/build.sh) || {
				echo "warning: agentwatch-linux build failed - packaging continues," >&2
				echo "         but process watching will be unavailable in this build" >&2
			}
		else
			echo "clang not found and no prebuilt binary - skipping"
			echo "(process watching will be unavailable; apt install clang llvm libbpf-dev libelf-dev)"
		fi
	fi
else
	echo "[dry] agentwatch-linux: native/agentwatch-linux/build.sh"
fi

# ------------------------------------------------------- 4. package
if [ "$DIRONLY" = "1" ]; then
	run "package (dir)" "apps/desktop" npm run pack
else
	run "package" "apps/desktop" npm run dist
fi

echo ""
echo "============================================================"
if [ "$DRY" = "1" ]; then
	echo "  dry run complete - nothing was built"
else
	echo "  done"
	echo "  artifacts:"
	ls -1 dist/desktop/release 2>/dev/null | sed 's/^/    /' || echo "    (none - check the electron-builder output above)"
fi
echo "============================================================"
