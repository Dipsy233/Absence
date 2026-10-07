// SPDX-License-Identifier: GPL-2.0
/*
 * agentwatch — the eBPF side of Linux process observation for Daze.
 *
 * Three tracepoints carry everything Daze needs, and none of them can be missed
 * the way a poll can: the kernel calls them as the event happens.
 *
 *   sched_process_fork — the parent/child relationship, which is what lets a
 *                        process be attributed to the shell command that laid it
 *                        even after the parent has exited.
 *   sched_process_exec — the executable's path. This is the Linux advantage over
 *                        netlink's proc connector, which delivers only a pid.
 *   sched_process_exit — the end of a process.
 *
 * The events go to a ring buffer, not to user-space printf: a burst of process
 * creation (a `make -j`, a shell loop) would overflow a pipe and lose events,
 * and losing events is the one thing this program exists to prevent.
 *
 * Full argv is not here. The exec tracepoint carries the executable path, and
 * the user-space side reads /proc/<pid>/cmdline for the arguments the moment the
 * event arrives — a read that is microseconds and, measured on this machine,
 * loses essentially nothing even for a process that lives a millisecond.
 */
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include <bpf/bpf_core_read.h>
#include "agentwatch.bpf.h"

/* One process event. `kind` selects which fields are meaningful; see the
 * shared header for the layout both sides agree on. */

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24); /* 16 MiB: rides out a burst without dropping */
} events SEC(".maps");

/* Scratch for the argv string being assembled. A per-CPU array, not the BPF
 * stack: the stack is 512 bytes and the buffer is larger than that. One slot per
 * CPU means no lock and no contention — each CPU writes only its own. */
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, char[ARGS_LEN]);
} argv_scratch SEC(".maps");

static __always_inline struct event *reserve(__u32 kind)
{
	struct event *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
	if (!e)
		return NULL;
	/* Zero only what is read; a full memset of the record is a large constant
	 * the verifier would have to unroll. */
	e->kind = kind;
	e->pid = 0;
	e->ppid = 0;
	e->timestamp_ns = bpf_ktime_get_ns();
	e->comm[0] = 0;
	e->path[0] = 0;
	e->args[0] = 0;
	return e;
}

/* The comm of the current task, set on every event so user space has a name even
 * before it can read /proc. */
static __always_inline void set_comm(struct event *e)
{
	bpf_get_current_comm(e->comm, sizeof(e->comm));
}

SEC("tracepoint/sched/sched_process_fork")
int handle_fork(struct trace_event_raw_sched_process_fork *ctx)
{
	struct event *e = reserve(EVENT_FORK);
	if (!e)
		return 0;
	/* The fork tracepoint runs in the parent, so the child is the new task.
	 * Its comm is the parent's until it execs, which is correct: this is the
	 * fork. */
	e->pid = ctx->child_pid;
	e->ppid = ctx->parent_pid;
	set_comm(e);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tracepoint/sched/sched_process_exec")
int handle_exec(struct trace_event_raw_sched_process_exec *ctx)
{
	struct event *e = reserve(EVENT_EXEC);
	if (!e)
		return 0;
	e->pid = ctx->pid;
	/* ppid is not in this tracepoint; user space fills it from /proc, or the
	 * fork event already established it. */
	set_comm(e);
	/* filename is a __data_loc string: the low 16 bits of the field are the
	 * offset of the characters from the start of the tracepoint record. */
	unsigned int off = ctx->__data_loc_filename & 0xFFFF;
	if (off != 0)
		bpf_probe_read_kernel_str(e->path, sizeof(e->path), (char *)ctx + off);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

/*
 * The argument vector, which no sched tracepoint carries.
 *
 * sys_enter_execve runs before the exec replaces the address space, so argv is
 * still the calling program's memory and points at the *new* arguments — which
 * is exactly what is wanted, with no window in which /proc could be stale. The
 * strings are joined with spaces; a program that puts spaces inside one argument
 * therefore reads ambiguously, which is what `ps` does too and what the whole
 * command line has always looked like.
 */
SEC("tracepoint/syscalls/sys_enter_execve")
int handle_execve(struct trace_event_raw_sys_enter *ctx)
{
	struct event *e = reserve(EVENT_ARGV);
	if (!e)
		return 0;
	e->pid = bpf_get_current_pid_tgid() >> 32;
	set_comm(e);

	const char *const *argv = (const char *const *)ctx->args[1];
	__u32 zero = 0;
	char *buf = bpf_map_lookup_elem(&argv_scratch, &zero);
	if (!buf) {
		bpf_ringbuf_discard(e, 0);
		return 0;
	}
	buf[0] = 0;

	/* Each argument goes to its own fixed slot. The slot index is the unrolled
	 * loop constant, so every destination offset the verifier sees is a
	 * compile-time constant — which is what it needs to prove the write is in
	 * range. Joining the slots into one line is user space's job. */
#pragma unroll
	for (int i = 0; i < ARGV_MAX; i++) {
		buf[i * ARG_LEN] = 0;
		const char *arg = NULL;
		if (bpf_probe_read_user(&arg, sizeof(arg), &argv[i]) != 0 || !arg)
			break;
		if (bpf_probe_read_user_str(buf + i * ARG_LEN, ARG_LEN, arg) <= 0)
			break;
	}
	bpf_probe_read_kernel(e->args, ARGS_LEN, buf);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

SEC("tracepoint/sched/sched_process_exit")
int handle_exit(struct trace_event_raw_sched_process_template *ctx)
{
	/* The tracepoint fires once per *thread* that exits, and a multithreaded
	 * process walks it with its whole thread group (node's ~7 threads read as
	 * seven deaths of one pid). Only the thread group leader's exit is the
	 * process's exit: its tid equals its tgid. */
	__u64 id = bpf_get_current_pid_tgid();
	if ((__u32)id != (id >> 32))
		return 0;
	struct event *e = reserve(EVENT_EXIT);
	if (!e)
		return 0;
	e->pid = id >> 32;
	set_comm(e);
	bpf_ringbuf_submit(e, 0);
	return 0;
}

char LICENSE[] SEC("license") = "GPL";
