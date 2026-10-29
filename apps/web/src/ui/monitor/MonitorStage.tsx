import { useEffect, useMemo, useState, type ReactElement } from "react";
import { isAgentBusy } from "@absence/core";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useStageView } from "../../hooks/useStage";
import { useUiStore } from "../../stores/uiStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useIsObserved } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { formatClock } from "../../lib/format";
import { runEvents } from "../../lib/history";
import { ReportOverlay } from "../../components/stage/ReportOverlay";
import { MonitorChat } from "./MonitorChat";
import { StageItemView } from "../../components/stage/StageItemView";
import { MetricsDashboard } from "../../components/metrics/MetricsDashboard";
import { StageItem } from "../../types/stage";
import type { PhaseType } from "../../types/report";
import { Chip, TONE_FOR_KIND, attentionTone, phaseWord, type MonTone } from "./atoms";
import type { MonitorData } from "./useMonitorData";

type Tab = "file" | "diff" | "terminal" | "metrics";

const TAB_LABEL: Record<Tab, string> = {
  file: "File",
  diff: "Diff",
  terminal: "Terminal",
  metrics: "Metrics",
};

/**
 * Centre column: what the selected moment *is*, plus the run's world line and
 * the input row.
 *
 * The page is a pin, not a follower. Live, the Stage shows whatever the agent
 * last touched; the moment a row is clicked, the pin bar states which activity
 * everything is looking at and offers the way back — the "机器监护" rule that a
 * screen must never silently change under the reader.
 */
