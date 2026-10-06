# agentwatch-linux

The Linux process observer Daze runs next to the server.

## Why

Daze cannot see the processes a shell lays by polling `/proc`: a process that
lives a millisecond is gone before the next look, and no amount of tightening the
interval fixes that — it is the sampling theorem. On Linux the fix is not to look
faster but to stop looking: the kernel will report every process it creates.

## How

Three **eBPF tracepoints**, attached by this helper, carry everything Daze needs:

| Tracepoint | Gives |
|---|---|
| `sched_process_fork` | parent → child, so a process stays attributed to its command after the shell is gone |
| `sched_process_exec` | the resolved executable path |
| `sched_process_exit` | the end of a process |
| `sys_enter_execve` | the argument vector |

The first three are the obvious ones. `sys_enter_execve` is there because no
`sched` tracepoint carries argv, and reading `/proc/<pid>/cmdline` from user space
loses a race with a process that exits immediately — the exec tracepoint fires
*before* the address space is replaced, so `bpf_probe_read_user` on the `argv`
array still sees the arguments and there is no window to lose.

Events go to a **ring buffer**, not to a pipe: a burst of process creation (a
`make -j`, a shell loop) would overflow a pipe and lose events, which is the one
thing this program exists to prevent. If the buffer ever does overflow, the loss
is reported on stderr rather than swallowed.

### Why eBPF and not netlink

The kernel's proc connector (`NETLINK_CONNECTOR`) also reports fork/exec/exit,
and it is simpler to attach. But it reports an exec by **pid alone** — the
executable's name has to be recovered afterwards from `/proc`, which is exactly
the race this design removes. The `sched_process_exec` tracepoint carries the path
in the event itself, so eBPF wins on the one thing that matters.

### Privileges

Loading BPF needs `CAP_BPF` + `CAP_PERFMON` (or root). WSL runs as root by
default, so nothing is needed there. On a machine where Daze runs unprivileged:

```sh
sudo setcap cap_bpf,cap_perfmon+ep agentwatch-linux
```

If the load fails, the helper says so on stderr, `start()` rejects, and the
session falls back to polling with the reason shown in the UI.

## Output

One JSON object per line on stdout, the same shape as the Windows observer so the
Daze side parses both with one code path:

| Event | Fields |
|---|---|
| `ready` | — |
| `fork` | `pid`, `ppid` |
| `start` | `pid`, `comm`, `path`, `cmd` |
| `exit` | `pid` |

`start` is the join of the exec and execve events for one process: `path` from the
former, `cmd` from the latter.

## Build

```sh
./build.sh              # build agentwatch-linux here
./build.sh --vmlinux    # also regenerate vmlinux.h from the running kernel's BTF
```

Requires `clang`, `llvm-strip`, `libbpf-dev`, `libelf-dev`, `zlib1g-dev` and
`bpftool`. On Ubuntu 24.04:

```sh
sudo apt install clang llvm libbpf-dev libelf-dev zlib1g-dev
```

`vmlinux.h` is generated from `/sys/kernel/btf/vmlinux`, not committed: it is
~170k lines and tied to the kernel it came from. Regenerate it after a kernel
upgrade with `--vmlinux`. On WSL `bpftool` is a wrapper that cannot find the
running kernel's tools; `build.sh` locates the real binary under
`/usr/lib/linux-tools/`.

The resulting `agentwatch-linux` is committed prebuilt so users do not need the
BPF toolchain. Rebuild it whenever a `.c` file changes.

## Known limits

- A process the kernel never reports through these tracepoints is invisible.
  There is no such process in practice — every fork and exec goes through them —
  but a process that runs entirely in a **different pid namespace** (a container
  with its own namespace) is not seen from here, only its runtime.
- Argument strings are joined with spaces, so a program that puts spaces inside
  one argument reads ambiguously. `ps` has the same behaviour, and the whole line
  has always looked this way.
