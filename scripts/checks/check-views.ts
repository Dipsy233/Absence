/**
 * The faces' view-model logic, without a DOM.
 *   npx tsx scripts/checks/check-views.ts
 *
 * The four faces share a set of pure derivations (lib/history, lib/metrics,
 * lib/attention, lib/viewMode, the shared atoms). Each one here was either a
 * bug or a disagreement between two faces drawing the same run; the check pins
 * the rule so a refactor cannot silently fork it again. React components are
 * not rendered — everything below is the logic *behind* them.
 */
import { check, finish, section } from "./harness";
import {
  feedAnchors,
  groupFeedRows,
  playingState,
  replayRowAt,
  stripFeedAnchors,
} from "../../apps/web/src/lib/history";
import { usageSummary } from "../../apps/web/src/lib/metrics";
import { ATTENTION_REASON_TEXT } from "../../apps/web/src/lib/attention";
import { translate } from "../../apps/web/src/lib/i18n";
import { useSettingsStore } from "../../apps/web/src/stores/settingsStore";
import { isViewMode, readStoredViewMode, viewModeSpec } from "../../apps/web/src/lib/viewMode";
import { RUN_TONE, RUN_WORD, TONE_FOR_ROW, TONE_FOR_KIND } from "../../apps/web/src/ui/shared/atoms";
import type { ActivityRow } from "../../apps/web/src/types/stage";
import type { MetricsFrame } from "@absence/core";
import type { PhaseType } from "../../apps/web/src/types/report";

/* ── fixtures ──────────────────────────────────────────────────────────── */

let seq = 0;
function row(over: Partial<ActivityRow> & Pick<ActivityRow, "action" | "primary" | "tone">): ActivityRow {
  seq += 1;
  return {
    id: `r${seq}`,
    event: { id: `e${seq}`, timestamp: 1_000 + seq * 100 } as ActivityRow["event"],
    time: "00:00",
    ...over,
  };
}

function frame(ts: number, eggs: MetricsFrame["eggs"], agent?: MetricsFrame["agent"]): MetricsFrame {
  return {
    ts,
    intervalMs: 2000,
    processes: [],
    eggs,
    agent,
    host: {
      cpuCount: 8,
      cpuSeconds: 0,
      cpuIdleSeconds: 0,
      memTotalBytes: 16 * 1024 ** 3,
      memAvailableBytes: 8 * 1024 ** 3,
    },
    precision: "sampled",
  };
}

/* ── replay cursor ─────────────────────────────────────────────────────── */

section("replayRowAt — the row the cursor is on (last at-or-before)");
{
  const rows = [
    row({ action: "THINK", primary: "a", tone: "think" }), // ts 1100
    row({ action: "READ", primary: "b", tone: "read" }), //   ts 1200
    row({ action: "EDIT", primary: "c", tone: "edit" }), //   ts 1300
  ];
  check("before the first row there is nothing on the clock", replayRowAt(rows, 900) === undefined);
  check("the cursor sits on the last row at or before it", replayRowAt(rows, 1200)?.id === rows[1]!.id);
  check("a time between rows lands on the earlier one", replayRowAt(rows, 1250)?.id === rows[1]!.id);
  check("past the end it holds the last row, it does not clamp forward", replayRowAt(rows, 9999)?.id === rows[2]!.id);
  check("an empty run has no cursor row", replayRowAt([], 1000) === undefined);
  // Monitor's feed and Rounds' story must answer with the same row: this is
  // the rule both faces used to implement (one binary, one linear).
  check("a row whose timestamp equals the cursor is included", replayRowAt(rows, 1300)?.id === rows[2]!.id);
}

/* ── live / replay state ───────────────────────────────────────────────── */

section("playingState — LIVE vs REPLAY, one rule for every face");
{
  check("following live is live", playingState(true, undefined, false) === "live");
  check("a walking replay is replay", playingState(true, undefined, true) === "replay");
  const pinned = row({ action: "READ", primary: "p", tone: "read" });
  check("a pinned moment is replay even outside replay mode", playingState(false, pinned, false) === "replay");
  check("following live with no pinned item is live", playingState(true, undefined, false) === "live");
  // Monitor's rail and Rounds' story print the same words: pinned and walking
  // replay are one answer to the reader ("the clock has stopped here").
  check(
    "pinned and walking replay agree",
    playingState(false, pinned, false) === playingState(true, undefined, true),
  );
}

