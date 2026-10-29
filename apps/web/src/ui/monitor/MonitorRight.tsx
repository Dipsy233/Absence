import { useMemo, useState } from "react";
import { formatBytes, formatClock, formatDuration } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useSessionStore } from "../../stores/sessionStore";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { openKnownFile } from "../../lib/openFile";
import { eventToStageItem } from "../../lib/events";
import { countEggs, filterEggs, primaryEggs, sortEggs, summarizeTools, type Egg, type EggFilter } from "../../lib/eggs";
import {
  agentCpuCores,
  agentAverageCores,
  agentPoints,
  eggAverageCores,
  eggCpuCores,
  eggPoints,
  findEgg,
  formatCores,
  formatPercent,
  hostCpuPercent,
  latestFrame,
} from "../../lib/metrics";
import { moodFor, statusLabel, type AgentVisualState } from "../../lib/agent";
import { useT } from "../../lib/i18n";
import { Avatar } from "../../components/agent/Avatar";
import { MediaAvatar } from "../../components/agent/MediaAvatar";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import { CPU_COLOR, MEM_COLOR } from "../../lib/metricColors";
import { Dot, phaseWord, Spark, toneForStatus } from "./atoms";
import type { MonitorData } from "./useMonitorData";

/**
 * Right column: who is working, what it is worth in resources, what it knows,
 * and what it left running — the four things a person supervising a machine
 * wants within one glance, in that order of urgency.
 *
 * Every block is a *section of this column*, separated by a hairline, not a
 * boxed panel with its own border, header bar and padding. Classic's rails are
 * stacks of cards because they sit in a dashboard of cards; Monitor's rail is
 * one column of one face, so a rule between sections is enough — and it buys
 * back the vertical space the boxes' chrome was eating.
 *
 * The two long sections reuse Classic's *logic* rather than its markup:
 * Agent Folder keeps the version expansion and the v-chip reading, Agent Eggs
 * keeps the running/dead/all filter, the query and the per-egg actions — all
 * re-drawn against `.mon-*` so they read as this face.
 */
export function MonitorRight({ data }: { data: MonitorData }) {
  return (
    <div className="mon-col mon-col--right">
      <AgentHead data={data} />
      <Usage />
      {/*
        No attention block here. The verdict is already stated in two places
        that act on it: the header's chip (which is about the whole window) and
        the agent's own state line ("high · a process is still running"). A
        third copy in the rail was a red box repeating the header, and it pushed
        the two sections that matter — what it knows and what it left running —
        down by 60px for the same sentence.
      */}
      <KnownFiles />
      <Eggs />
    </div>
  );
}

/* ── Who ────────────────────────────────────────────────────────────────── */

function AgentHead({ data }: { data: MonitorData }) {
  const t = useT();
  const status = useSessionStore((s) => s.agent.status);
  const model = useSessionStore((s) => s.agent.model);
  const coverage = useAvatarSkinCoverage();
  const visual: AgentVisualState = { status, mood: moodFor(status) };
  const media = skinMediaFor(coverage, status);
  const tone = toneForStatus(status);
  const phase = data.phase;

  return (
    <div className="mon-agent">
      {/*
        The character, framed the way the proposal frames it: a square tile on
        the left, the status beside it. The tile is a fixed 88px box and the
        avatar inside is Classic's own `h-[184px]` block — the size the fit,
        the pose, the props and the idle animations were authored for — scaled
        down as a whole, so the animation keeps playing.
      */}
      <div className="mon-agent__tile" aria-hidden>
        <div className="mon-agent__tileinner">
          {media ? <MediaAvatar visual={visual} src={media.src} video={media.video} /> : <Avatar visual={visual} />}
        </div>
      </div>
      <div className="mon-agent__caption">
        <div className={`mon-agent__state mon-chip--${tone}`} style={{ background: "transparent", padding: 0 }}>
          <Dot tone={tone} />
          {t(statusLabel(status)).toUpperCase()}
          {phase ? <span style={{ color: "var(--mon-t3)" }}>· {t(phaseWord(phase))}</span> : null}
        </div>
        <div className="mon-agent__line" title={data.liveHeadline}>
          {data.liveHeadline ?? t("Idle — waiting for a task")}
        </div>
        <div className="mon-agent__sub">
          {model ?? "—"} · {data.run ? `#${data.run.index}` : t("no run")}
        </div>
      </div>
    </div>
  );
}

