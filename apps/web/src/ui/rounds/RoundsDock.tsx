import { useEffect, useMemo, useState } from "react";
import type { AbsenceEvent, RunSummary } from "@absence/core";
import { formatBytes, formatClock, formatDuration } from "../../lib/format";
import { memoBuildHistory, memoRunRows } from "../../lib/history";
import { useT } from "../../lib/i18n";
import { eventToStageItem } from "../../lib/events";
import { primaryEggs, sortEggs } from "../../lib/eggs";
import { useEvents, useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useFileStore } from "../../stores/fileStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useRunsStore } from "../../stores/runsStore";
import { useUiStore } from "../../stores/uiStore";
import { useNow } from "../../hooks/useNow";
import { FilePanel } from "../../components/files/FilePanel";
import { Usage } from "../monitor/MonitorRight";
import { TONE_FOR_ROW } from "../monitor/atoms";
import type { HistoryRun } from "../../types/history";
import type { RoundsData } from "./useRoundsData";

/**
 * The dock: desktop shortcuts on the right edge.
 *
 * Files is the explorer; Folder is the agent's own; Eggs holds the processes
 * the agent left running, with its cost on top; Run is the round's trace.
 * There is deliberately no Metrics shortcut — metrics open from an egg, in
 * that egg's scope. The badges count what deserves a glance. Egg toasts are
 * deliberately absent for now.
 */
export type DockPanel = "files" | "folder" | "eggs" | "run";

/** The floating window's title per dock panel. */
export const WINDOW_TITLE: Record<DockPanel, string> = {
  files: "Files",
  folder: "Agent Folder",
  eggs: "Agent Eggs",
  run: "Run",
};

export function RoundsDock({
  data,
  open,
  setPanel,
}: {
  data: RoundsData;
  open: DockPanel[];
  setPanel: (panel: DockPanel) => void;
}) {
  const t = useT();
  return (
    <nav className="rounds-dock" aria-label={t("Panels")}>
      <DockButton
        id="files"
        label={t("Files")}
        icon={<path d="M3 7h6l2 2h10v10H3z" />}
        on={open.includes("files")}
        onClick={() => setPanel("files")}
      />
      <DockButton
        id="folder"
        label={t("Agent Folder")}
        icon={<path d="M6 3h9l4 4v14H6z M9 12h7M9 16h5" />}
        badge={data.badges.folder > 0 ? data.badges.folder : undefined}
        badgeTone="read"
        on={open.includes("folder")}
        onClick={() => setPanel("folder")}
      />
      <DockButton
        id="eggs"
        label={t("Agent Eggs")}
        icon={<ellipse cx="12" cy="13" rx="6.5" ry="8" />}
        badge={data.badges.eggs > 0 ? data.badges.eggs : undefined}
        badgeTone="egg"
        on={open.includes("eggs")}
        onClick={() => setPanel("eggs")}
      />
      <DockButton
        id="run"
        label={t("Run")}
        icon={<path d="M4 6h16M4 12h16M4 18h10" />}
        badge={data.badges.activity > 0 ? data.badges.activity : undefined}
        badgeTone="read"
        on={open.includes("run")}
        onClick={() => setPanel("run")}
      />
    </nav>
  );
}

