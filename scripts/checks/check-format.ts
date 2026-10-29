/**
 * The display formatters in lib/format.ts.
 *   npx tsx scripts/checks/check-format.ts
 *
 * Bug that lived here: `formatOffset` treated its value as unbounded minutes, so
 * a run lasting two hours printed `120:33`. That is not a long run, it is a
 * broken clock — and the same function is the replay scrubber's position, the
 * report's timeline offsets, an egg's lifetime and a run's duration, so the bug
 * was on every one of those surfaces at once.
 *
 * `formatDuration` used to be a second implementation of the same clock
 * (unpadded `1:02:03` vs padded `120:33`), which meant two spans on one screen
 * could disagree about what the format was. It is now the same function, and
 * that is pinned here too.
 */
import { check, finish } from "./harness";
import { formatAgo, formatBytes, formatDuration, formatOffset } from "../../apps/web/src/lib/format";

// A. under an hour: zero-padded mm:ss, so a column of them aligns.
{
  check("0ms → 00:00", formatOffset(0) === "00:00");
  check("5s → 00:05", formatOffset(5_000) === "00:05");
  check("63s → 01:03", formatOffset(63_000) === "01:03");
  check("9m59s → 09:59", formatOffset(599_000) === "09:59");
  check("59m59s → 59:59", formatOffset(3_599_000) === "59:59");
}

// B. an hour rolls the field over instead of counting minutes forever.
{
  check("exactly one hour → 1:00:00", formatOffset(3_600_000) === "1:00:00");
  check("1h1m1s → 1:01:01", formatOffset(3_661_000) === "1:01:01");
  check("two hours → 2:00:00", formatOffset(7_200_000) === "2:00:00");
  check("two hours is not 120 minutes", formatOffset(7_230_000) === "2:00:30");
  check("a day → 24:00:00", formatOffset(86_400_000) === "24:00:00");
}

// C. a negative or unmeasurable span clamps to zero; it never prints a minus.
{
  check("negative → 00:00", formatOffset(-5_000) === "00:00");
  check("NaN → 00:00", formatOffset(Number.NaN) === "00:00");
}

// D. one clock, not two: formatDuration is formatOffset.
{
  const spans = [0, 5_000, 63_000, 3_599_000, 3_600_000, 7_230_000, 86_400_000];
  check(
    "formatDuration agrees with formatOffset on every span",
    spans.every((ms) => formatDuration(ms) === formatOffset(ms)),
  );
  check("a process that lived 2h reads as 2:00:00", formatDuration(7_200_000) === "2:00:00");
}

// E. the neighbouring formatters, pinned because they are read beside the clock.
{
  check("bytes: 0", formatBytes(0) === "0 B");
  check("bytes: 999 B", formatBytes(999) === "999 B");
  check("bytes: 2 kB", formatBytes(2_048) === "2.0 kB");
  check("bytes: 1.5 MB", formatBytes(1_572_864) === "1.5 MB");
  check("ago: never", formatAgo(undefined) === "never");
  check("ago: 12s", formatAgo(1_000, 13_000) === "12s ago");
  check("ago: 5m", formatAgo(1_000, 301_000) === "5m ago");
  check("ago: 2h", formatAgo(1_000, 1_000 + 7_200_000) === "2h ago");
}

finish("format");