/* ── feed reading view ─────────────────────────────────────────────────── */

section("groupFeedRows — phase dividers come from the rows themselves");
{
  const feed = [
    row({ action: "THINK", primary: "t", tone: "think" }), // no phase: inherits, no divider
    row({ action: "READ", primary: "r1", tone: "read" }), // opens investigating
    row({ action: "READ", primary: "r2", tone: "read" }),
    row({ action: "RUN", primary: "$ x", tone: "run" }), // opens executing
    row({ action: "SAY", primary: "s", tone: "say" }), // inherits executing
    row({ action: "EDIT", primary: "e", tone: "edit" }), // opens implementing
  ];
  const groups = groupFeedRows(feed);
  const phases = groups.filter((g) => g.phase !== undefined).map((g) => g.phase);
  check("three phase groups, in the rows' order", JSON.stringify(phases) === JSON.stringify(["investigating", "executing", "implementing"]));
  check("leading unphased rows form their own group first", groups[0]!.phase === undefined);
  check("an unphased row files under the phase before it", groups.find((g) => g.phase === "executing")!.rows.some((r) => r.row.action === "SAY"));

  // A shell row must never be filed under "reading files": the divider is
  // derived per row (phaseForRow), not from the report's command-anchored phases.
  const misfiled = groups.find((g) => g.phase === "investigating")!.rows.find((r) => r.row.tone === "run");
  check("a shell row never lands under investigating", misfiled === undefined);
}

section("groupFeedRows — state re-reports fold into the row they re-report");
{
  const stageItem = { id: "stage-1" } as ActivityRow["stageItem"];
  const first = row({ action: "RUN", primary: "npm test", tone: "run", stageItem });
  const update = row({ action: "RUN", primary: "npm test", tone: "process", stageItem });
  const groups = groupFeedRows([first, update, update]);
  const fed = groups.flatMap((g) => g.rows);
  check("three reports of one thing fold to one entry", fed.length === 1);
  check("the folded entry keeps the newest row (the latest state)", fed[0]!.row.id === update.id);
  check("the folded entry counts all three reports", fed[0]!.count === 3);

  // The Stage item id is part of the key: two different `npm test` runs are
  // never merged, and RUN vs EXIT stay separate.
  const otherRun = row({ action: "RUN", primary: "npm test", tone: "run", stageItem: { id: "stage-2" } as ActivityRow["stageItem"] });
  const exit = row({ action: "EXIT", primary: "npm test", tone: "run", stageItem });
  const two = groupFeedRows([first, otherRun]);
  check("the same command from another run does not fold in", two.flatMap((g) => g.rows).length === 2);
  const withExit = groupFeedRows([first, exit]);
  check("RUN vs EXIT stay separate — finishing is a fact", withExit.flatMap((g) => g.rows).length === 2);
}

section("feedAnchors / stripFeedAnchors — the run's two ends, pinned not repeated");
{
  const feed = [
    row({ action: "START", primary: "do the thing", tone: "lifecycle" }),
    row({ action: "READ", primary: "f.ts", tone: "read" }),
    row({ action: "END", primary: "done", tone: "lifecycle" }),
  ];
  const anchors = feedAnchors(feed);
  check("the first START is the top anchor", anchors.start?.action === "START");
  check("the last END is the bottom anchor", anchors.end?.action === "END");
  const body = stripFeedAnchors(groupFeedRows(feed));
  const actions = body.flatMap((g) => g.rows).map((r) => r.row.action);
  check("the body drops both anchors", !actions.includes("START") && !actions.includes("END"));
  check("the body keeps the real activity", JSON.stringify(actions) === JSON.stringify(["READ"]));
}

/* ── cost panel derivation ─────────────────────────────────────────────── */