export function MonitorStage({ data }: { data: MonitorData }) {
  const t = useT();
  const { mode, item } = useStageView();
  const following = useStageStore((s) => s.following);
  const lastByType = useStageStore((s) => s.lastByType);
  const showType = useStageStore((s) => s.showType);
  const agentFile = useStageStore((s) => s.agentFile);
  const showAgentFile = useStageStore((s) => s.showAgentFile);
  const userFile = useStageStore((s) => s.userFile);
  const showUserFile = useStageStore((s) => s.showUserFile);
  const goLive = useStageStore((s) => s.goLive);
  const goMetrics = useStageStore((s) => s.goMetrics);
  const toggleReport = useUiStore((s) => s.toggleReport);
  const reportOpen = useUiStore((s) => s.reportOpen);
  const openMetrics = useUiStore((s) => s.openMetrics);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);

  const showingMetrics = mode === "metrics";
  const active = showingMetrics ? undefined : item;

  // Which tab is lit: the pinned item's kind, or the metrics page.
  const tab: Tab = showingMetrics
    ? "metrics"
    : active?.type === "diff"
      ? "diff"
      : active?.type === "file"
        ? "file"
        : active
          ? "terminal"
          : "metrics";

  const chooseTab = (next: Tab) => {
    // Clicking the tab that is already up is a no-op: Monitor's page is a pin,
    // so a tab is a way *to* a page, never a toggle away from it (⏎ / the pin
    // bar are the way back).
    if (next === tab) return;
    if (next === "metrics") {
      goMetrics();
      return;
    }
    if (next === "file") {
      if (userFile) showUserFile();
      else if (agentFile) showAgentFile();
      else if (lastByType.file) showType("file");
      return;
    }
    if (lastByType[next] === undefined) return;
    showType(next);
  };

  const available: Record<Tab, boolean> = {
    file: Boolean(active?.type === "file" || userFile || agentFile || lastByType.file),
    diff: Boolean(lastByType.diff),
    terminal: Boolean(lastByType.terminal),
    metrics: true,
  };

  const header = describe(active, data, t);

  return (
    <div className="mon-stage">
      <div className="mon-stagehead">
        {showingMetrics ? <Chip tone="read">{t("METRICS")}</Chip> : header.chip}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mon-stagehead__title" title={header.title}>
            {header.title}
          </div>
          <div className="mon-stagehead__sub" title={header.sub}>
            {header.sub}
          </div>
        </div>

        <div className="mon-seg" role="tablist" aria-label={t("Stage view")}>
          {(Object.keys(TAB_LABEL) as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              data-on={tab === entry ? "true" : undefined}
              disabled={!available[entry]}
              onClick={() => chooseTab(entry)}
            >
              {t(TAB_LABEL[entry])}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="mon-btn"
          onClick={toggleReport}
          aria-pressed={reportOpen}
          title={t("Open the Absence Report over the Stage")}
        >
          {t("Report")}
        </button>
      </div>

      {!following && (active || showingMetrics) ? (
        <div className="mon-pinbar">
          <span className="mon-chip mon-chip--edit" style={{ height: 18 }}>
            {showingMetrics ? t("METRICS") : header.chipText}
          </span>
          <span>
            {t("Pinned at {time} — every panel shows this moment", { time: header.time })}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="mon-btn mon-btn--ghost" onClick={goLive}>
            {t("Back to live ⏎")}
          </button>
        </div>
      ) : null}

      <div className="mon-stagebody">
        <div className="mon-sheet">
          {showingMetrics ? (
            <MetricsDashboard embedded />
          ) : active ? (
            <StageItemView item={active} />
          ) : (
            <DefaultPage data={data} onOpenEgg={() => openMetrics()} eggSelected={selectedEggPid !== undefined} />
          )}
        </div>
        {/* The Absence Report is a Monitor surface too: ⌘R or the header button
            expands it over this column, exactly as it does over Classic's Stage. */}
        <ReportOverlay withTab={false} insetBottom="bottom-0" />
      </div>

      <Timeline data={data} />
      <MonitorChat />
    </div>
  );
}

/** What to call the page: a verb, a subject, and the line under it. */
function describe(
  item: StageItem | undefined,
  data: MonitorData,
  t: (key: string, params?: Record<string, string | number>) => string,
): { chip: ReactElement; chipText: string; title: string; sub: string; time: string } {
  const time = item ? formatClock(item.createdAt) : "—";
  if (!item) {
    const phase = data.phase;
    return {
      chip: <Chip tone="mute">{t(phaseWord(phase)).toUpperCase()}</Chip>,
      chipText: t(phaseWord(phase)).toUpperCase(),
      title: data.liveHeadline ?? t("Waiting for the first activity…"),
      sub: data.run ? `#${data.run.index} · ${data.run.prompt || t("(observed activity)")}` : t("No run yet"),
      time,
    };
  }
  const payload = item.payload;
  switch (payload.kind) {
    case "diff":
      return {
        chip: <Chip tone="edit">{t("DIFF")}</Chip>,
        chipText: t("DIFF"),
        title: payload.path,
        sub: t("The agent's change — before and after"),
        time,
      };
    case "file":
      return {
        chip: <Chip tone="read">{t("FILE")}</Chip>,
        chipText: t("FILE"),
        title: payload.path,
        sub:
          payload.startLine !== undefined && payload.endLine !== undefined
            ? t("lines {a}–{b} in context", { a: payload.startLine, b: payload.endLine })
            : (payload.caption ?? t("In the agent's context")),
        time,
      };
    case "terminal":
      return {
        chip: <Chip tone={payload.exitCode === 0 ? "run" : "err"}>{payload.mcp ? "MCP" : t("RUN")}</Chip>,
        chipText: payload.mcp ? "MCP" : t("RUN"),
        title: payload.command || "(shell)",
        sub: payload.mcp
          ? `${payload.mcp.server} › ${payload.mcp.tool}`
          : t("exit {code}", { code: payload.exitCode }),
        time,
      };
    case "thought":
      return {
        chip: <Chip tone="think">{t("THINK")}</Chip>,
        chipText: t("THINK"),
        title: t("Reasoning"),
        sub: payload.streaming ? t("still streaming…") : t("{n} chars", { n: payload.text.length }),
        time,
      };
    case "process":
      return {
        chip: <Chip tone="egg">{t("EGG")}</Chip>,
        chipText: t("EGG"),
        title: payload.name,
        sub: `pid ${payload.pid} · ${payload.status === "running" ? t("running") : t("exited")}`,
        time,
      };
    case "approval":
      return {
        chip: <Chip tone="run">{t("APPROVE?")}</Chip>,
        chipText: t("APPROVE?"),
        title: payload.title,
        sub: t("the agent is waiting"),
        time,
      };
    default:
      return {
        chip: <Chip tone="mute">{t("ACTIVITY")}</Chip>,
        chipText: t("ACTIVITY"),
        title: item.title,
        sub: "",
        time,
      };
  }
}

/**
 * The default page. Live, this says in one line what the agent is doing right
 * now and what it has produced so far — no avatar, no desk: the "监护" reading
 * of the same facts the right rail summarises.
 */
function DefaultPage({
  data,
  onOpenEgg,
  eggSelected,
}: {
  data: MonitorData;
  onOpenEgg: () => void;
  eggSelected: boolean;
}) {
  const t = useT();
  const observed = useIsObserved();
  const busy = data.busy;
  const facts = data.facts;
  if (!data.run) {
    return (
      <div className="mon-scroll mon-empty" style={{ padding: 24 }}>
        {observed
          ? t("Absence is watching this process; it never drives or stops it.")
          : t("Send the agent a task with the input row below.")}
      </div>
    );
  }
  const changed = (facts?.files.created.length ?? 0) + (facts?.files.modified.length ?? 0);
  const matters: Array<[string, string, string]> = [
    [t("Phase"), t(phaseWord(data.phase)), "mute"],
    [t("Files read"), String(facts?.counts.reads ?? 0), "read"],
    [t("Files changed"), String(changed), "edit"],
    [t("Commands"), String(facts?.commands.total ?? 0), "run"],
    [t("Errors"), String(facts?.errors.unresolved ?? 0), "err"],
    [t("Eggs left"), String(facts?.processes.runningAtEnd ?? 0), "egg"],
  ];
  return (
    <div className="mon-scroll">
      <div style={{ marginBottom: 14 }}>
        <div className="mon-cap">{busy ? t("Doing now") : t("Last activity")}</div>
        <div style={{ marginTop: 4, fontSize: 17, lineHeight: 1.35, color: "var(--mon-t)" }}>
          {data.liveHeadline ?? t("The run finished — open the Report for what it amounted to.")}
        </div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--mon-t2)" }}>
          {`#${data.run.index} · ${data.run.prompt || t("(observed activity)")}`}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          marginBottom: 16,
        }}
      >
        {matters.map(([label, value, tone]) => (
          <div
            key={label}
            style={{ padding: "9px 11px", border: "1px solid var(--mon-bd)", borderRadius: 8, background: "var(--mon-s1)" }}
          >
            <div className="mon-cap">{label}</div>
            <div className={`mon-mono mon-chip--${tone as MonTone}`} style={{ marginTop: 2, fontSize: 19, fontWeight: 600 }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {data.attention.level !== "none" && data.attention.reasons.length > 0 ? (
        <div style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {data.attention.reasons.slice(0, 4).map((reason) => (
            <Chip key={reason} tone={attentionTone(data.attention.level)}>
              {t(reason.replace(/_/g, " "))}
            </Chip>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="mon-btn" onClick={onOpenEgg} disabled={eggSelected}>
          {t("Open metrics")}
        </button>
      </div>
    </div>
  );
}

/**
 * The world line: one lane per kind, a block per activity, a cursor at the
 * pinned moment (or at the end, live). Clicking a block seeks the replay — the
 * same gesture as Classic's timeline, kept because it is the fastest way to
 * answer "when did that happen".
 */
function Timeline({ data }: { data: MonitorData }) {
  const t = useT();
  const nodes = data.facts?.timeline ?? [];
  const selectRun = useUiStore((s) => s.selectRun);
  const load = useReplayStore((s) => s.load);
  const setMode = useStageStore((s) => s.setMode);

  /** Pin the run, load its events, and open replay at the clicked moment. */
  const seek = (offsetMs: number) => {
    if (!data.run) return;
    const node = [...nodes].reverse().find((entry) => entry.offsetMs <= offsetMs);
    if (!node) return;
    selectRun(data.run.id);
    load(runEvents(data.events, data.run), { label: `#${data.run.index} · ${data.run.prompt}` });
    useReplayStore.getState().seekTimestamp(node.at);
    setMode("replay");
  };

  const laneOrder: Array<[string, string]> = useMemo(
    () => [
      ["think", t("Think")],
      ["files", t("Files")],
      ["shell", t("Shell")],
      ["eggs", t("Eggs")],
    ],
    [t],
  );

  const lanes = useMemo(() => {
    const byLane = new Map<string, Array<{ left: number; width: number; tone: MonTone; label: string }>>();
    const total = Math.max(1, (nodes.at(-1)?.offsetMs ?? 0) + 1);
    for (const node of nodes) {
      const lane = laneFor(node.kind);
      const left = (node.offsetMs / total) * 100;
      const end = node.offsetMs + 400;
      const widthPct = Math.max(0.8, Math.min(6, ((end - node.offsetMs) / total) * 100));
      const list = byLane.get(lane) ?? [];
      list.push({ left, width: widthPct, tone: TONE_FOR_KIND[node.kind] ?? "mute", label: `${node.action} · ${node.subject}` });
      byLane.set(lane, list);
    }
    return byLane;
  }, [nodes]);

  const total = Math.max(1, nodes.at(-1)?.offsetMs ?? 0);
  // Live: the cursor sits at the end of the line. Replay: wherever the scrubber
  // is. Anything else (a pinned page) has no clock of its own, so the end is
  // the honest position.
  const replayTime = useReplayStore((s) => s.currentTime);
  const inReplay = useStageStore((s) => s.mode === "replay");
  const cursor =
    inReplay && data.run ? Math.min(1, Math.max(0, (replayTime - data.run.startedAt) / total)) : 1;

  if (nodes.length === 0) {
    return (
      <div className="mon-tl">
        <span className="mon-cap">{t("Timeline")}</span>
        <span style={{ fontSize: 11.5, color: "var(--mon-t3)" }}>{t("Nothing on the world line yet.")}</span>
      </div>
    );
  }

  return (
    <div className="mon-tl">
      <button type="button" className="mon-btn mon-btn--ghost" style={{ height: 30, padding: "0 8px" }} disabled>
        ▶
      </button>
      <div className="mon-tl__labels">
        {laneOrder.map(([id, label]) => (
          <span key={id}>{label}</span>
        ))}
      </div>
      <div
        className="mon-tl__lanes"
        role="group"
        aria-label={t("Run timeline")}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
          seek(ratio * total);
        }}
      >
        {laneOrder.map(([id]) => (
          <div key={id} className="mon-tl__lane">
            {(lanes.get(id) ?? []).map((block, index) => (
              <span
                key={index}
                className={`mon-tl__blk mon-chip--${block.tone}`}
                style={{ left: `${block.left}%`, width: `${block.width}%` }}
                title={block.label}
              />
            ))}
          </div>
        ))}
        <span className="mon-tl__head" style={{ left: `${cursor * 100}%` }} aria-hidden />
      </div>
      <span className="mon-mono" style={{ fontSize: 11, color: "var(--mon-t3)", width: 44, textAlign: "right" }}>
        {formatClock(data.run?.startedAt ?? Date.now()).slice(0, 5)}
      </span>
    </div>
  );
}

function laneFor(kind: string): string {
  switch (kind) {
    case "think":
      return "think";
    case "read":
    case "search":
    case "edit":
    case "write":
    case "observe":
      return "files";
    case "run":
      return "shell";
    case "process":
      return "eggs";
    default:
      return "shell";
  }
}
