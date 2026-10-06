/*
 * agentwatch — the Linux process observer Daze runs alongside the server.
 *
 * Daze cannot see the processes a shell lays by polling /proc: a process that
 * lives a millisecond is gone before the next look, and Linux offers no way to
 * close that gap except by asking the kernel to tell you. This helper does
 * exactly that, through eBPF tracepoints, and reports every fork, exec and exit
 * as it happens.
 *
 * Why eBPF and not netlink's proc connector: the connector reports an exec by
 * pid alone, so the executable's name has to be recovered afterwards from
 * /proc — which is a race, and one this program does not have to run. The
 * `sched_process_exec` tracepoint carries the path in the event itself.
 *
 * The one thing the tracepoint does not carry is the full argument vector, so
 * user space reads /proc/<pid>/cmdline the moment an exec arrives. That read is
 * a few microseconds, and measured on this machine it loses almost nothing even
 * for a process that lives a millisecond.
 *
 * Output is one JSON object per line on stdout, the same shape as the Windows
 * observer, so the Daze side parses both with one code path:
 *
 *   {"ev":"ready"}
 *   {"ev":"start","pid":1,"ppid":0,"path":"/usr/bin/bash","cmd":"bash -c …","comm":"bash"}
 *   {"ev":"exit","pid":1,"code":0}
 *
 * Privileges: loading BPF needs CAP_BPF + CAP_PERFMON (or root). On a machine
 * where Daze runs unprivileged, grant them to the binary:
 *
 *   sudo setcap cap_bpf,cap_perfmon+ep agentwatch-linux
 *
 * Build: see build.sh — it generates vmlinux.h from BTF, compiles the BPF
 * object with clang, and links this file against libbpf.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <libgen.h>

#include <bpf/libbpf.h>
#include <bpf/bpf.h>

#include "agentwatch.skel.h"
#include "agentwatch.bpf.h"

static volatile sig_atomic_t exiting = 0;

static void on_signal(int sig)
{
	(void)sig;
	exiting = 1;
}

/* Read a whole /proc/<pid>/cmdline into `buf` (NUL-separated argv), turning the
 * separators into spaces. Returns the length written, or 0 when the process is
 * already gone — which is not an error, only a very short life. */
static size_t read_cmdline(int pid, char *buf, size_t cap)
{
	char path[64];
	snprintf(path, sizeof(path), "/proc/%d/cmdline", pid);
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0)
		return 0;
	ssize_t n = read(fd, buf, cap - 1);
	close(fd);
	if (n <= 0) {
		buf[0] = 0;
		return 0;
	}
	buf[n] = 0;
	for (ssize_t i = 0; i < n - 1; i++)
		if (buf[i] == 0)
			buf[i] = ' ';
	return (size_t)n;
}

/* Escape a string into a JSON body (without the surrounding quotes). */
static void json_escape(const char *src, char *dst, size_t cap)
{
	size_t out = 0;
	for (const unsigned char *p = (const unsigned char *)src; *p && out + 7 < cap; p++) {
		switch (*p) {
		case '"':  dst[out++] = '\\'; dst[out++] = '"';  break;
		case '\\': dst[out++] = '\\'; dst[out++] = '\\'; break;
		case '\n': dst[out++] = '\\'; dst[out++] = 'n';  break;
		case '\r': dst[out++] = '\\'; dst[out++] = 'r';  break;
		case '\t': dst[out++] = '\\'; dst[out++] = 't';  break;
		default:
			if (*p < 0x20) {
				out += (size_t)snprintf(dst + out, cap - out, "\\u%04x", *p);
			} else {
				dst[out++] = (char)*p;
			}
			break;
		}
	}
	dst[out] = 0;
}

/* Arguments captured by sys_enter_execve, waiting for the sched_process_exec
 * that announces the same pid. The two tracepoints fire for one exec and give
 * different halves of it: exec has the resolved path, execve has argv. They are
 * microseconds apart, so a small table holds the join. */
struct pending_args {
	unsigned int pid;
	char args[ARGS_LEN];
};

#define PENDING_MAX 256
static struct pending_args pending[PENDING_MAX];

static void remember_args(unsigned int pid, const char *args)
{
	unsigned int slot = pid % PENDING_MAX;
	pending[slot].pid = pid;
	memcpy(pending[slot].args, args, sizeof(pending[slot].args));
}

