#!/usr/bin/env bash
# Convenience shortcut. The real browser launcher lives with the other
# browser-only files under scripts/browser/, so the launchers are grouped by
# what they run. This just forwards, so there is one implementation.
exec "$(dirname "$0")/scripts/browser/start-absence.sh" "$@"
