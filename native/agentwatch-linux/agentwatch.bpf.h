/* The event layout shared by the BPF program and its user-space consumer.
 * Kept in its own header so the struct cannot drift between the two.
 *
 * It is `event`, not `proc_event`, to avoid colliding with the kernel's own
 * <linux/cn_proc.h> name when both are in scope during a debugging session. */
#ifndef AGENTWATCH_BPF_H
#define AGENTWATCH_BPF_H

#define TASK_COMM_LEN 16
#define PATH_LEN 256

enum event_kind {
	EVENT_FORK = 1,
	EVENT_EXEC = 2,
	EVENT_EXIT = 3,
	/* The argument vector for a pid, from sys_enter_execve. Sent separately from
	 * EVENT_EXEC because it comes from a different tracepoint; user space joins
	 * the two by pid. */
	EVENT_ARGV = 4,
};

#define ARGV_MAX 8
#define ARG_LEN 128
#define ARGS_LEN (ARGV_MAX * ARG_LEN)

struct event {
	unsigned int kind;
	unsigned int pid;
	unsigned int ppid;
	unsigned long long timestamp_ns;
	char comm[TASK_COMM_LEN];
	char path[PATH_LEN];
	/* The full command line: the argument slots, NUL-separated, exactly as the
	 * BPF side leaves them. User space joins them into one line. */
	char args[ARGS_LEN];
};

#endif /* AGENTWATCH_BPF_H */