function DockButton({
  id,
  label,
  icon,
  badge,
  badgeTone = "read",
  on,
  onClick,
}: {
  id: DockPanel;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  badgeTone?: "read" | "egg";
  on?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="rounds-di"
      data-on={on ? "true" : undefined}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={on ? "true" : undefined}
      data-panel={id}
    >
      {badge !== undefined ? (
        <span className={`rounds-bd rounds-bd--${badgeTone}`} aria-hidden>
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
        {icon}
      </svg>
      <span>{label}</span>
    </button>
  );
}

/**
 * The window bodies: one panel per dock icon, each a reuse, not a fork —
 * the same project tree, stores and cost panel the other faces read.
 */
export function DockBody({
  data,
  panel,
  onOpenEggMetrics,
  onOpenFile,
  onOpenVersion,
  onOpenRun,
}: {
  data: RoundsData;
  panel: DockPanel;
  onOpenEggMetrics: (pid: number, name: string) => void;
  /** Open a whole project file in a Rounds window (never the Stage). */
  onOpenFile: (path: string) => void;
  /** Open one recorded version of an agent-known file, in a Rounds window. */
  onOpenVersion: (path: string, version?: number) => void;
  /** Open one run's steps in a child window (never the Stage). */
  onOpenRun: (run: RunSummary) => void;
}) {
  // The window's title bar already says "Files"; the panel must not print a
  // second header under it.
  if (panel === "files") return <FilePanel chrome={false} onOpen={onOpenFile} />;
  if (panel === "folder") return <FolderPanel onOpenVersion={onOpenVersion} />;
  if (panel === "eggs") return <EggsBody onOpenEggMetrics={onOpenEggMetrics} />;
  return <RunPanel data={data} onOpenRun={onOpenRun} />;
}

/* ── Agent Folder ────────────────────────────────────────────────────────── */

/** A version's source, in this face's chip vocabulary. */
const SOURCE_TONE = { read: "read", write: "edit", edit: "edit" } as const;

/**
 * The agent's own files, as a folder that opens to its versions.
 *
 * Every version is a *recorded* state — the text the agent held at that
 * moment, never the file on disk — so a click opens that content in a Rounds
 * window and nothing else: no pin, no replay, no Stage. The shape is Monitor's
 * rail and Classic's AgentFolder: the caret folds the versions out, the name
 * opens the newest one, a row opens that one version.
 */
function FolderPanel({ onOpenVersion }: { onOpenVersion: (path: string, version?: number) => void }) {
  const t = useT();
  const files = useFileStore((s) => s.files);
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggleVersions = (path: string) =>
    setExpanded((cur) => (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]));

  const rows = useMemo(
    () =>
      Object.values(files).sort(
        (a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || a.path.localeCompare(b.path),
      ),
    [files],
  );

  if (rows.length === 0) {
    return <p className="rounds-drawer__empty">{t("The agent has not touched anything yet.")}</p>;
  }

  return (
    <div className="rounds-folder">
      {rows.map((file) => {
        const open = expanded.includes(file.path);
        const latest = file.history.at(-1);
        return (
          <div key={file.path} className="rounds-fgroup">
            <div className="rounds-frow">
              <button
                type="button"
                className="rounds-fcaret"
                onClick={() => toggleVersions(file.path)}
                title={open ? t("Hide versions") : t("Show versions")}
                aria-label={open ? t("Hide versions") : t("Show versions")}
                aria-expanded={open}
              >
                {open ? "▾" : "▸"}
              </button>
              <button
                type="button"
                className="rounds-fname"
                onClick={() => onOpenVersion(file.path, latest?.version)}
                title={t("Show the newest agent-known content")}
              >
                <span className="rounds-fname__p" title={file.path}>
                  {file.path}
                </span>
                <span className="rounds-fname__v mon-mono">
                  {t("{n} versions", { n: file.history.length })} · {formatBytes(file.content.length)}
                </span>
              </button>
            </div>

            {open ? (
              <ul className="rounds-flist">
                {[...file.history].reverse().map((entry) => (
                  <li key={entry.version}>
                    <button
                      type="button"
                      className="rounds-fver"
                      onClick={() => onOpenVersion(file.path, entry.version)}
                      title={t("Show v{v}", { v: entry.version })}
                    >
                      <span className="rounds-fver__v">v{entry.version}</span>
                      <span className={`rounds-chip rounds-chip--${SOURCE_TONE[entry.source]}`}>{entry.source}</span>
                      <span className="rounds-fver__what">
                        {entry.complete
                          ? t("whole file")
                          : entry.startLine !== undefined && entry.endLine !== undefined
                            ? t("lines {a}–{b}", { a: entry.startLine, b: entry.endLine })
                            : t("partial")}
                      </span>
                      <span className="rounds-fver__at mon-mono">{formatClock(entry.timestamp)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ── Agent Eggs ──────────────────────────────────────────────────────────── */

/**
 * Eggs, as the explorer would show them: the agent's current cost on top (the
 * same cost panel Monitor's rail uses), then one card per egg.
 *
 * A card has two zones. The left is the egg itself — click it to jump to the
 * event that laid it. The right is a narrow strip: click it to open that egg's
 * metrics, scoped to its pid. Helpers are not listed at all; they are processes
 * the classifier folded away, and counting them here only added noise.
 */
function EggsBody({ onOpenEggMetrics }: { onOpenEggMetrics: (pid: number, name: string) => void }) {
  const t = useT();
  const version = useSessionStore((s) => s.eggState.version);
  const eggsMap = useSessionStore.getState().eggState.eggs;
  const eggs = primaryEggs(sortEggs(eggsMap));
  // `version` is the re-render trigger: the map above is read via getState().
  void version;
  return (
    <div className="rounds-eggsbody">
      <div className="rounds-eggsbody__cost">
        <Usage />
      </div>
      {eggs.length === 0 ? (
        <p className="rounds-drawer__empty">
          {t("No eggs yet. An egg is a process the agent left running — a dev server, a watcher.")}
        </p>
      ) : (
        <ul className="rounds-eggs">
          {eggs.map((egg) => {
            const alive = egg.status === "running";
            return (
              <li key={egg.pid} className="rounds-egg">
                <button
                  type="button"
                  className="rounds-egg__body"
                  onClick={() => {
                    const item = eventToStageItem(egg.event);
                    if (item) useStageStore.getState().openStage(item);
                  }}
                  title={t("The event that laid this egg")}
                >
                  <i className="rounds-dot" data-tone={alive ? "egg" : "mute"} aria-hidden />
                  <span className="rounds-eggs__name" title={egg.name}>
                    {egg.name}
                  </span>
                  <span className="rounds-eggs__meta mon-mono">
                    pid {egg.pid} · {alive ? formatDuration((egg.exitedAt ?? Date.now()) - egg.startedAt) : t("exited")}
                  </span>
                </button>
                <button
                  type="button"
                  className="rounds-egg__m"
                  onClick={() => onOpenEggMetrics(egg.pid, egg.name)}
                  title={t("Show this egg's resource metrics")}
                  aria-label={t("Show this egg's resource metrics")}
                >
                  ▤
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

/** A run's dot, in this face's tones. */
const RUN_TONE: Record<RunSummary["status"], string> = {
  running: "run",
  completed: "edit",
  interrupted: "mute",
  error: "err",
};

/** A run's status, in the words Monitor's switcher uses. */
const RUN_WORD: Record<RunSummary["status"], string> = {
  running: "running",
  completed: "done",
  interrupted: "stopped",
  error: "error",
};

/**
 * The session's runs, newest first — Classic's History and Monitor's run
 * switcher, in a window of their own.
 *
 * The first level is the run list: `#N`, status, how long it took, when it
 * started and the prompt. Each card does two things: it makes that run the
 * selected one (the story, the scene and the badges follow it) and it opens
 * that run's steps in their own window — `RunSteps` below. The steps are the
 * second level; clicking one of them is what opens an event window.
 *
 * Runs come from `runsStore`, not from `data`: the list has to include rounds
 * that are no longer selected, and only summaries are loaded up front. A run's
 * events are fetched when its card is opened, and cached per run.
 */
function RunPanel({ data, onOpenRun }: { data: RoundsData; onOpenRun: (run: RunSummary) => void }) {
  const t = useT();
  const sessionId = useSessionStore((s) => s.session?.id);
  const runs = useRunsStore((s) => s.runs);
  const runsLoading = useRunsStore((s) => s.loading);
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const selectRun = useUiStore((s) => s.selectRun);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const now = useNow(1000);

  useEffect(() => {
    if (sessionId && runs.length === 0) void loadRuns(sessionId);
  }, [sessionId, runs.length, loadRuns]);

  if (runs.length === 0) {
    return (
      <p className="rounds-drawer__empty">
        {runsLoading ? t("loading…") : t("Nothing yet. Send the agent a task.")}
      </p>
    );
  }

  const currentId = data.run?.id ?? selectedRunId;

  return (
    <ul className="rounds-runs">
      {[...runs].reverse().map((run) => {
        return (
          <li key={run.id} className="rounds-run" data-on={run.id === currentId ? "true" : undefined}>
            <button
              type="button"
              className="rounds-run__card"
              onClick={() => {
                selectRun(run.id);
                onOpenRun(run);
              }}
              title={run.prompt || t("(observed activity)")}
            >
              <span className="rounds-run__r1">
                <i className="rounds-dot" data-tone={RUN_TONE[run.status]} aria-hidden />
                <span className="rounds-run__idx">
                  #{run.index} · {t(RUN_WORD[run.status])}
                </span>
                <span className="rounds-run__times mon-mono">
                  {formatDuration((run.endedAt ?? now) - run.startedAt)} · {formatClock(run.startedAt)}
                </span>
              </span>
              <span className="rounds-run__prompt">{run.prompt || t("(observed activity)")}</span>
              <span className="rounds-run__counts mon-mono">
                R{run.counts.read} S{run.counts.search} E{run.counts.edit} ${run.counts.run}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The steps of a run whose events have not arrived yet. */
const NO_EVENTS: AbsenceEvent[] = [];

/**
 * One run's steps, in the window its card opened.
 *
 * A live run reads the live event window so rows keep landing; every other run
 * reads its cached range — fetched once from the run API and kept by run id in
 * `runsStore`. The rows are the ones `memoRunRows` builds for the story, and a
 * click opens its event: seek in replay, otherwise stage.
 */
export function RunSteps({ runId }: { runId: string }) {
  const t = useT();
  const runs = useRunsStore((s) => s.runs);
  const run = runs.find((entry) => entry.id === runId);
  const sessionId = useSessionStore((s) => s.session?.id);
  const liveEvents = useEvents();
  const liveRuns = useMemo(() => memoBuildHistory(liveEvents), [liveEvents]);
  const liveDerived = liveRuns[liveRuns.length - 1];
  const isLive = run !== undefined && run.status === "running" && run.id === runs[runs.length - 1]?.id;
  const loaded = useRunsStore((s) => s.eventsByRun[runId]);
  const pending = useRunsStore((s) => s.pending[runId] === true);
  const loadRunEvents = useRunsStore((s) => s.loadRunEvents);
  const inActivity = useSettingsStore((s) => s.displayInActivity);
  const observed = useIsObserved();
  const showProcessRows = inActivity || observed;
  const openStage = useStageStore((s) => s.openStage);
  const seek = useReplayStore((s) => s.seekTimestamp);
  const inReplay = useStageStore((s) => s.mode === "replay");

  useEffect(() => {
    if (!sessionId || !run || isLive || loaded) return;
    void loadRunEvents(sessionId, run);
  }, [sessionId, run, isLive, loaded, loadRunEvents]);

  const events = isLive ? liveEvents : (loaded ?? NO_EVENTS);

  const history = useMemo<HistoryRun | undefined>(() => {
    if (!run) return undefined;
    if (isLive && liveDerived) {
      return {
        id: run.id,
        index: run.index,
        prompt: run.prompt,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        status: run.status,
        fromIndex: liveDerived.fromIndex,
        toIndex: liveDerived.toIndex,
        counts: run.counts,
      };
    }
    return {
      id: run.id,
      index: run.index,
      prompt: run.prompt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      status: run.status,
      fromIndex: 0,
      toIndex: events.length - 1,
      counts: run.counts,
      partial: run.partial,
    };
  }, [run, isLive, liveDerived, events]);

  if (!run) return <p className="rounds-drawer__empty">{t("loading…")}</p>;

  const rows = history ? memoRunRows(events, history, showProcessRows) : [];

  if (rows.length === 0) {
    return (
      <p className="rounds-drawer__empty">
        {pending || (loaded === undefined && !isLive) ? t("loading…") : t("No steps in this run.")}
      </p>
    );
  }

  return (
    <ul className="rounds-act rounds-steps">
      {rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => {
              if (inReplay) seek(row.event.timestamp);
              else if (row.stageItem) openStage(row.stageItem);
            }}
            title={row.stageItem ? row.primary : `${row.action} · ${row.primary}`}
          >
            <span className={`rounds-chip rounds-chip--${TONE_FOR_ROW[row.tone] ?? "mute"}`}>
              {row.action}
            </span>
            <span className="rounds-act__p">{row.primary}</span>
            <span className="rounds-act__t mon-mono">{formatClock(row.event.timestamp)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