/* Join the NUL-separated argument slots the BPF side wrote into one line. */
static void join_args(const char *slots, char *out, size_t cap)
{
	size_t written = 0;
	for (int i = 0; i < ARGV_MAX; i++) {
		const char *arg = slots + i * ARG_LEN;
		if (arg[0] == 0)
			break;
		if (written > 0 && written < cap - 1)
			out[written++] = ' ';
		size_t n = strnlen(arg, ARG_LEN);
		if (written + n > cap - 1)
			n = cap - 1 - written;
		memcpy(out + written, arg, n);
		written += n;
		if (written >= cap - 1)
			break;
	}
	out[written] = 0;
}

static const char *take_args(unsigned int pid, char *out, size_t cap)
{
	unsigned int slot = pid % PENDING_MAX;
	if (pending[slot].pid != pid)
		return NULL;
	pending[slot].pid = 0;
	join_args(pending[slot].args, out, cap);
	return out;
}

static int handle_event(void *ctx, void *data, size_t len)
{
	(void)ctx;
	if (data == NULL) {
		/* A ring buffer reports loss by calling the sample callback with no
		 * data. It should not happen — the buffer is 16 MiB — but saying so
		 * beats a silently incomplete picture. */
		fprintf(stderr, "agentwatch: ring buffer lost events\n");
		return 0;
	}
	(void)len;
	struct event *e = data;

	switch (e->kind) {
	case EVENT_FORK:
		printf("{\"ev\":\"fork\",\"pid\":%u,\"ppid\":%u}\n", e->pid, e->ppid);
		break;
	case EVENT_ARGV:
		remember_args(e->pid, e->args);
		return 0;
	case EVENT_EXEC: {
		char joined[4096];
		char cmd[4096];
		char escaped[16384];
		/* Prefer the argv from execve; fall back to /proc, then to the path.
		 * The path is always right, so a missing command line degrades to it
		 * rather than to nothing. */
		if (take_args(e->pid, joined, sizeof(joined)))
			snprintf(cmd, sizeof(cmd), "%s", joined);
		else if (read_cmdline((int)e->pid, cmd, sizeof(cmd)) == 0)
			snprintf(cmd, sizeof(cmd), "%s", e->path);
		json_escape(cmd, escaped, sizeof(escaped));
		printf("{\"ev\":\"start\",\"pid\":%u,\"comm\":\"%s\",\"path\":\"%s\",\"cmd\":\"%s\"}\n",
		       e->pid, e->comm, e->path, escaped);
		break;
	}
	case EVENT_EXIT:
		printf("{\"ev\":\"exit\",\"pid\":%u}\n", e->pid);
		break;
	default:
		return 0;
	}
	fflush(stdout);
	return 0;
}

int main(int argc, char **argv)
{
	(void)argc;
	(void)argv;

	struct agentwatch_bpf *skel = agentwatch_bpf__open_and_load();
	if (!skel) {
		fprintf(stderr,
			"agentwatch: failed to load BPF program: %s\n"
			"  needs CAP_BPF + CAP_PERFMON (or root): sudo setcap cap_bpf,cap_perfmon+ep agentwatch-linux\n",
			strerror(errno));
		return 1;
	}
	if (agentwatch_bpf__attach(skel)) {
		fprintf(stderr, "agentwatch: failed to attach tracepoints: %s\n", strerror(errno));
		agentwatch_bpf__destroy(skel);
		return 1;
	}

	struct ring_buffer_opts rb_opts = { .sz = sizeof(rb_opts) };
	struct ring_buffer *rb = ring_buffer__new(bpf_map__fd(skel->maps.events), handle_event, NULL, &rb_opts);
	if (!rb) {
		fprintf(stderr, "agentwatch: failed to create ring buffer: %s\n", strerror(errno));
		agentwatch_bpf__destroy(skel);
		return 1;
	}

	signal(SIGINT, on_signal);
	signal(SIGTERM, on_signal);

	printf("{\"ev\":\"ready\"}\n");
	fflush(stdout);

	while (!exiting) {
		int err = ring_buffer__poll(rb, 200 /* ms */);
		if (err == -EINTR)
			continue;
		if (err < 0) {
			fprintf(stderr, "agentwatch: ring buffer poll failed: %d\n", err);
			break;
		}
	}

	ring_buffer__free(rb);
	agentwatch_bpf__destroy(skel);
	return 0;
}
