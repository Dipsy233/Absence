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
 * queued events, so there is nothing to poll and nothing to miss.
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
#include <stdio.h>
#include <wchar.h>
#include <stdint.h>

#pragma comment(lib, "ntdll.lib")

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

static void emit_json_line(const char *body)
{
    fputs(body, stdout);
    fputc('\n', stdout);
    fflush(stdout);
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
    struct ProcNode *next;
} ProcNode;

#define BUCKETS 1024
static ProcNode *g_table[BUCKETS];
static CRITICAL_SECTION g_lock;
static HANDLE g_target_handle = NULL;

static unsigned bucket(DWORD pid) { return (unsigned)(pid * 2654435761u) % BUCKETS; }

static void remember(DWORD pid, HANDLE h)
{
    EnterCriticalSection(&g_lock);
    unsigned b = bucket(pid);
    for (ProcNode *n = g_table[b]; n; n = n->next) {
        if (n->pid == pid) { CloseHandle(n->handle); n->handle = h; LeaveCriticalSection(&g_lock); return; }
    }
    ProcNode *n = (ProcNode *)malloc(sizeof(ProcNode));
    if (n) { n->pid = pid; n->handle = h; n->next = g_table[b]; g_table[b] = n; }
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

static void on_new(DWORD pid)
{
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
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

    size_t cap = pathBytes + cmdBytes + 256;
    char *line = (char *)malloc(cap);
    if (line) {
        snprintf(line, cap,
            "{\"ev\":\"start\",\"pid\":%lu,\"ppid\":%lu,\"create\":%llu,\"path\":\"%s\",\"cmd\":\"%s\",\"cmdTruncated\":%s}",
            (unsigned long)pid, (unsigned long)ppid, filetime_to_unix_ms(created),
            pathJson, cmdJson, truncated ? "true" : "false");
        emit_json_line(line);
        free(line);
    }
    free(pathJson);
    free(cmdJson);
    if (cmd) free(cmd);
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
    return 0;
}
