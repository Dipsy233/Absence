import { formatClock, formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { openKnownFile } from "../../lib/openFile";
import { eventToStageItem } from "../../lib/events";
import { sortEggs } from "../../lib/eggs";
import { useSessionStore } from "../../stores/sessionStore";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useNow } from "../../hooks/useNow";
import { MetricsDashboard } from "../../components/metrics/MetricsDashboard";
import { FilePanel } from "../../components/files/FilePanel";
import { TONE_FOR_ROW } from "../monitor/atoms";
import type { RoundsData } from "./useRoundsData";

/**
 * The dock: a rail of icons on the right edge; the panels a supervision face
 * needs but the narrative does not always show.
 *
 * Clicking an icon expands a stage — a drawer over the peek column holding the
 * relevant content, reusing the exact panels the other faces use (the metrics
 * dashboard, the project tree) so a fact cannot disagree between faces. The
 * badges count what deserves a glance: files known, eggs running, steps taken.
 * Egg toasts are deliberately absent for now.
 */
export type DockPanel = "files" | "folder" | "eggs" | "metrics" | "activity";

export function RoundsDock({
  data,
  panel,
  setPanel,
}: {
  data: RoundsData;
  panel: DockPanel | undefined;
  setPanel: (panel: DockPanel | undefined) => void;
}) {
  const t = useT();
  const toggle = (id: DockPanel) => setPanel(panel === id ? undefined : id);

  return (
    <nav className="rounds-dock" aria-label={t("Panels")}>
      <DockButton
        id="files"
        label={t("Files")}
        icon={<path d="M3 7h6l2 2h10v10H3z" />}
        on={panel === "files"}
        onClick={() => toggle("files")}
      />
      <DockButton
        id="folder"
        label={t("Agent Folder")}
        icon={<path d="M6 3h9l4 4v14H6z M9 12h7M9 16h5" />}
        badge={data.badges.folder > 0 ? data.badges.folder : undefined}
        badgeTone="read"
        on={panel === "folder"}
        onClick={() => toggle("folder")}
      />
      <DockButton
        id="eggs"
        label={t("Agent Eggs")}
        icon={
          <>
            <ellipse cx="12" cy="13" rx="6.5" ry="8" />
          </>
        }
        badge={data.badges.eggs > 0 ? data.badges.eggs : undefined}
        badgeTone="egg"
        on={panel === "eggs"}
        onClick={() => toggle("eggs")}
      />
      <DockButton
        id="metrics"
        label={t("Metrics")}
        icon={<path d="M3 17l5-6 4 3 6-8 3 4" />}
        on={panel === "metrics"}
        onClick={() => toggle("metrics")}
      />
      <DockButton
        id="activity"
        label={t("Activity")}
        icon={<path d="M4 6h16M4 12h16M4 18h10" />}
        badge={data.badges.activity > 0 ? data.badges.activity : undefined}
        badgeTone="read"
        on={panel === "activity"}
        onClick={() => toggle("activity")}
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

/** The drawer's content: one panel per dock icon, each a reuse, not a fork. */
export function RoundsDrawer({ data, panel, onClose }: { data: RoundsData; panel: DockPanel; onClose: () => void }) {
  const t = useT();
  return (
    <section className="rounds-drawer" aria-label={t("Panels")}>
      <div className="rounds-drawer__h">
        <span className="rounds-cap">{DRAWER_TITLE[panel] ? t(DRAWER_TITLE[panel]!) : ""}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="rounds-ghostbtn" onClick={onClose} title={t("Close")} aria-label={t("Close")}>
          ✕
        </button>
      </div>
      <div className="rounds-drawer__body">
        {panel === "files" ? (
          <div className="rounds-drawer__tree">
            <FilePanel />
          </div>
        ) : panel === "folder" ? (
          <FolderPanel />
        ) : panel === "eggs" ? (
          <EggsPanel />
        ) : panel === "metrics" ? (
          <MetricsDashboard embedded />
        ) : (
          <ActivityPanel data={data} />
        )}
      </div>
    </section>
  );
}

const DRAWER_TITLE: Record<DockPanel, string> = {
  files: "Files",
  folder: "Agent Folder",
  eggs: "Agent Eggs",
  metrics: "Metrics",
  activity: "Activity",
};

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

function EggsPanel() {
  const t = useT();
  const version = useSessionStore((s) => s.eggState.version);
  const eggsMap = useSessionStore.getState().eggState.eggs;
  const openStage = useStageStore((s) => s.openStage);
  const now = useNow(1000);
  const eggs = sortEggs(eggsMap);
  // `version` is the re-render trigger: the map above is read via getState().
  void version;
  if (eggs.length === 0) {
    return <p className="rounds-drawer__empty">{t("No eggs yet. An egg is a process the agent left running — a dev server, a watcher.")}</p>;
  }
  return (
    <ul className="rounds-eggs">
      {eggs.map((egg) => {
        const alive = egg.status === "running";
        return (
          <li key={egg.pid}>
            <button
              type="button"
              onClick={() => {
                const item = eventToStageItem(egg.event);
                if (item) openStage(item);
              }}
              title={t("Open pid {n} on the Stage", { n: egg.pid })}
            >
              <i className="rounds-dot" data-tone={alive ? "egg" : "mute"} aria-hidden />
              <span className="rounds-eggs__name" title={egg.name}>
                {egg.name}
              </span>
              <span className="rounds-eggs__meta mon-mono">
                pid {egg.pid} · {alive ? formatDuration((egg.exitedAt ?? now) - egg.startedAt) : t("exited")}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Activity ────────────────────────────────────────────────────────────── */

function ActivityPanel({ data }: { data: RoundsData }) {
  const t = useT();
  const openStage = useStageStore((s) => s.openStage);
  const seek = useReplayStore((s) => s.seekTimestamp);
  const inReplay = useStageStore((s) => s.mode === "replay");
  const runStart = data.run?.startedAt;
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
            <span className="rounds-act__t mon-mono">
              {runStart !== undefined ? formatClock(row.event.timestamp) : ""}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
