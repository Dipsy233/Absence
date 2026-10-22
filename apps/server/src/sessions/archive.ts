/**
 * ABSENCE's own session archive (read.md §26).
 *
 * The implementation now lives in `storage/db.ts` (SQLite); this module is the
 * stable seam the rest of the server imports. Keeping the five functions and
 * the `ArchiveMeta` shape unchanged means `SessionStore`, the WebSocket
 * protocol, the Stage and every UI store did not have to learn about a
 * database. The legacy JSONL paths are still exported because the one-time
 * importer reads them and because they are useful for export/backup.
 *
 *   ~/.absence/absence.db                                 the live store
 *   ~/.absence/sessions/<encoded-cwd>/<id>.meta.json      legacy, imported once
 *   ~/.absence/sessions/<encoded-cwd>/<id>.events.jsonl   legacy, imported once
 *
 * Override the root with ABSENCE_STATE_DIR.
 */
export type { ArchiveMeta } from "./storage/db";
export {
  appendEvents,
  closeArchive,
  drainArchive,
  listArchives,
  readEvents,
  readEventsPage,
  readRunEvents,
  readRuns,
  readMeta,
  writeMeta,
} from "./storage/db";
export { archiveDir, encodeCwd, eventsFile, metaFile } from "./storage/legacyPaths";
