/*
 * agentwatch — the process observer Absence runs alongside the server.
 *
 * Absence cannot see the processes Pi's shell tools spawn by polling `ps`/CIM:
 * a process that lives 20 ms is simply not there when the next snapshot lands.
 * This helper removes the sampling problem entirely by asking the kernel to
 * report every process creation and exit as it happens.
 *
 * How it works
 * ------------
 * A Windows Job Object is a kernel container. Every process assigned to a job,
 * and every descendant it spawns afterwards, joins the same job — including
 * processes spawned by `child_process.spawn`, with no cooperation from them.
 * Associating an IO completion port with the job turns creation/exit into
 * queued events, so there is nothing to poll.
 *
 * Creation is read from that port. Exits are read from a second, stronger
 * source: a thread-pool wait (`RegisterWaitForSingleObject`) is registered on
 * every process handle the observer opens, and a process handle goes signaled
 * the instant the process exits. A Job-Object EXIT_PROCESS message can be lost
 * when a whole tree is terminated at once (`taskkill /T`, a runtime tearing
 * down its shell), but a signaled kernel handle cannot — so the wait is the
 * authoritative exit, and the completion-port message is the fallback for
 * processes the observer never got a handle on.
 *
 * The server is placed into the job *after* it has started (see main): the
 * caller passes its pid on the command line, and we open it with
 * PROCESS_SET_QUOTA | PROCESS_TERMINATE — the two rights
 * AssignProcessToJobObject needs. This is the whole reason the server does not
 * have to launch Pi itself: any already-running process can be adopted, so the
 * SDK's in-process model is untouched.
 *
 * Deliberate choices
 * ------------------
 *  - No JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: if this helper dies, the server and
 *    the agent's own daemons must keep running. Absence observes; it does not own.
 *  - No JOB_OBJECT_LIMIT_BREAKAWAY_OK: a descendant must not be able to leave
 *    the job and become invisible.
 *  - The job is not configured with a process limit; the completion port is the
 *    only thing we read from it.
 *  - Events are written to stdout as one JSON object per line. Stderr carries
 *    diagnostics only.
 *
 * Build (Windows, MinGW):
 *   g++ -O2 -municode -o agentwatch.exe agentwatch.c -lntdll
 * See native/agentwatch/README.md for the MSVC equivalent.
 */

#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <winternl.h>
#include <tlhelp32.h>
#include <psapi.h>
#include <stdio.h>
#include <wchar.h>
#include <stdint.h>
#include <string.h>

#pragma comment(lib, "ntdll.lib")
#pragma comment(lib, "psapi.lib")

typedef LONG NTSTATUS;

/* ProcessCommandLineInformation — documented in winternl.h only for the
 * informational classes; class 60 is stable since Windows 8.1. */
#define PROCESS_COMMAND_LINE_INFORMATION ((PROCESSINFOCLASS)60)

/* One 64 KiB buffer per process is enough for any realistic command line;
 * anything longer is reported truncated (`cmdTruncated`). */
#define CMD_BUFFER_BYTES (64 * 1024)

/* ------------------------------------------------------------------ */
/* stdout: one JSON line per event                                     */
/* ------------------------------------------------------------------ */

/* Escape a wide string into a UTF-8 JSON string body (without the quotes).
 * Writes at most `cap` bytes plus a terminator and returns the length. */
