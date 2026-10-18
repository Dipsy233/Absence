import { createReadStream, existsSync, statSync } from "node:fs";
import { McpLogReader, type McpCall, type ShimRecord } from "../mcp/McpLogReader";

/**
 * Tails an MCP proxy's log and reports completed tool calls.
 *
 * An MCP call creates no process and writes no file in the project, so nothing
 * in Layer 0 or Layer 1 can see it — measured on a real agent driving a Windows
 * Calculator: the whole calculation produced zero process events. The shim sits
 * on the protocol's one standard door (`command` in the server config), and this
 * is the other end of it.
 *
 * Watched by size, not by file events: the shim holds the file open and appends,
 * so a change notification arrives while the last line may still be partial.
 * Reading from the last known offset and keeping the remainder is both simpler
 * and correct for that, whereas a rename/rotate would be missed either way and
 * is not something a shim does.
 */
const POLL_MS = 400;

export class McpLogTail {
  private offset = 0;
  private remainder = "";
  private timer?: ReturnType<typeof setTimeout>;
  private readonly reader = new McpLogReader();
  private disposed = false;

  constructor(
    private readonly path: string,
    private readonly onCall: (call: McpCall) => void,
  ) {}

  start(): void {
    // Start at the end when the log already exists: everything before the
    // session began belongs to an earlier one, and replaying it would invent
    // calls this session never made.
    try {
      if (existsSync(this.path)) this.offset = statSync(this.path).size;
    } catch {
      this.offset = 0;
    }
    this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.disposed) return;
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      // The shim has not written anything yet.
      this.schedule();
      return;
    }
    if (size < this.offset) {
      // Truncated or replaced: the log is no longer the one we were reading.
      this.offset = 0;
      this.remainder = "";
    }
    if (size > this.offset) this.readTo(size);
    this.schedule();
  }

  private readTo(size: number): void {
    const stream = createReadStream(this.path, { start: this.offset, end: size - 1, encoding: "utf8" });
    let text = "";
    stream.on("data", (chunk) => {
      text += chunk;
    });
    stream.on("error", () => {
      // A failed read is a missed tick, not a reason to stop observing.
    });
    stream.on("end", () => {
      this.offset = size;
      const combined = this.remainder + text;
      const lines = combined.split(String.fromCharCode(10));
      // The last element is either empty (the chunk ended on a newline) or a
      // partial line; keep it for next time.
      this.remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let record: ShimRecord;
        try {
          record = JSON.parse(line) as ShimRecord;
        } catch {
          continue;
        }
        const call = this.reader.push(record);
        if (call) this.onCall(call);
      }
    });
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, POLL_MS);
  }
}
