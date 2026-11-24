# agentwatch

The Windows process observer Absence runs next to the server.

## Why

`ProcessWatcher` used to poll: take a snapshot of every process on the machine,
diff it against the previous one, and guess which new rows a shell command laid.
Polling cannot see a process that lives 20 ms — by the next snapshot it is gone.
That is not a tuning problem; it is the sampling theorem. On a busy machine a
`git status` or a `node -e` leaves no trace at all.

`agentwatch` removes the sampling: it asks the Windows kernel to report every
process creation and exit as it happens.

`--target-pid <pid>` adopts **any** process the user can open, not just the
server. That is what makes Absence a pure third-party monitor: the user keeps
running pi in their own terminal, Absence opens that pi by pid and assigns it
to a fresh Job Object, and the kernel then reports the pi's whole subtree —
no proxy, no launcher, no change to how the user works. The server-wide
observer is just the special case `--target-pid <server pid>`.

## How

A **Job Object** is a kernel container. Every process assigned to a job, and
every descendant it spawns afterwards, joins the same job. The server is placed
into a job *after it has already started* — `agentwatch` opens it by pid and
calls `AssignProcessToJobObject`, which needs only `PROCESS_SET_QUOTA` and
`PROCESS_TERMINATE`. No cooperation from Pi, the SDK, or the server's own code.

An **IO completion port** associated with the job turns creation and exit into
queued events. Creation is read from the port. Exits are read from a second,
stronger source: a **thread-pool wait** is registered on every process handle
(`RegisterWaitForSingleObject`), and a process handle goes signaled the moment
the process exits. A `JOB_OBJECT_MSG_EXIT_PROCESS` message can be dropped when a
whole tree is terminated in one burst (`taskkill /T`, a runtime tearing down its
shell), but a signaled kernel handle cannot — so the wait is authoritative and
the port message is the fallback for processes no handle was opened on.

```
agentwatch.exe --target-pid <server pid>
        │
        ├─ CreateJobObject
        ├─ CreateIoCompletionPort + JobObjectAssociateCompletionPortInformation
        ├─ OpenProcess(server) + AssignProcessToJobObject(server)
        ├─ loop GetQueuedCompletionStatus
        │     JOB_OBJECT_MSG_NEW_PROCESS  → on_new
        │     JOB_OBJECT_MSG_EXIT_PROCESS → on_exit  (fallback)
        └─ per process: RegisterWaitForSingleObject(handle) → on_handle_signaled
              (authoritative exit — the handle signal cannot be lost)
```

From then on the server, Pi, the shell Pi spawns for each `bash` tool call, and
everything those shells spawn are all in the job.

### Deliberate choices

- **No `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.** If `agentwatch` dies, the server
  and the agent's own daemons must keep running. Absence observes; it does not own.
- **No `JOB_OBJECT_LIMIT_BREAKAWAY_OK`.** A descendant must not be able to leave
  the job and become invisible.
- **One process, no PowerShell, no WMI, no administrator.** The job API needs no
  privilege beyond rights over the target process, which the same user has.

## Output

One JSON object per line, on stdout. Diagnostics go to stderr.

| Event | Fields |
|---|---|
| `ready` | `target` |
| `start` | `pid`, `ppid`, `create` (unix ms), `path`, `cmd`, `cmdTruncated` |
| `start` (lost) | `pid`, `lost:true` — the process exited before it could be opened |
| `exit` | `pid`, `durMs`, `cpuMs`, `code` |
| `exit` (unseen) | `pid` — an exit with no matching start |
| `metric` | `pid`, `cpuMs`, `rss`, `vsz`, `threads`, `handles`, `ioR`, `ioW` |
| `host` | `cpuMs`, `idleMs`, `cores`, `memTotal`, `memAvail` |
| `table_row` | `pid`, `ppid`, `s` (unix ms), `name`, `cmd` — one process of a table snapshot |
| `table_done` | a `table` request is finished |
| `sample_done` | one sampling pass finished |
| `active_zero` | the job is momentarily empty (informational) |
| `target_gone` | the observed server exited; the helper is about to stop |
| `error` | `what`, `code` |

A `lost:true` start is not a failure. It means a process was created *and*
exited before `agentwatch` could open it — the event still proves it existed,
which is exactly what polling could never do.

### stdin commands

| Command | Effect |
|---|---|
| `sample [pid,pid,…]` | one resource pass over the handles held (borrowing handles for the named pids) |
| `table` | one full process-table snapshot: Toolhelp walk, one handle per process, rows out as `table_row` lines until `table_done` |

`table` is what the server uses instead of spawning a PowerShell/CIM query for
a baseline or a fallback sweep — tens of milliseconds instead of about a
second. Rows interleave freely with other output; every line is serialized by
the write lock and the server pairs rows with its request by the
`table_done` terminator. The helper excludes its own pid from the rows.

## Build

MinGW (the toolchain present on the development machine):

```sh
g++ -O2 -municode -o agentwatch.exe agentwatch.c -lntdll
```

MSVC (for a release build, run from a Developer Command Prompt):

```bat
cl /O2 /W4 /DWIN32_LEAN_AND_MEAN agentwatch.c /link ntdll.lib
```

The resulting `agentwatch.exe` is committed prebuilt so users do not need a
compiler. Rebuild it whenever `agentwatch.c` changes.

## Known limits

Any process that does **not** descend from the server is invisible: WMI-created
processes, scheduled tasks, COM servers, and processes started through a UAC
elevation. No non-administrator method can see those. This is documented as a
known limitation rather than worked around.

## Linux

`agentwatch` is Windows-only. A Linux observer needs a different mechanism
(POSIX process connectors over netlink, or cgroup v2), and lives in a sibling
directory when it is written.