section("usageSummary — the cost panel's numbers (agent scope and egg scope)");
{
  const mkEgg = (pid: number, kind: "primary" | "tool", cpu: number, rss: number): MetricsFrame["eggs"][number] => ({
    eggPid: pid,
    name: `egg-${pid}`,
    kind,
    status: "running",
    cpuSeconds: cpu,
    rssBytes: rss,
    processCount: 1,
    avgCores: 0,
  });
  // Two frames 2s apart: the primary egg burns 1 CPU-second between them
  // (0.5 cores); the tool egg burns 0.5. Folding helpers into the primary is
  // lib/eggs' job — the metrics tree sums primaries and leaves tools out.
  const frames = [
    frame(0, [mkEgg(10, "primary", 10, 200 * 1024 ** 2), mkEgg(11, "tool", 5, 50 * 1024 ** 2)]),
    frame(2000, [mkEgg(10, "primary", 11, 300 * 1024 ** 2), mkEgg(11, "tool", 5.5, 60 * 1024 ** 2)]),
  ];

  const agent = usageSummary(frames);
  check("unscoped means the whole agent tree", agent.scope === undefined);
  check("agent CPU is the primaries' rate; tool eggs are left out", Math.abs(agent.cores - 0.5) < 1e-9);
  check("agent memory reads the newest frame", Math.abs(agent.memMiB - 300) < 1e-6);
  check("the spark covers every frame", agent.cpuSpark.length === 2 && agent.memSpark.length === 2);

  const egg = usageSummary(frames, 10);
  check("scoped reports the egg's name", egg.scope === "egg-10");
  check("the egg's CPU is its own rate, not the tree's", Math.abs(egg.cores - 0.5) < 1e-9);
  check("the egg's peak tracks its own memory", egg.peakMiB === 300);

  check("an unknown pid names the pid", usageSummary(frames, 99).scope === "pid 99");
  const empty = usageSummary([]);
  check("no frames yet: zeros, not NaN", empty.cores === 0 && empty.memMiB === 0 && empty.peakMiB === 0);
}

/* ── words and colours the faces share ─────────────────────────────────── */

section("shared vocabularies — every face prints the same words");
{
  const statuses = ["running", "completed", "interrupted", "error"] as const;
  check(
    "RUN_TONE covers every run status",
    statuses.every((s) => RUN_TONE[s] !== undefined),
  );
  check(
    "RUN_WORD covers every run status",
    statuses.every((s) => RUN_WORD[s] !== undefined),
  );

  // translate() reads the language off the settings store; this process has
  // no persisted state, so pin it to Chinese for the completeness checks.
  useSettingsStore.setState({ language: "zh" });
  const t = translate;
  check(
    "every run status word is translated",
    statuses.every((s) => t(RUN_WORD[s]) !== RUN_WORD[s]),
  );
  check(
    "every attention reason sentence is translated",
    Object.values(ATTENTION_REASON_TEXT).every((sentence) => t(sentence) !== sentence),
  );
  // A row tone with no entry would render as `undefined` in every feed.
  const tones = ["think", "say", "read", "search", "edit", "run", "lifecycle", "process", "approval", "error", "warn"] as const;
  check(
    "TONE_FOR_ROW covers every activity tone",
    tones.every((tone) => TONE_FOR_ROW[tone] !== undefined),
  );
  const kinds = ["start", "think", "read", "search", "edit", "write", "run", "process", "observe", "error", "end"];
  check(
    "TONE_FOR_KIND covers every report kind",
    kinds.every((kind) => TONE_FOR_KIND[kind] !== undefined),
  );
}

/* ── view mode ─────────────────────────────────────────────────────────── */

section("viewMode — unknown and stale values land somewhere sane");
{
  check("the three faces are switchable", ["rounds", "monitor", "chart"].every((m) => isViewMode(m)));
  check("drip is a switch, not a stored face", isViewMode("drip"));
  check("classic was deleted: its stored value is no longer a mode", !isViewMode("classic"));
  // readStoredViewMode without localStorage (this process has none) must fall
  // back through the catch, not throw.
  check("no storage at all falls back to Monitor", readStoredViewMode() === "monitor");
  check("unknown ids fall back to Monitor", viewModeSpec("classic" as never).id === "monitor");
  check("every face has a name and an intent", viewModeSpec("rounds").zh === "查房陪诊");
}

finish("view checks");