/* ── Cost ───────────────────────────────────────────────────────────────── */

function Usage() {
  const t = useT();
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const frames = useMetricsStore.getState().frames;
  const now = useNow(2000);

  /**
   * The numbers for the asked-for scope: one egg when one is selected (the same
   * selection Agent Eggs sets), otherwise the whole agent.
   */
  const { cores, avgCores, memMiB, peakMiB, cpuSpark, memSpark, cpuCount, scope } = useMemo(() => {
    const latest = latestFrame(frames);
    const cpuCountNow = latest?.host.cpuCount ?? 1;
    const scoped = selectedEggPid !== undefined;
    const points = scoped ? eggPoints(frames, selectedEggPid) : agentPoints(frames);
    const spark = points.slice(-90).map((point, index, list) => {
      if (index === 0) return 0;
      const seconds = (point.ts - list[index - 1]!.ts) / 1000;
      return seconds > 0 ? Math.max(0, (point.cpuSeconds - list[index - 1]!.cpuSeconds) / seconds) : 0;
    });
    const mem = points.slice(-90).map((point) => point.rssBytes / (1024 * 1024));
    const egg = scoped ? findEgg(frames, selectedEggPid) : undefined;
    return {
      cores: scoped ? eggCpuCores(frames, selectedEggPid) : agentCpuCores(frames),
      avgCores: scoped ? eggAverageCores(frames, selectedEggPid, 5 * 60_000) : agentAverageCores(frames, 5 * 60_000),
      memMiB: egg?.rssBytes
        ? egg.rssBytes / (1024 * 1024)
        : scoped
          ? (mem.at(-1) ?? 0)
          : latest?.agent?.rssBytes
            ? latest.agent.rssBytes / (1024 * 1024)
            : (mem.at(-1) ?? 0),
      peakMiB: mem.length > 0 ? Math.max(...mem) : 0,
      cpuSpark: spark,
      memSpark: mem,
      cpuCount: cpuCountNow,
      scope: scoped ? (egg?.name ?? `pid ${selectedEggPid}`) : undefined,
    };
  }, [frames, version, now, selectedEggPid]);

  /**
   * One row of labels, one row of figures.
   *
   *   CPU        <the process being watched>        MEM
   *   0.30% avg 0.37%                          252 MB peak 292
   *
   * The label row names the *scope* in the middle, because the two figures are
   * whatever that scope is: the whole agent by default, one egg when one is
   * selected. Putting the name between them is what makes "CPU" and "MEM" mean
   * something without a second caption line.
   *
   * The figure is one line, not three: the current value in its metric's colour,
   * the secondary value beside it in small grey. `cores` and `host` were dropped
   * — a rail this narrow is read at a glance, and "0.00 cores" beside "0.30%"
   * says the same thing twice in different units.
   */
  const name = scope ?? t("Agent");

  return (
    <div className="mon-met">
      <div className="mon-met__head">
        <span>{t("CPU")}</span>
        <span className="mon-met__name" title={name}>
          {name}
        </span>
        <span>{t("MEM")}</span>
      </div>

      <div className="mon-met__row">
        <div className="mon-met__cell">
          <b style={{ color: CPU_COLOR }}>
            {frames.length === 0 ? "—" : formatPercent((cores / Math.max(1, cpuCount)) * 100)}
          </b>
          {frames.length === 0 ? (
            <small>{t("Waiting for the first sample…")}</small>
          ) : (
            <small>
              {t("avg")} {formatPercent((avgCores / Math.max(1, cpuCount)) * 100)}
            </small>
          )}
          {frames.length > 0 ? <Spark values={cpuSpark} tone="run" /> : null}
        </div>

        <div className="mon-met__cell mon-met__cell--end">
          <b style={{ color: MEM_COLOR }}>
            {frames.length === 0 ? "—" : formatBytes(memMiB * 1024 * 1024)}
          </b>
          {frames.length === 0 ? <small>&nbsp;</small> : <small>{`${t("peak")} ${Math.round(peakMiB)}`}</small>}
          {frames.length > 0 ? <Spark values={memSpark} tone="read" /> : null}
        </div>
      </div>
    </div>
  );
}

/* ── What it knows ──────────────────────────────────────────────────────── */

