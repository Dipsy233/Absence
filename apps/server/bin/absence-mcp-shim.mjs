#!/usr/bin/env node
/**
 * absence-mcp-shim — a transparent MCP proxy that records what goes through it.
 *
 * Why this exists
 * ---------------
 * Absence observes the OS: processes, files, terminal bytes. That covers an
 * agent's `bash` tool (which spawns a process) but *not* its MCP tool calls —
 * those are JSON-RPC messages written into a pipe that already exists, so no
 * process is created and nothing appears in the process table. Measured, not
 * assumed: a real Pi driving Windows Calculator through an MCP server produced
 * zero process events while the calculation happened.
 *
 * MCP is the one door every agent opens the same way. The spec says a stdio
 * server is `{ command, args }`, so pointing `command` at this program inserts
 * a proxy without touching the agent: it spawns the real server, forwards bytes
 * in both directions unchanged, and copies each JSON-RPC message to a log.
 *
 * Deliberately dumb:
 *   · it forwards bytes, not parsed messages — a protocol version Absence has
 *     not heard of still works
 *   · it never modifies, reorders or drops a message
 *   · if the log cannot be written, it forwards anyway (observing must never
 *     break the thing it observes)
 *   · exit codes and signals are propagated unchanged
 *
 * Usage (from an agent's MCP config):
 *
 *   { "command": "absence-mcp-shim", "args": ["--", "somnus-mcp"] }
 *
 * Environment:
 *   ABSENCE_SHIM_LOG   path to append JSON lines to (default: none)
 *   ABSENCE_SHIM_SESSION  session id recorded with each line, for correlation
 */

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Split argv at `--`: everything after it is the real server's command. */
function splitArgs(argv) {
  const at = argv.indexOf("--");
  if (at < 0) return { real: argv, options: {} };
  return { real: argv.slice(at + 1), options: {} };
}

const { real } = splitArgs(process.argv.slice(2));
if (real.length === 0) {
  process.stderr.write("absence-mcp-shim: no command given — usage: absence-mcp-shim -- <server> [args...]\n");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// The log. One JSON line per message; append-only, opened lazily so a shim with
// no ABSENCE_SHIM_LOG costs nothing.
// ---------------------------------------------------------------------------
let log = undefined;
function openLog() {
  if (log !== undefined) return log;
  const path = process.env.ABSENCE_SHIM_LOG;
  if (!path) {
    log = null;
    return log;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    log = createWriteStream(path, { flags: "a" });
    log.on("error", () => {
      // A broken log must not take the server down.
      log = null;
    });
  } catch {
    log = null;
  }
  return log;
}

function record(direction, text) {
  const stream = openLog();
  if (!stream) return;
  const line = JSON.stringify({
    ts: Date.now(),
    dir: direction,
    session: process.env.ABSENCE_SHIM_SESSION ?? undefined,
    pid: process.pid,
    // Raw text: the reader parses it if it can. Storing bytes as a string keeps
    // the log human-readable for the common case (UTF-8 JSON) and lossless
    // enough to re-parse.
    text,
  });
  try {
    stream.write(line + "\n");
  } catch {
    // as above: observing must not break the observed
  }
}

/**
 * Frame the byte stream into JSON-RPC messages, without interpreting them.
 *
 * MCP over stdio is newline-delimited JSON (one message per line, no embedded
 * raw newlines). So "one line" is the framing, and a partial line is buffered
 * until its newline arrives. The same parser is used for both directions.
 */
function makeFramer(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
    // Guard against a server that never sends a newline: forward the buffer
    // rather than growing forever. Nothing is lost from the pipe itself; only
    // the log's framing degrades.
    if (buffer.length > 8 * 1024 * 1024) {
      onLine(buffer);
      buffer = "";
    }
  };
}

// ---------------------------------------------------------------------------
// The proxy: spawn the real server, wire the three streams, forward everything.
// ---------------------------------------------------------------------------
const child = spawn(real[0], real.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  env: process.env,
  // The server must not outlive the shim, and must not be in a different
  // process group on POSIX (a SIGTERM to us should reach it).
  windowsHide: true,
});

const toServer = makeFramer((line) => record("client-to-server", line));
const toClient = makeFramer((line) => record("server-to-client", line));

// client → server
process.stdin.on("data", (chunk) => {
  toServer(chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
process.stdin.on("error", () => child.stdin.destroy());

// server → client
child.stdout.on("data", (chunk) => {
  toClient(chunk);
  process.stdout.write(chunk);
});

// stderr is diagnostics, not protocol: pass it through, do not log it as
// messages (an agent may print anything there).
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

child.on("error", (error) => {
  process.stderr.write(`absence-mcp-shim: could not start ${real[0]}: ${error.message}\n`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  // Flush the log before leaving, or the last messages of a session are lost.
  if (log) log.end(() => process.exit(code ?? (signal ? 1 : 0)));
  else process.exit(code ?? (signal ? 1 : 0));
});

// A signal sent to the shim belongs to the server it fronts.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  });
}
