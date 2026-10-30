import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openKnownFile } from "../../lib/openFile";
import { eventToStageItem } from "../../lib/events";
import { primaryEggs, sortEggs, summarizeTools } from "../../lib/eggs";
import { useSessionStore } from "../../stores/sessionStore";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { FilePanel } from "../../components/files/FilePanel";
import { Usage } from "../monitor/MonitorRight";
import { TONE_FOR_ROW } from "../monitor/atoms";
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
}: {
  data: RoundsData;
  panel: DockPanel;
  onOpenEggMetrics: (pid: number, name: string) => void;
}) {
  // The window's title bar already says "Files"; the panel must not print a
  // second header under it.
  if (panel === "files") return <FilePanel chrome={false} />;
  if (panel === "folder") return <FolderPanel />;
  if (panel === "eggs") return <EggsBody onOpenEggMetrics={onOpenEggMetrics} />;
  return <RunPanel data={data} />;
}

/* ── Agent Folder ────────────────────────────────────────────────────────── */

function FolderPanel() {
  const t = useT();
  const files = useFileStore((s) => s.files);
  const rows = Object.values(files).sort((a, b) => a.path.localeCompare(b.path));
  if (rows.length === 0) {
    return <p className="rounds-drawer__empty">{t("The agent has not touched anything yet.")}</p>;
  }
  return (
    <ul className="rounds-folder">
      {rows.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            onClick={() => openKnownFile(file.path, file.version)}
            title={t("Show v{v} on the Stage", { v: file.version })}
          >
            <span className="rounds-folder__p" title={file.path}>
              {file.path}
            </span>
            <span className="rounds-folder__v mon-mono">v{file.version}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ── Agent Eggs ──────────────────────────────────────────────────────────── */

/**
 * Eggs, as the explorer would show them: the agent's current cost on top (the
 * same cost panel Monitor's rail uses), then one card per egg. The card opens
 * the event that laid it; the small button on its right opens that egg's full
 * metrics, scoped.
 */
function EggsBody({ onOpenEggMetrics }: { onOpenEggMetrics: (pid: number, name: string) => void }) {
  const t = useT();
  const version = useSessionStore((s) => s.eggState.version);
  const eggsMap = useSessionStore.getState().eggState.eggs;
  const sorted = sortEggs(eggsMap);
  // Only *primary* eggs get a card — helpers (`cat`, `grep`) fold into a count
  // on the bottom line, the same reading the Monitor rail gives.
  const eggs = primaryEggs(sorted);
  const tools = summarizeTools(sorted);
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
        <>
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
        {tools.count > 0 ? (
          <p className="rounds-drawer__empty rounds-eggsbody__fold">
            {t("folded {n} helpers: {names}", { n: tools.count, names: tools.names.join(", ") })}
          </p>
        ) : null}
        </>
      )}
    </div>
  );
}

/* ── Run ─────────────────────────────────────────────────────────────────── */

function RunPanel({ data }: { data: RoundsData }) {
  const t = useT();
  const openStage = useStageStore((s) => s.openStage);
  const seek = useReplayStore((s) => s.seekTimestamp);
  const inReplay = useStageStore((s) => s.mode === "replay");
  if (data.rows.length === 0) {
    return <p className="rounds-drawer__empty">{t("Nothing yet. Send the agent a task.")}</p>;
  }
  return (
    <ul className="rounds-act">
      {data.rows.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            onClick={() => {
              if (inReplay) seek(row.event.timestamp);
              else if (row.stageItem) openStage(row.stageItem);
            }}
            title={row.stageItem ? row.primary : `${row.action} · ${row.primary}`}
          >
            <span className={`rounds-chip rounds-chip--${TONE_FOR_ROW[row.tone] ?? "mute"}`}>{row.action}</span>
            <span className="rounds-act__p">{row.primary}</span>
            <span className="rounds-act__t mon-mono">{formatClock(row.event.timestamp)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