/**
 * The agent's files, newest first, each expanded into the versions it has held.
 *
 * The version chips are the point: `v0 read → v1 write → v2 edit` says at a
 * glance whether the agent has been back to a file, and which state is current.
 * Expanding a row lists every version, and a click opens that one on the Stage —
 * Classic's behaviour, drawn as this face's rows.
 */
function KnownFiles() {
  const t = useT();
  const files = useFileStore((s) => s.files);
  const activeId = useStageStore((s) => s.activeItem?.id);
  const agentFile = useStageStore((s) => s.agentFile);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const rows = useMemo(
    () =>
      Object.values(files).sort(
        (a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || a.path.localeCompare(b.path),
      ),
    [files],
  );

  const shownPath =
    activeId !== undefined && activeId === agentFile?.id && agentFile.payload.kind === "file"
      ? agentFile.payload.path
      : undefined;

  return (
    <section className="mon-railsec">
      <div className="mon-sec">
        <span className="mon-cap">{t("Agent Folder")}</span>
        <span>{rows.length === 0 ? t("none") : t("{n} files it knows", { n: rows.length })}</span>
      </div>

      {rows.length === 0 ? (
        <p className="mon-fold">{t("The agent has not touched anything yet. Files appear here as it reads and edits them.")}</p>
      ) : (
        <div className="mon-raillist">
          {rows.map((file) => {
            const open = expanded === file.path;
            const current = shownPath === file.path;
            const versions = file.history;
            return (
              <div key={file.path}>
                <button
                  type="button"
                  className="mon-file"
                  data-on={current ? "true" : undefined}
                  onClick={() => setExpanded(open ? undefined : file.path)}
                  title={open ? t("Hide versions") : t("Show versions")}
                >
                  <span className="mon-file__caret" aria-hidden>
                    {open ? "▾" : "▸"}
                  </span>
                  <span className="mon-file__n" title={file.path}>
                    {file.path}
                  </span>
                  <span className="mon-vers">
                    {versions.slice(-3).map((entry) => (
                      <i
                        key={entry.version}
                        data-cur={entry.version === file.version ? "true" : undefined}
                        className={
                          entry.source === "read"
                            ? "mon-chip--read"
                            : entry.source === "edit"
                              ? "mon-chip--edit"
                              : "mon-chip--search"
                        }
                      >
                        v{entry.version}
                      </i>
                    ))}
                  </span>
                  <span className="mon-file__size">{formatBytes(file.content.length)}</span>
                </button>

                {open ? (
                  <div className="mon-verlist">
                    {[...versions].reverse().map((entry) => (
                      <button
                        key={entry.version}
                        type="button"
                        onClick={() => openKnownFile(file.path, entry.version)}
                        title={t("Show v{v} on the Stage", { v: entry.version })}
                      >
                        <span className="mon-verlist__v">v{entry.version}</span>
                        <span
                          className={
                            entry.source === "read"
                              ? "mon-chip--read"
                              : entry.source === "edit"
                                ? "mon-chip--edit"
                                : "mon-chip--search"
                          }
                        >
                          {entry.source}
                        </span>
                        <span className="mon-verlist__what">
                          {entry.complete
                            ? t("whole file")
                            : entry.startLine !== undefined && entry.endLine !== undefined
                              ? t("lines {a}–{b}", { a: entry.startLine, b: entry.endLine })
                              : t("partial")}
                        </span>
                        <span className="mon-verlist__at">{formatClock(entry.timestamp)}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ── What it left running ───────────────────────────────────────────────── */

const EGG_FILTERS: EggFilter[] = ["running", "dead", "all"];

/**
 * Agent Eggs: the processes the agent laid and left behind.
 *
 * Read-only on purpose — Absence reports what is running, it never kills an egg.
 * Helpers (`cat`, `grep`, `sleep`) are folded into a count: the classifier
 * decides that from what a process *is*, so one daemon cannot be buried under a
 * command's tools. Classic's filter and query are kept, because a session that
 * lays a process per step needs them; the rows are this face's.
 */
function Eggs() {
  const t = useT();
  const version = useSessionStore((s) => s.eggState.version);
  const retired = useSessionStore((s) => s.eggState.retired);
  const eggsMap = useSessionStore.getState().eggState.eggs;
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const goMetrics = useStageStore((s) => s.goMetrics);
  const openStage = useStageStore((s) => s.openStage);
  const now = useNow(1000);

  // Classic opens on "running" because what is alive now is the urgent answer.
  // The same rule, applied to what actually exists: a session whose only egg
  // has exited would open on an empty list under a heading that says "0/1
  // running", which reads as a broken section rather than as a filter.
  const [filter, setFilter] = useState<EggFilter | undefined>(undefined);
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => sortEggs(eggsMap), [eggsMap, version]);
  const eggs = useMemo(() => primaryEggs(sorted), [sorted]);
  const tools = useMemo(() => summarizeTools(sorted), [sorted]);
  const counts = countEggs(eggs);
  const activeFilter: EggFilter = filter ?? (counts.running > 0 ? "running" : "all");
  const shown = useMemo(() => {
    const base = filterEggs(eggs, activeFilter);
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter(
      (egg) =>
        egg.name.toLowerCase().includes(q) ||
        egg.commandLine.toLowerCase().includes(q) ||
        (egg.command ?? "").toLowerCase().includes(q) ||
        String(egg.pid).includes(q),
    );
  }, [eggs, activeFilter, query]);

  const open = (egg: Egg) => {
    const item = eventToStageItem(egg.event);
    if (item) openStage(item);
  };

  return (
    <section className="mon-railsec">
      <div className="mon-sec">
        <span className="mon-cap">{t("Agent Eggs")}</span>
        <span>{counts.all > 0 ? t("{r}/{a} running", { r: counts.running, a: counts.all }) : t("none")}</span>
      </div>

      {eggs.length === 0 ? (
        <p className="mon-fold">{t("No eggs yet. An egg is a process the agent left running — a dev server, a watcher.")}</p>
      ) : (
        <>
          {/* Classic's filter and query, as this face's controls: a segmented
              row of counts, then a search line. */}
          <div className="mon-eggbar">
            <div className="mon-seg mon-seg--tiny" role="tablist" aria-label={t("Agent Eggs")}>
              {EGG_FILTERS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === option}
                  data-on={activeFilter === option ? "true" : undefined}
                  onClick={() => setFilter(option)}
                >
                  {t(option)}
                  <em>{option === "running" ? counts.running : option === "dead" ? counts.dead : counts.all}</em>
                </button>
              ))}
            </div>
            <input
              type="search"
              className="mon-eggbar__q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("search name, command, pid…")}
              aria-label={t("search name, command, pid…")}
            />
          </div>

          {shown.length === 0 ? (
            <p className="mon-fold">
              {query.trim() ? t("No eggs match \"{q}\".", { q: query.trim() }) : t("Nothing here. Try another filter.")}
            </p>
          ) : (
            <div className="mon-raillist">
              {shown.map((egg) => {
                const alive = egg.status === "running";
                const lived = (egg.exitedAt ?? now) - egg.startedAt;
                return (
                  <div key={egg.pid} className="mon-egg" data-running={alive ? "true" : undefined}>
                    <button
                      type="button"
                      className="mon-egg__body"
                      onClick={() => open(egg)}
                      title={t("Open pid {n} on the Stage", { n: egg.pid })}
                    >
                      <span className="mon-egg__r1">
                        <span className="mon-egg__name">
                          <Dot tone={alive ? "egg" : "mute"} />
                          <span title={egg.name}>{egg.name}</span>
                        </span>
                        <span className="mon-egg__pid">pid {egg.pid}</span>
                      </span>
                      <span className="mon-egg__r2" title={egg.commandLine}>
                        {egg.command || egg.commandLine}
                      </span>
                      <span className="mon-egg__r3">
                        {alive ? t("running for") : t("lived")} {formatDuration(lived)}
                        {egg.children > 0 ? ` · ${t("+{n} children", { n: egg.children })}` : ""}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="mon-egg__metric"
                      onClick={() => {
                        selectEgg(selectedEggPid === egg.pid ? undefined : egg.pid);
                        // Monitor's METRICS is the Stage's own page (`stageStore`),
                        // not Classic's overlay flag — a button that set the other
                        // one would look like it did nothing here.
                        goMetrics();
                      }}
                      aria-pressed={selectedEggPid === egg.pid}
                      title={t("Show this egg's resource metrics")}
                    >
                      ▤
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {tools.count > 0 || retired > 0 ? (
            <p className="mon-fold">
              {tools.count > 0 ? t("folded {n} helpers: {names}", { n: tools.count, names: tools.names.join(", ") }) : null}
              {tools.count > 0 && retired > 0 ? " · " : null}
              {retired > 0 ? t("{n} older finished processes folded", { n: retired }) : null}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
