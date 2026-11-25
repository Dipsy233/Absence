import { snapshotProcesses, type ProcessTable } from "../process/ProcessTable";

/**
 * The process-table sweep the observation code reads.
 *
 * A single seam over `snapshotProcesses` so the target list, the OS-only watch
 * and the channel upgrade all read the same table, and so a check can inject a
 * fake machine (a table of one or two invented pids) without a real agent
 * running. Production never calls `setProcessSnapshot`.
 */
type Snapshot = () => Promise<ProcessTable>;

let source: Snapshot = snapshotProcesses;

export function processSnapshot(): Promise<ProcessTable> {
  return source();
}

/** Checks only: replace the machine's table with a scripted one. */
export function setProcessSnapshot(next: Snapshot | undefined): void {
  source = next ?? snapshotProcesses;
}
