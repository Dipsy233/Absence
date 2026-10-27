/**
 * The metrics ranges must actually differ.
 *
 * "30m", "1h" and "all" all anchored their window to the session's start, so on
 * a session younger than the range the three collapsed onto the same short
 * window and the chart looked identical whichever one was picked.
 *
 * This imports the dashboard's own `RANGES` / `rangeStart` rather than mirroring
 * them, so it fails when the UI drifts instead of when a copy of it does.
 *
 *   npx tsx scripts/checks/check-metrics-ranges.ts
 */
import { check, finish } from "./harness";
import { RANGES, rangeStart } from "../../apps/web/src/lib/metrics";

const STEP = 5_000;
const now = 1_700_000_000_000;
const nowSlot = Math.floor(now / STEP) * STEP;

const width = (id: (typeof RANGES)[number]["id"], sessionStart: number) =>
  Math.max(0, nowSlot - rangeStart(id, now, sessionStart));

// A session that opened 20 seconds ago — younger than 30m and 1h.
const young = now - 20_000;

check("1m asks for about a minute", Math.abs(width("1m", young) - 60_000) <= STEP);
check("5m asks for about five minutes", Math.abs(width("5m", young) - 300_000) <= STEP);
check(
  "30m does not collapse onto the short window of a young session",
  Math.abs(width("30m", young) - 1_800_000) <= STEP,
  `width=${width("30m", young)}ms`,
);
check(
  "1h does not collapse onto the short window of a young session",
  Math.abs(width("1h", young) - 3_600_000) <= STEP,
  `width=${width("1h", young)}ms`,
);
check(
  '"all" starts at the session, so a young session shows only its own age',
  width("all", young) > 0 && width("all", young) <= 30_000,
  `width=${width("all", young)}ms`,
);

// The regression: the five windows must be five different widths, not one.
const widths = RANGES.map((range) => width(range.id, young));
check(
  "every range is its own window",
  new Set(widths).size === widths.length,
  RANGES.map((range, index) => `${range.id}=${widths[index]}`).join(" "),
);

// A session older than an hour is bounded by its own start, not by a fixed hour.
const old = now - 6 * 60 * 60_000;
check(
  '"all" on an old session spans the session, not a fixed hour',
  width("all", old) >= 6 * 60 * 60_000 - STEP,
  `${width("all", old)}ms`,
);

// A fixed range does not depend on the session's age at all.
check(
  "a fixed range ignores the session's start",
  width("30m", young) === width("30m", old),
);

// Two renders within the same step ask for the same window, so the effect does
// not refetch on every tick.
check(
  "the window is stable inside a step",
  rangeStart("5m", now, undefined) === rangeStart("5m", now + STEP - 1, undefined),
);
check(
  "the window moves when the step turns over",
  rangeStart("5m", now, undefined) !== rangeStart("5m", now + STEP, undefined),
);

finish();