static size_t json_escape_utf8(const WCHAR *src, size_t srcLen, char *dst, size_t cap)
{
    size_t out = 0;
    if (cap == 0) return 0;
    for (size_t i = 0; i < srcLen && src[i]; i++) {
        WCHAR c = src[i];
        char buf[8];
        size_t n = 0;
        switch (c) {
        case L'"':  buf[n++] = '\\'; buf[n++] = '"';  break;
        case L'\\': buf[n++] = '\\'; buf[n++] = '\\'; break;
        case L'\n': buf[n++] = '\\'; buf[n++] = 'n';  break;
        case L'\r': buf[n++] = '\\'; buf[n++] = 'r';  break;
        case L'\t': buf[n++] = '\\'; buf[n++] = 't';  break;
        case L'\b': buf[n++] = '\\'; buf[n++] = 'b';  break;
        case L'\f': buf[n++] = '\\'; buf[n++] = 'f';  break;
        default:
            if (c < 0x20) {
                n = (size_t)snprintf(buf, sizeof buf, "\\u%04x", (unsigned)c);
            } else if (c < 0x80) {
                buf[n++] = (char)c;
            } else {
                /* Encode UTF-16 → UTF-8, folding a surrogate pair into one code point. */
                uint32_t cp = c;
                if (c >= 0xD800 && c <= 0xDBFF && i + 1 < srcLen) {
                    WCHAR lo = src[i + 1];
                    if (lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000u + (((uint32_t)(c - 0xD800u)) << 10) + (lo - 0xDC00u);
                        i++;
                    }
                }
                if (cp < 0x800) {
                    buf[n++] = (char)(0xC0 | (cp >> 6));
                    buf[n++] = (char)(0x80 | (cp & 0x3F));
                } else if (cp < 0x10000) {
                    buf[n++] = (char)(0xE0 | (cp >> 12));
                    buf[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    buf[n++] = (char)(0x80 | (cp & 0x3F));
                } else {
                    buf[n++] = (char)(0xF0 | (cp >> 18));
                    buf[n++] = (char)(0x80 | ((cp >> 12) & 0x3F));
                    buf[n++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                    buf[n++] = (char)(0x80 | (cp & 0x3F));
                }
            }
            break;
        }
        if (out + n >= cap) break;
        memcpy(dst + out, buf, n);
        out += n;
    }
    dst[out] = '\0';
    return out;
}

static ULONGLONG filetime_to_unix_ms(FILETIME ft)
{
    /* 100-ns ticks since 1601-01-01 → ms since 1970-01-01. */
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return t / 10000ULL - 11644473600000ULL;
}

/* Serialises JSON writes: the completion-port loop and the thread-pool wait
 * callbacks all emit to the same stdout. Without this, two exits at once can
 * interleave into a corrupt line. */
static CRITICAL_SECTION g_write_lock;

static void emit_json_line(const char *body)
{
    EnterCriticalSection(&g_write_lock);
    fputs(body, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    LeaveCriticalSection(&g_write_lock);
}

/* ------------------------------------------------------------------ */
/* per-process bookkeeping                                             */
/* ------------------------------------------------------------------ */

/* pid → handle. A hashtable rather than an array: pids are DWORDs, not a
 * 16-bit index, and the original array-indexed version wrote out of bounds
 * for any pid above 65535. */
typedef struct ProcNode {
    DWORD pid;
    HANDLE handle;
    /* The thread-pool wait registered on `handle`. A process handle becomes
     * signaled the instant the process exits, and that signal is a kernel
     * object state — it cannot be dropped the way a Job-Object completion-port
     * message can. The wait is what makes an exit event unmissable. */
    HANDLE wait;
    /* Live thread count, recomputed by each sampling pass (one Toolhelp
     * snapshot per pass, not per process). */
    DWORD threads;
    /* Opened on demand for an *observed* agent's tree: a handle we sample but
     * never report creation/exit for. Those processes belong to somebody
     * else's job, so they get no exit wait and no events — only counters. */
    int borrowed;
    struct ProcNode *next;
} ProcNode;

#define BUCKETS 1024
static ProcNode *g_table[BUCKETS];
static CRITICAL_SECTION g_lock;
static HANDLE g_target_handle = NULL;

/* Defined after `take`/`emit_json_line`; a process handle signaled = it exited. */
static void CALLBACK on_handle_signaled(PVOID ctx, BOOLEAN timed_out);

static unsigned bucket(DWORD pid) { return (unsigned)(pid * 2654435761u) % BUCKETS; }

static void remember(DWORD pid, HANDLE h)
{
    EnterCriticalSection(&g_lock);
    unsigned b = bucket(pid);
    for (ProcNode *n = g_table[b]; n; n = n->next) {
        if (n->pid == pid) {
            /* NULL, never INVALID_HANDLE_VALUE: this runs under g_lock, and
             * the blocking form would wait on a callback that needs g_lock. */
            if (n->wait) { UnregisterWaitEx(n->wait, NULL); n->wait = NULL; }
            CloseHandle(n->handle);
            n->handle = h;
            n->wait = NULL;
            if (!RegisterWaitForSingleObject(&n->wait, h, on_handle_signaled,
                                             (PVOID)(ULONG_PTR)pid, INFINITE, WT_EXECUTEONLYONCE)) {
                n->wait = NULL;
            }
            LeaveCriticalSection(&g_lock);
            return;
        }
    }
    ProcNode *n = (ProcNode *)malloc(sizeof(ProcNode));
    if (n) {
        n->pid = pid;
        n->handle = h;
        n->wait = NULL;
        n->threads = 0;
        n->borrowed = 0;
        n->next = g_table[b];
        g_table[b] = n;
        if (!RegisterWaitForSingleObject(&n->wait, h, on_handle_signaled,
                                         (PVOID)(ULONG_PTR)pid, INFINITE, WT_EXECUTEONLYONCE)) {
            n->wait = NULL;
        }
    }
    LeaveCriticalSection(&g_lock);
}

/* Find a node without removing it. Caller holds g_lock. */
static ProcNode *find_locked(DWORD pid)
{
    for (ProcNode *n = g_table[bucket(pid)]; n; n = n->next) {
        if (n->pid == pid) return n;
    }
    return NULL;
}

/* Sample a pid that is not in our job — an observed agent's tree. No exit wait
 * is registered: those processes are not ours to report, only to measure. */
static void remember_borrowed(DWORD pid)
{
    EnterCriticalSection(&g_lock);
    if (!find_locked(pid)) {
        HANDLE h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid);
        if (h) {
            ProcNode *n = (ProcNode *)malloc(sizeof(ProcNode));
            if (n) {
                n->pid = pid;
                n->handle = h;
                n->wait = NULL;
                n->threads = 0;
                n->borrowed = 1;
                unsigned b = bucket(pid);
                n->next = g_table[b];
                g_table[b] = n;
            } else {
                CloseHandle(h);
            }
        }
    }
    LeaveCriticalSection(&g_lock);
}

static HANDLE take(DWORD pid)
{
    EnterCriticalSection(&g_lock);
    unsigned b = bucket(pid);
    HANDLE h = NULL;
    ProcNode **link = &g_table[b];
    while (*link) {
        if ((*link)->pid == pid) {
            ProcNode *dead = *link;
            h = dead->handle;
            /* WT_EXECUTEONLYONCE has already auto-unregistered the wait when
             * this runs from the callback, so the call fails harmlessly. When
             * it runs from the completion-port path the wait is still live and
             * must be cancelled. NULL = do not block: the blocking form
             * (INVALID_HANDLE_VALUE) waits for a pending callback to complete,
             * and that callback needs g_lock to run — a deadlock we lose
             * whenever the completion-port message beats the thread pool to an
             * exit, which under pid churn happens within minutes. The two exit
             * paths already race safely (whoever arrives first owns the node). */
            if (dead->wait) { UnregisterWaitEx(dead->wait, NULL); dead->wait = NULL; }
            *link = dead->next;
            free(dead);
            break;
        }
        link = &(*link)->next;
    }
    LeaveCriticalSection(&g_lock);
    return h;
}

/* ------------------------------------------------------------------ */
/* events                                                              */
/* ------------------------------------------------------------------ */

/* Read the command line via NtQueryInformationProcess. Returns a heap buffer
 * the caller frees, and sets *len (in wide chars) and *truncated. */
static WCHAR *read_command_line(HANDLE h, size_t *len, int *truncated)
{
    *len = 0;
    *truncated = 0;
    ULONG size = CMD_BUFFER_BYTES;
    BYTE *buf = (BYTE *)malloc(size);
    if (!buf) return NULL;
    ULONG needed = 0;
    NTSTATUS st = NtQueryInformationProcess(h, PROCESS_COMMAND_LINE_INFORMATION, buf, size, &needed);
    if (st < 0) {
        free(buf);
        return NULL;
    }
    UNICODE_STRING *us = (UNICODE_STRING *)buf;
    if (!us->Buffer || us->Length == 0) {
        free(buf);
        return NULL;
    }
    if ((ULONG)us->Length + sizeof(UNICODE_STRING) > size) *truncated = 1;
    size_t chars = us->Length / sizeof(WCHAR);
    WCHAR *out = (WCHAR *)malloc((chars + 1) * sizeof(WCHAR));
    if (!out) { free(buf); return NULL; }
    memcpy(out, us->Buffer, chars * sizeof(WCHAR));
    out[chars] = 0;
    *len = chars;
    free(buf);
    return out;
}

/* The marker Absence injects into the agent runtime's shell environment
 * (Codex: `shell_environment_policy.set`, verified to survive PowerShell and
 * detached `Start-Process` children). When a spawned process inherits it, the
 * process belongs to that Absence session even though Absence could not wrap
 * the runtime's shell. Reported as `sess` on the start event.
 *
 * The environment is NOT reachable through NtQueryInformationProcess class 61:
 * that class returns a remote-pointer structure whose Buffer lives in the
 * target's address space. The reliable read is the PEB walk below.
 *
 * x64 layout (verified empirically on Windows 10/11):
 *   PEB + 0x20          -> RTL_USER_PROCESS_PARAMETERS *
 *   parameters + 0x80   -> Environment (remote WCHAR block, NUL-separated)
 *   parameters + 0x3F0  -> EnvironmentSize (bytes)
 */
static const WCHAR ABSENCE_SESSION_ENV[] = L"ABSENCE_SESSION_ID=";

static WCHAR *read_session_marker(HANDLE h, size_t *len)
{
    *len = 0;
    PROCESS_BASIC_INFORMATION pbi;
    if (NtQueryInformationProcess(h, ProcessBasicInformation, &pbi, sizeof pbi, NULL) < 0) return NULL;

    BYTE peb[512];
    SIZE_T got = 0;
    if (!ReadProcessMemory(h, pbi.PebBaseAddress, peb, sizeof peb, &got)) return NULL;
    if (got < 0x28) return NULL;
    BYTE *params = *(BYTE **)(peb + 0x20);
    if (!params) return NULL;

    BYTE pbuf[0x400];
    if (!ReadProcessMemory(h, params, pbuf, sizeof pbuf, &got)) return NULL;
    if (got < 0x3F8) return NULL;
    BYTE *envRemote = *(BYTE **)(pbuf + 0x80);
    SIZE_T envSize = *(SIZE_T *)(pbuf + 0x3F0);
    if (!envRemote || envSize == 0 || envSize > 4u * 1024 * 1024) return NULL;

    BYTE *env = (BYTE *)malloc(envSize);
    if (!env) return NULL;
    if (!ReadProcessMemory(h, envRemote, env, envSize, &got)) {
        free(env);
        return NULL;
    }

    /* Entries are `NAME=VALUE` wide strings separated by NUL, ended by an
     * empty one. Scan on 2-byte boundaries until the needle matches. */
    size_t nameLen = (sizeof(ABSENCE_SESSION_ENV) / sizeof(WCHAR)) - 1;
    WCHAR *found = NULL;
    for (SIZE_T i = 0; i + nameLen * sizeof(WCHAR) < got; i += sizeof(WCHAR)) {
        const WCHAR *entry = (const WCHAR *)(env + i);
        if (_wcsnicmp(entry, ABSENCE_SESSION_ENV, nameLen) != 0) continue;
        const WCHAR *value = entry + nameLen;
        SIZE_T avail = (got - i) / sizeof(WCHAR) - nameLen;
        size_t vlen = 0;
        while (vlen < avail && value[vlen]) vlen++;
        found = (WCHAR *)malloc((vlen + 1) * sizeof(WCHAR));
        if (found) { memcpy(found, value, vlen * sizeof(WCHAR)); found[vlen] = 0; *len = vlen; }
        break;
    }
    free(env);
    return found;
}

static void on_new(DWORD pid)
{
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, pid);
    if (!h) {
        char line[128];
        snprintf(line, sizeof line, "{\"ev\":\"start\",\"pid\":%lu,\"lost\":true}", (unsigned long)pid);
        emit_json_line(line);
        return;
    }
    remember(pid, h);
    FILETIME created, exitT, kernel, user;
    GetProcessTimes(h, &created, &exitT, &kernel, &user);

    WCHAR path[MAX_PATH * 2];
    DWORD pathLen = (DWORD)(sizeof path / sizeof path[0]);
    QueryFullProcessImageNameW(h, 0, path, &pathLen);
    path[(sizeof path / sizeof path[0]) - 1] = 0;

    size_t cmdChars = 0;
    int truncated = 0;
    WCHAR *cmd = read_command_line(h, &cmdChars, &truncated);

    /* Parent pid, O(1): ProcessBasicInformation carries
     * InheritedFromUniqueProcessId, so there is no snapshot to walk and no
     * window in which a short-lived child disappears before it is found.
     * (The Toolhelp32 walk this replaced was itself the reason short-lived
     * children came back with ppid=0.) */
    DWORD ppid = 0;
    PROCESS_BASIC_INFORMATION pbi;
    if (NtQueryInformationProcess(h, ProcessBasicInformation, &pbi, sizeof pbi, NULL) >= 0) {
        ppid = (DWORD)(ULONG_PTR)pbi.InheritedFromUniqueProcessId;
    }

    /* One buffer, sized from the raw UTF-16 lengths: worst case is 6 bytes per
     * character (\uXXXX) plus the fixed JSON scaffolding. The old per-field
     * copies computed a capacity too small for non-BMP characters and for
     * escapes, and could read past the end of a neighbouring allocation. */
    size_t pathBytes = ((size_t)pathLen * 6) + 16;
    size_t cmdBytes = ((cmdChars ? cmdChars : 1) * 6) + 16;
    char *pathJson = (char *)malloc(pathBytes);
    char *cmdJson = (char *)malloc(cmdBytes);
    if (!pathJson || !cmdJson) {
        free(pathJson); free(cmdJson); if (cmd) free(cmd);
        return;
    }
    json_escape_utf8(path, pathLen, pathJson, pathBytes);
    if (cmd) json_escape_utf8(cmd, cmdChars, cmdJson, cmdBytes);
    else cmdJson[0] = '\0';

    /* The session marker, when the process inherited one. Absent on anything
     * the machine runs on its own; present on the runtime's shell tree. */
    size_t sessChars = 0;
    WCHAR *sess = read_session_marker(h, &sessChars);
    size_t sessBytes = ((sessChars ? sessChars : 1) * 6) + 16;
    char *sessJson = (char *)malloc(sessBytes);
    if (sess) json_escape_utf8(sess, sessChars, sessJson, sessBytes);
    else sessJson[0] = '\0';

    size_t cap = pathBytes + cmdBytes + sessBytes + 320;
    char *line = (char *)malloc(cap);
    if (line) {
        snprintf(line, cap,
            "{\"ev\":\"start\",\"pid\":%lu,\"ppid\":%lu,\"create\":%llu,\"path\":\"%s\",\"cmd\":\"%s\",\"cmdTruncated\":%s,\"sess\":\"%s\"}",
            (unsigned long)pid, (unsigned long)ppid, filetime_to_unix_ms(created),
            pathJson, cmdJson, truncated ? "true" : "false", sessJson);
        emit_json_line(line);
        free(line);
    }
    free(pathJson);
    free(cmdJson);
    free(sessJson);
    if (cmd) free(cmd);
    if (sess) free(sess);
}

static void on_exit(DWORD pid)
{
    HANDLE h = take(pid);
    if (!h) {
        char line[96];
        snprintf(line, sizeof line, "{\"ev\":\"exit\",\"pid\":%lu}", (unsigned long)pid);
        emit_json_line(line);
        return;
    }
    /* The listener holds the handle, so the process object outlives the
     * process itself; the exit event is already queued, so this returns at
     * once. It is *not* an infinite wait — that would stall the event loop. */
    WaitForSingleObject(h, 0);
    FILETIME created, exitT, kernel, user;
    GetProcessTimes(h, &created, &exitT, &kernel, &user);
    DWORD code = 0;
    GetExitCodeProcess(h, &code);
    char line[256];
    snprintf(line, sizeof line,
        "{\"ev\":\"exit\",\"pid\":%lu,\"durMs\":%llu,\"cpuMs\":%llu,\"code\":%lu}",
        (unsigned long)pid,
        (unsigned long long)(filetime_to_unix_ms(exitT) - filetime_to_unix_ms(created)),
        (unsigned long long)((((ULONGLONG)kernel.dwHighDateTime << 32 | kernel.dwLowDateTime) +
                              ((ULONGLONG)user.dwHighDateTime << 32 | user.dwLowDateTime)) / 10000ULL),
        (unsigned long)code);
    emit_json_line(line);
    CloseHandle(h);
}

/* ------------------------------------------------------------------ */
/* resource sampling                                                   */
/* ------------------------------------------------------------------ */

/*
 * The kernel events above say *when* a process exists. They say nothing about
 * how much CPU or memory it uses, and Job-Object accounting only reports the
 * whole job's totals — never one process. But this helper already holds a
 * handle per process, so a metric pass is just GetProcessTimes and
 * GetProcessMemoryInfo on handles we own: no WMI, no CIM query, no
 * re-enumeration of the process table, no extra privilege.
 *
 * The server drives the cadence: it writes "sample" on stdin when its own
 * sampler ticks, so an idle session costs nothing and a dashboard watching one
 * egg gets exactly the interval it asked for.
 */

/* A metric pass, copied out of the table so the lock is not held while writing
 * to stdout (a blocked write must never stall exit reporting). */
typedef struct MetricRow {
    DWORD pid;
    ULONGLONG cpuMs;
    ULONGLONG rss;
    ULONGLONG vsz;
    ULONGLONG ioRead;
    ULONGLONG ioWrite;
    DWORD threads;
    DWORD handles;
} MetricRow;

/* A FILETIME *duration* (kernel/system times are elapsed 100-ns ticks, not
 * timestamps) → milliseconds. */
static ULONGLONG ft_ticks_ms(FILETIME ft)
{
    ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
    return t / 10000ULL;
}

static void emit_host_metrics(void)
{
    FILETIME idle, kernel, user;
    if (!GetSystemTimes(&idle, &kernel, &user)) return;
    MEMORYSTATUSEX mem;
    mem.dwLength = sizeof mem;
    if (!GlobalMemoryStatusEx(&mem)) return;
    SYSTEM_INFO info;
    GetSystemInfo(&info);

    /* GetSystemTimes reports kernel time *inclusive of* idle, so the counters
     * stay consistent with the /proc path: cpu = busy + idle, idle separately
     * (the server derives busy as cpu - idle). */
    char line[320];
    snprintf(line, sizeof line,
        "{\"ev\":\"host\",\"cpuMs\":%llu,\"idleMs\":%llu,\"cores\":%lu,\"memTotal\":%llu,\"memAvail\":%llu}",
        (unsigned long long)(ft_ticks_ms(kernel) + ft_ticks_ms(user)),
        (unsigned long long)ft_ticks_ms(idle),
        (unsigned long)info.dwNumberOfProcessors,
        (unsigned long long)mem.ullTotalPhys,
        (unsigned long long)mem.ullAvailPhys);
    emit_json_line(line);
}

/* Recompute every node's thread count from one Toolhelp snapshot. Called with
 * g_lock held. */
static void refresh_thread_counts_locked(void)
{
    for (unsigned i = 0; i < BUCKETS; i++) {
        for (ProcNode *n = g_table[i]; n; n = n->next) n->threads = 0;
    }
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return;
    THREADENTRY32 te;
    te.dwSize = sizeof te;
    if (Thread32First(snap, &te)) {
        do {
            unsigned b = bucket(te.th32OwnerProcessID);
            for (ProcNode *n = g_table[b]; n; n = n->next) {
                if (n->pid == te.th32OwnerProcessID) {
                    n->threads++;
                    break;
                }
            }
        } while (Thread32Next(snap, &te));
    }
    CloseHandle(snap);
}

static void sample_all(void)
{
    emit_host_metrics();

    EnterCriticalSection(&g_lock);
    DWORD count = 0;
    for (unsigned i = 0; i < BUCKETS; i++) {
        for (ProcNode *n = g_table[i]; n; n = n->next) count++;
    }
    MetricRow *rows = count ? (MetricRow *)malloc(count * sizeof(MetricRow)) : NULL;
    DWORD found = 0;
    /* Borrowed handles of processes that have exited since the last pass. */
    DWORD *dead = count ? (DWORD *)malloc(count * sizeof(DWORD)) : NULL;
    DWORD deadCount = 0;
    if (rows) {
        refresh_thread_counts_locked();
        for (unsigned i = 0; i < BUCKETS; i++) {
            for (ProcNode *n = g_table[i]; n; n = n->next) {
                FILETIME created, exitT, kernel, user;
                if (!GetProcessTimes(n->handle, &created, &exitT, &kernel, &user)) {
                    if (n->borrowed && dead) dead[deadCount++] = n->pid;
                    continue;
                }
                PROCESS_MEMORY_COUNTERS_EX pmc;
                pmc.cb = sizeof pmc;
                ULONGLONG rss = 0, vsz = 0;
                if (GetProcessMemoryInfo(n->handle, (PROCESS_MEMORY_COUNTERS *)&pmc, sizeof pmc)) {
                    rss = (ULONGLONG)pmc.WorkingSetSize;
                    vsz = (ULONGLONG)pmc.PrivateUsage;
                }
                IO_COUNTERS io;
                ULONGLONG ioRead = 0, ioWrite = 0;
                if (GetProcessIoCounters(n->handle, &io)) {
                    ioRead = (ULONGLONG)io.ReadTransferCount;
                    ioWrite = (ULONGLONG)io.WriteTransferCount;
                }
                DWORD handles = 0;
                GetProcessHandleCount(n->handle, &handles);
                rows[found].pid = n->pid;
                rows[found].cpuMs = ((((ULONGLONG)kernel.dwHighDateTime << 32 | kernel.dwLowDateTime) +
                                      ((ULONGLONG)user.dwHighDateTime << 32 | user.dwLowDateTime)) / 10000ULL);
                rows[found].rss = rss;
                rows[found].vsz = vsz;
                rows[found].ioRead = ioRead;
                rows[found].ioWrite = ioWrite;
                rows[found].threads = n->threads;
                rows[found].handles = handles;
                found++;
            }
        }
    }
    LeaveCriticalSection(&g_lock);

    if (dead) {
        for (DWORD i = 0; i < deadCount; i++) {
            HANDLE h = take(dead[i]);
            if (h) CloseHandle(h);
        }
        free(dead);
    }

    for (DWORD i = 0; i < found; i++) {
        char line[288];
        snprintf(line, sizeof line,
            "{\"ev\":\"metric\",\"pid\":%lu,\"cpuMs\":%llu,\"rss\":%llu,\"vsz\":%llu,"
            "\"threads\":%lu,\"handles\":%lu,\"ioR\":%llu,\"ioW\":%llu}",
            (unsigned long)rows[i].pid,
            (unsigned long long)rows[i].cpuMs,
            (unsigned long long)rows[i].rss,
            (unsigned long long)rows[i].vsz,
            (unsigned long)rows[i].threads,
            (unsigned long)rows[i].handles,
            (unsigned long long)rows[i].ioRead,
            (unsigned long long)rows[i].ioWrite);
        emit_json_line(line);
    }
    if (rows) free(rows);
    emit_json_line("{\"ev\":\"sample_done\"}");
}

static HANDLE g_sample_event = NULL;

static DWORD WINAPI sampler_thread(LPVOID param)
{
    (void)param;
    for (;;) {
        WaitForSingleObject(g_sample_event, INFINITE);
        sample_all();
    }
    return 0;
}

/* stdin carries one command per line. Only "sample" exists: the server asks
 * for a metric pass, this thread wakes the sampler. Closing stdin ends the
 * thread; the helper keeps observing either way. */
static DWORD WINAPI stdin_thread(LPVOID param)
{
    (void)param;
    char buf[4096];
    while (fgets(buf, sizeof buf, stdin)) {
        if (strncmp(buf, "sample", 6) != 0) continue;
        /* Optional pid list: the observed agent's tree is not in our job, so
         * the server names the pids it wants measured. */
        char *rest = buf + 6;
        while (*rest == ' ' || *rest == '	') rest++;
        while (*rest >= '0' && *rest <= '9') {
            char *end = rest;
            unsigned long pid = strtoul(rest, &end, 10);
            if (end == rest) break;
            if (pid > 0) remember_borrowed((DWORD)pid);
            rest = end;
            while (*rest == ',' || *rest == ' ') rest++;
        }
        SetEvent(g_sample_event);
    }
    return 0;
}

/*
 * The thread pool fired because a process handle went signaled — the process
 * has exited. This is the reliable exit path: a process handle's signal is
 * kernel object state, so unlike a Job-Object completion-port message it cannot
 * be lost when a whole tree dies at once. The completion-port EXIT message is
 * kept as a second opinion, and `take` makes the two race safely: whichever
 * runs first owns the node and emits, the other finds no node and stays quiet.
 */
static void CALLBACK on_handle_signaled(PVOID ctx, BOOLEAN timed_out)
{
    (void)timed_out;
    DWORD pid = (DWORD)(ULONG_PTR)ctx;
    HANDLE h = take(pid);
    if (!h) return; /* the completion port already reported this exit */
    FILETIME created, exitT, kernel, user;
    GetProcessTimes(h, &created, &exitT, &kernel, &user);
    DWORD code = 0;
    GetExitCodeProcess(h, &code);
    char line[256];
    snprintf(line, sizeof line,
        "{\"ev\":\"exit\",\"pid\":%lu,\"durMs\":%llu,\"cpuMs\":%llu,\"code\":%lu}",
        (unsigned long)pid,
        (unsigned long long)(filetime_to_unix_ms(exitT) - filetime_to_unix_ms(created)),
        (unsigned long long)((((ULONGLONG)kernel.dwHighDateTime << 32 | kernel.dwLowDateTime) +
                              ((ULONGLONG)user.dwHighDateTime << 32 | user.dwLowDateTime)) / 10000ULL),
        (unsigned long)code);
    emit_json_line(line);
    CloseHandle(h);
}

/* ------------------------------------------------------------------ */
/* main                                                               */
/* ------------------------------------------------------------------ */

/*
 * Usage: agentwatch.exe --target-pid <pid>
 *
 * Runs until the target process exits or stdin closes. Prints one JSON object
 * per line to stdout:
 *   {"ev":"ready","target":<pid>}
 *   {"ev":"start","pid":..,"ppid":..,"create":..,"path":"..","cmd":"..","cmdTruncated":false}
 *   {"ev":"start","pid":..,"lost":true}      (process vanished before we could open it)
 *   {"ev":"exit","pid":..,"durMs":..,"cpuMs":..,"code":..}
 *   {"ev":"exit","pid":..}                   (no start was seen)
 *   {"ev":"metric","pid":..,"cpuMs":..,"rss":..,"vsz":..,"threads":..,"handles":..,"ioR":..,"ioW":..}
 *   {"ev":"host","cpuMs":..,"idleMs":..,"cores":..,"memTotal":..,"memAvail":..}
 *   {"ev":"sample_done"}                     (one sampling pass finished)
 *   {"ev":"active_zero"}                     (job empty; informational)
 *   {"ev":"target_gone"}                     (the observed process exited)
 *   {"ev":"error","what":"..","code":..}
 */
int wmain(int argc, wchar_t **argv)
{
    DWORD target_pid = 0;
    for (int i = 1; i < argc; i++) {
        if (wcscmp(argv[i], L"--target-pid") == 0 && i + 1 < argc) {
            target_pid = (DWORD)_wtoi(argv[++i]);
        }
    }
    if (target_pid == 0) {
        fwprintf(stderr, L"usage: agentwatch.exe --target-pid <pid>\n");
        emit_json_line("{\"ev\":\"error\",\"what\":\"usage\"}");
        return 2;
    }

    InitializeCriticalSection(&g_lock);
    InitializeCriticalSection(&g_write_lock);

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) {
        char b[128];
        snprintf(b, sizeof b, "{\"ev\":\"error\",\"what\":\"CreateJobObject\",\"code\":%lu}", GetLastError());
        emit_json_line(b);
        return 1;
    }

    HANDLE port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
    if (!port) {
        char b[128];
        snprintf(b, sizeof b, "{\"ev\":\"error\",\"what\":\"CreateIoCompletionPort\",\"code\":%lu}", GetLastError());
        emit_json_line(b);
        return 1;
    }
    JOBOBJECT_ASSOCIATE_COMPLETION_PORT assoc = { job, port };
    if (!SetInformationJobObject(job, JobObjectAssociateCompletionPortInformation, &assoc, sizeof assoc)) {
        char b[128];
        snprintf(b, sizeof b, "{\"ev\":\"error\",\"what\":\"AssociateCompletionPort\",\"code\":%lu}", GetLastError());
        emit_json_line(b);
        return 1;
    }

    /* Adopt the already-running server. PROCESS_SET_QUOTA is what
     * AssignProcessToJobObject requires; SYNCHRONIZE lets us watch it exit. */
    HANDLE target = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | SYNCHRONIZE, FALSE, target_pid);
    if (!target) {
        char b[160];
        snprintf(b, sizeof b, "{\"ev\":\"error\",\"what\":\"OpenProcess\",\"code\":%lu}", GetLastError());
        emit_json_line(b);
        return 1;
    }
    if (!AssignProcessToJobObject(job, target)) {
        char b[160];
        snprintf(b, sizeof b, "{\"ev\":\"error\",\"what\":\"AssignProcessToJobObject\",\"code\":%lu}", GetLastError());
        emit_json_line(b);
        CloseHandle(target);
        return 1;
    }
    g_target_handle = target;

    {
        char b[96];
        snprintf(b, sizeof b, "{\"ev\":\"ready\",\"target\":%lu}", (unsigned long)target_pid);
        emit_json_line(b);
    }

    /* Resource sampling is driven by the server: "sample" on stdin runs one
     * pass over the handles this helper already holds. */
    g_sample_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (g_sample_event) {
        HANDLE thread = CreateThread(NULL, 0, sampler_thread, NULL, 0, NULL);
        if (thread) CloseHandle(thread);
        thread = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
        if (thread) CloseHandle(thread);
    }

    /* The event loop. A dedicated thread watches the target so an exit is
     * noticed even while we sit in GetQueuedCompletionStatus. */
    for (;;) {
        DWORD msg = 0;
        ULONG_PTR key = 0;
        LPOVERLAPPED ov = NULL;
        BOOL ok = GetQueuedCompletionStatus(port, &msg, &key, &ov, 500);
        if (ok) {
            DWORD pid = (DWORD)(ULONG_PTR)ov;
            if (msg == JOB_OBJECT_MSG_NEW_PROCESS) {
                on_new(pid);
            } else if (msg == JOB_OBJECT_MSG_EXIT_PROCESS || msg == JOB_OBJECT_MSG_ABNORMAL_EXIT_PROCESS) {
                on_exit(pid);
            } else if (msg == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO) {
                emit_json_line("{\"ev\":\"active_zero\"}");
            }
        }
        if (g_target_handle && WaitForSingleObject(g_target_handle, 0) == WAIT_OBJECT_0) {
            emit_json_line("{\"ev\":\"target_gone\"}");
            break;
        }
    }

    CloseHandle(job);
    CloseHandle(port);
    if (g_target_handle) CloseHandle(g_target_handle);
    /* Cancel every outstanding wait before the process exits, so no callback
     * fires against a torn-down table. UnregisterWaitEx(NULL) blocks until the
     * callback (if running) returns. */
    EnterCriticalSection(&g_lock);
    for (unsigned i = 0; i < BUCKETS; i++) {
        for (ProcNode *n = g_table[i]; n; n = n->next) {
            if (n->wait) { UnregisterWaitEx(n->wait, NULL); n->wait = NULL; }
        }
    }
    LeaveCriticalSection(&g_lock);
    return 0;
}
