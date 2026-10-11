#!/usr/bin/env bash
# Build the Linux process observer.
#
#   ./build.sh            build agentwatch-linux in this directory
#   ./build.sh --vmlinux  also regenerate vmlinux.h from the running kernel's BTF
#
# vmlinux.h is generated rather than committed: it is ~170k lines and is tied to
# the kernel it came from. Regenerate it after a kernel upgrade with --vmlinux.
#
# Requires: clang (with the bpf target), llvm-strip, libbpf-dev, libelf-dev,
# bpftool (for vmlinux.h). On Ubuntu: apt install clang llvm libbpf-dev libelf-dev.
#
# Skips the build when agentwatch-linux already exists and is newer than every
# source file; pass --force to rebuild anyway.
set -euo pipefail
cd "$(dirname "$0")"

# ------------------------------------------------------- skip when up to date
FORCE=0
for arg in "$@"; do
	[ "$arg" = "--force" ] && FORCE=1
done
if [ "$FORCE" = "0" ] && [ -x agentwatch-linux ] && [ "${1:-}" != "--vmlinux" ]; then
	newer=$(find . -maxdepth 1 -type f \( -name '*.c' -o -name '*.h' \) \
		-newer agentwatch-linux 2>/dev/null | head -n 1)
	if [ -z "$newer" ]; then
		echo "agentwatch-linux is up to date - skipping (use --force to rebuild)"
		exit 0
	fi
fi

# bpftool is often a wrapper that cannot find the running kernel's tools on WSL;
# the real binary lives under /usr/lib/linux-tools.
find_bpftool() {
	if bpftool version >/dev/null 2>&1; then echo bpftool; return; fi
	local candidate
	candidate=$(ls /usr/lib/linux-tools/*/bpftool 2>/dev/null | head -1 || true)
	if [ -n "$candidate" ]; then echo "$candidate"; return; fi
	echo ""
}

if [ "${1:-}" = "--vmlinux" ] || [ ! -f vmlinux.h ]; then
	BT=$(find_bpftool)
	if [ -z "$BT" ]; then
		echo "build.sh: bpftool not found; install linux-tools or copy a vmlinux.h here" >&2
		exit 1
	fi
	echo "generating vmlinux.h from /sys/kernel/btf/vmlinux ..."
	"$BT" btf dump file /sys/kernel/btf/vmlinux format c > vmlinux.h
fi

ARCH_INC=/usr/include/$(uname -m)-linux-gnu
CFLAGS_BPF=(
	-g -O2 -target bpf -D__TARGET_ARCH_x86
	-I. -I"$ARCH_INC"
	-Wall -Wno-unused-value -Wno-pointer-sign -Wno-compare-distinct-pointer-types
)

echo "compiling agentwatch.bpf.o ..."
clang "${CFLAGS_BPF[@]}" -c agentwatch.bpf.c -o agentwatch.bpf.o

echo "generating skeleton ..."
BT=$(find_bpftool)
"$BT" gen skeleton agentwatch.bpf.o > agentwatch.skel.h

echo "linking agentwatch-linux ..."
cc -g -O2 -Wall -o agentwatch-linux agentwatch.c \
	-lbpf -lelf -lz

# Strip debug symbols from the shipped binary; keep the BPF object as-is so the
# skeleton's embedded copy of it stays intact.
strip --strip-debug agentwatch-linux 2>/dev/null || true

echo "built: $(pwd)/agentwatch-linux"
ls -la agentwatch-linux
