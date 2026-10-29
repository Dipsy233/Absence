/**
 * The two colours a metric has, in one place.
 *
 * CPU and memory are drawn in three places — the rail's sparklines, the
 * dashboard's chart lines, and the dashboard's stat figures and table cells —
 * and each of them used to pick its own colour: the line was amber while its
 * number was blue, the memory line was teal while its number was green. The
 * point of a colour on a metric is that the eye can follow it from the number
 * to the line, so there is exactly one answer per metric and it lives here.
 *
 * They are the Monitor palette's own tones (`--mon-run`, `--mon-read`), so the
 * rail and the dashboard agree without either of them owning the value.
 */
export const CPU_COLOR = "#de9255";
export const MEM_COLOR = "#5e9fe8";

/** The muted colour of the host's dashed line, which belongs to neither metric. */
export const HOST_COLOR = "rgba(190, 190, 190, 0.75)";
