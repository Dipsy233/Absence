import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { THEMES, type ThemeId } from "../../lib/theme";
import { LANGUAGES, useT } from "../../lib/i18n";
import {
  useSettingsStore,
  type CommandFailLevel,
  type LeftPanelId,
  type RailPanelId,
} from "../../stores/settingsStore";
import { AvatarSkinPane } from "./AvatarSkinPane";
import { SoundPane } from "./SoundPane";
import {
  activateEggFilter,
  deleteEggFilter,
  fetchEggFilter,
  fetchMetricsInfo,
  saveEggFilter,
  type EggFilterProfileMeta,
  type MetricsInfo,
} from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";

const RAIL_LABELS: Record<RailPanelId, string> = {
  agent: "Agent (WhaleBun)",
  folder: "Agent Folder",
  eggs: "Agent Eggs",
};

const LEFT_LABELS: Record<LeftPanelId, string> = {
  files: "Files",
  history: "History",
  activity: "Activity",
};

const THEME_IDS: ThemeId[] = ["amber", "blue", "green"];

const FAIL_LEVELS: CommandFailLevel[] = ["none", "low", "medium", "high"];

const FAIL_LEVEL_TEXT: Record<CommandFailLevel, string> = {
  none: "silent",
  low: "low",
  medium: "medium",
  high: "high",
};

/**
 * The Settings dialog, opened from the gear button in the session bar. Four
 * panes:
 *
 *   p1      — appearance & layout (language, theme, rail orders, chat)
 *   p2      — report: failed-command warning threshold & level
 *   p3      — personalization: avatar skin + sound sets stacked in one pane
 *   p4      — Agent Eggs filter profiles: a small file manager over the
 *             server's profile directory
 *
 * Skills and MCP are not here: they are chat commands (`/skill`, `/mcp`), the
 * same place Pi and Codex put them, so they sit next to the prompt they act on.
 *
 * Rendered through a portal so the session bar's overflow/drag rules cannot
 * clip or swallow it.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-[85vh] w-[1500px] max-w-[96vw] overflow-hidden rounded-lg border border-desk-line bg-desk-panel shadow-[0_8px_40px_rgba(0,0,0,.5)]">
        {/* ════ Left: appearance & layout ═══════════════════ */}
        <AppearancePane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Report: failed-command warning ═════════════ */}
        <ReportPane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Personalization: avatar skin + sound sets ══ */}
        <PersonalizationPane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Metrics: retention + the Prometheus endpoint ═ */}
        <MetricsPane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Right: egg filter profiles ══════════════════ */}
        <EggFilterPane />
      </div>
    </div>,
    document.body,
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Metrics: how long the server keeps process metrics, and the URL a
   Prometheus server can scrape. Both are server policy, so this pane
   reports them and explains the env var instead of pretending a browser
   toggle can change them.
   ══════════════════════════════════════════════════════════════════════ */
function MetricsPane() {
  const t = useT();
  const session = useSessionStore((s) => s.session);
  const [info, setInfo] = useState<MetricsInfo | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchMetricsInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => {
        if (!cancelled) setInfo(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scrapeUrl =
    session && info
      ? `${window.location.origin}${info.scrapePath.replace("{id}", session.id)}&from=${
          Date.now() - 60 * 60_000
        }&to=${Date.now()}`
      : undefined;

  return (
    <div className="min-w-0 flex-1 basis-0 overflow-y-auto p-4">
      <h2 className="mb-3 font-mono text-sm tracking-widest text-desk-ink">{t("METRICS")}</h2>

      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">
          {t("retention")}
        </h3>
        <p className="font-mono text-[11px] leading-relaxed text-desk-ink/80">
          {info
            ? info.retentionDays > 0
              ? t("{n} {unit}, then they expire", { n: info.retentionDays, unit: t("days of process metrics") })
              : t("keep every sample (bounded only by disk)")
            : t("loading…")}
        </p>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-desk-dim">
          {t("Set it with ABSENCE_METRICS_RETENTION_DAYS (0 keeps everything).")}
        </p>
      </section>

      <section>
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">
          {t("Prometheus endpoint")}
        </h3>
        <p className="mb-1.5 font-mono text-[10px] leading-relaxed text-desk-dim">
          {t("Scrape this session's eggs with format=prometheus:")}
        </p>
        <code className="block break-all rounded border border-desk-line bg-desk-panel2 px-2 py-1 font-mono text-[10px] text-desk-teal">
          {scrapeUrl ?? info?.scrapePath ?? "—"}
        </code>
        <button
          type="button"
          disabled={!scrapeUrl}
          onClick={() => {
            if (!scrapeUrl) return;
            void navigator.clipboard?.writeText(scrapeUrl).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="mt-1.5 rounded border border-desk-line px-2 py-0.5 font-mono text-[10px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
        >
          {copied ? t("copied") : t("Copy the scrape URL")}
        </button>
      </section>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Personalization: the avatar-skin and sound-set managers stacked in one
   pane, so the dialog keeps a pane count the stage can afford.
   ══════════════════════════════════════════════════════════════════════ */
function PersonalizationPane() {
  return (
    <div className="flex min-w-0 flex-[1.2] basis-0 flex-col">
      {/* Each half scrolls on its own; `overflow-hidden` keeps one pane's
          content from painting over the other (the Apply rows otherwise
          overlapped the pane below). */}
      <div className="relative min-h-0 flex-1 overflow-hidden border-b border-desk-line/70">
        <AvatarSkinPane />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <SoundPane />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════
   Report pane: the Absence Report's human-attention thresholds.
   ══════════════════════════════════════════════════════════════════════ */
function ReportPane() {
  const t = useT();
  return (
    <div className="min-w-0 flex-1 basis-0 overflow-y-auto p-4">
      <h2 className="mb-3 font-mono text-sm tracking-widest text-desk-ink">{t("REPORT WARN")}</h2>
      <CommandFailSettings />
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Appearance & layout (the left pane): language, theme and the two rails'
   panel order. Same sections the dialog had when it was a single column.
   ════════════════════════════════════════════════════════════════════════ */
function AppearancePane() {
  const t = useT();
  const language = useSettingsStore((s) => s.language);
  const setLanguage = useSettingsStore((s) => s.setLanguage);
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const railOrder = useSettingsStore((s) => s.railOrder);
  const moveRailPanel = useSettingsStore((s) => s.moveRailPanel);
  const leftOrder = useSettingsStore((s) => s.leftOrder);
  const moveLeftPanel = useSettingsStore((s) => s.moveLeftPanel);
  const collapseChatOnContent = useSettingsStore((s) => s.collapseChatOnContent);
  const setCollapseChatOnContent = useSettingsStore((s) => s.setCollapseChatOnContent);

  return (
    <div className="min-w-0 flex-1 basis-0 overflow-y-auto p-4">
      <h2 className="mb-3 font-mono text-sm tracking-widest text-desk-ink">{t("APPEARANCE")}</h2>

      {/* ── Language ───────────────────────────────────────── */}
      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">
          {t("Language · 语言")}
        </h3>
        <div className="flex gap-1.5">
          {LANGUAGES.map((lang) => (
            <button
              key={lang.id}
              type="button"
              onClick={() => setLanguage(lang.id)}
              className={[
                "rounded border px-2.5 py-1 font-mono text-[11px] transition-colors",
                language === lang.id
                  ? "border-desk-amber/70 bg-desk-amber/10 text-desk-amber"
                  : "border-desk-line bg-desk-panel2 text-desk-dim hover:text-desk-ink",
              ].join(" ")}
            >
              {lang.label}
            </button>
          ))}
        </div>
      </section>

      {/* ── Theme ──────────────────────────────────────────── */}
      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">{t("Color theme")}</h3>
        <div className="flex gap-1.5">
          {THEME_IDS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setTheme(id)}
              className={[
                "flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[11px] transition-colors",
                theme === id
                  ? "border-desk-amber/70 bg-desk-amber/10 text-desk-amber"
                  : "border-desk-line bg-desk-panel2 text-desk-dim hover:text-desk-ink",
              ].join(" ")}
            >
              <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: THEMES[id].accent }} />
              {id}
            </button>
          ))}
        </div>
      </section>

      {/* ── Chat ──────────────────────────────────────────── */}
      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">{t("Chat")}</h3>
        <label className="flex items-start gap-1.5 text-[11px] leading-snug text-desk-dim">
          <input
            type="checkbox"
            checked={collapseChatOnContent}
            onChange={(e) => setCollapseChatOnContent(e.target.checked)}
            className="mt-0.5 accent-[rgb(var(--desk-accent))]"
          />
          <span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-desk-ink">
              {t("collapse on content")}
            </span>
            {" — "}
            {t(
              "fold the chat history away whenever the Stage shows a file, diff, terminal or the report. Off (the default) keeps the chat exactly as you left it.",
            )}
          </span>
        </label>
      </section>

      {/* ── Left rail order ───────────────────────────────── */}
      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">
          {t("Left rail panel order")}
        </h3>
        <ul className="space-y-1">
          {leftOrder.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
              <span className="flex-1 font-mono text-[11px] text-desk-ink">
                {i + 1}. {t(LEFT_LABELS[id])}
              </span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveLeftPanel(id, "up")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title={t("Move up")}
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === leftOrder.length - 1}
                onClick={() => moveLeftPanel(id, "down")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title={t("Move down")}
              >
                ▼
              </button>
            </li>
          ))}
        </ul>
      </section>

      {/* ── Right rail order ─────────────────────────────── */}
      <section>
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">
          {t("Right rail panel order")}
        </h3>
        <ul className="space-y-1">
          {railOrder.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
              <span className="flex-1 font-mono text-[11px] text-desk-ink">
                {i + 1}. {t(RAIL_LABELS[id])}
              </span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveRailPanel(id, "up")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title={t("Move up")}
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === railOrder.length - 1}
                onClick={() => moveRailPanel(id, "down")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title={t("Move down")}
              >
                ▼
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/**
 * Failed-command warning controls: how many commands must fail in one run
 * before the Absence Report raises `command_failed`, and at what level.
 */
function CommandFailSettings() {
  const t = useT();
  const threshold = useSettingsStore((s) => s.commandFailThreshold);
  const setThreshold = useSettingsStore((s) => s.setCommandFailThreshold);
  const level = useSettingsStore((s) => s.commandFailLevel);
  const setLevel = useSettingsStore((s) => s.setCommandFailLevel);
  const streakThreshold = useSettingsStore((s) => s.commandStreakThreshold);
  const setStreakThreshold = useSettingsStore((s) => s.setCommandStreakThreshold);
  const streakLevel = useSettingsStore((s) => s.commandStreakLevel);
  const setStreakLevel = useSettingsStore((s) => s.setCommandStreakLevel);
  const stallThreshold = useSettingsStore((s) => s.activityStallThreshold);
  const setStallThreshold = useSettingsStore((s) => s.setActivityStallThreshold);
  const stallLevel = useSettingsStore((s) => s.activityStallLevel);
  const setStallLevel = useSettingsStore((s) => s.setActivityStallLevel);

  return (
    <div className="space-y-4">
      <label className="block text-[11px] text-desk-dim">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">{t("command failed per run")}</span>
        <input
          type="number"
          min={1}
          max={99}
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="w-24 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
        />
      </label>
      <label className="block text-[11px] text-desk-dim">
        <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">{t("attention level")}</span>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as CommandFailLevel)}
          className="w-32 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
        >
          {FAIL_LEVELS.map((id) => (
            <option key={id} value={id}>
              {t(FAIL_LEVEL_TEXT[id])}
            </option>
          ))}
        </select>
      </label>
      <div className="border-t border-desk-line/70 pt-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-desk-ink/80">{t("failure streak")}</p>
        <label className="mb-2 block text-[11px] text-desk-dim">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">{t("consecutive failed")}</span>
          <input
            type="number"
            min={1}
            max={99}
            value={streakThreshold}
            onChange={(e) => setStreakThreshold(Number(e.target.value))}
            className="w-24 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
          />
        </label>
        <label className="block text-[11px] text-desk-dim">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">{t("attention level")}</span>
          <select
            value={streakLevel}
            onChange={(e) => setStreakLevel(e.target.value as CommandFailLevel)}
            className="w-32 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
          >
            {FAIL_LEVELS.map((id) => (
              <option key={id} value={id}>
                {t(FAIL_LEVEL_TEXT[id])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="border-t border-desk-line/70 pt-3">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wide text-desk-ink/80">{t("activity time")}</p>
        <label className="mb-2 block text-[11px] text-desk-dim">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">
            {t("no activity for (seconds)")}
          </span>
          <input
            type="number"
            min={1}
            max={86400}
            value={stallThreshold}
            onChange={(e) => setStallThreshold(Number(e.target.value))}
            className="w-24 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
          />
        </label>
        <label className="block text-[11px] text-desk-dim">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide">{t("attention level")}</span>
          <select
            value={stallLevel}
            onChange={(e) => setStallLevel(e.target.value as CommandFailLevel)}
            className="w-32 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
          >
            {FAIL_LEVELS.map((id) => (
              <option key={id} value={id}>
                {t(FAIL_LEVEL_TEXT[id])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[10px] leading-snug text-desk-dim/80">
        {t(
          "The Absence Report raises <code> once this many commands have failed in one run, <streak> once this many failed back-to-back, and <stall> once no event has arrived for this many seconds; unresolved failures always stay high.",
        )
          .replace("<code>", "command_failed")
          .replace("<streak>", "command_failure_streak")
          .replace("<stall>", "activity_stalled")}
      </p>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Egg filter profile manager (the right half, bottom).

   A small file manager over the server's profile directory:
     sidebar — saved profiles; click to load + activate, ✕ to delete
     top     — the file name being edited
     below   — the file content, one command name per line
   Saving with the same name overwrites that profile file; a new name creates
   a new file. Saving also activates the profile, so the classifier uses it
   immediately.
   ════════════════════════════════════════════════════════════════════════ */
function EggFilterPane() {
  const t = useT();
  const displayInActivity = useSettingsStore((s) => s.displayInActivity);
  const setDisplayInActivity = useSettingsStore((s) => s.setDisplayInActivity);
  const [profiles, setProfiles] = useState<EggFilterProfileMeta[]>([]);
  const [active, setActive] = useState("");
  const [dir, setDir] = useState("");
  /** The profile currently loaded into the editor (may be newer than `active`). */
  const [editing, setEditing] = useState("");
  const [newName, setNewName] = useState("");
  const [content, setContent] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();

  useEffect(() => {
    void fetchEggFilter()
      .then((res) => {
        setProfiles(res.profiles);
        setActive(res.active);
        setDir(res.dir);
        setEditing(res.active);
        setContent((res.current ?? []).join("\n"));
        setLoaded(true);
        setMessage(undefined);
      })
      .catch(() => setMessage({ ok: false, text: t("failed to load profiles") }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save: same name overwrites the profile file, a new name creates one. */
  const apply = async () => {
    const trimmedName = editing.trim();
    if (!trimmedName) {
      setMessage({ ok: false, text: t("select or create a profile first") });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const names = content
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await saveEggFilter(trimmedName, names, force);
      setActive(res.active);
      setEditing(res.profile.name);
      setProfiles(await fetchEggFilter().then((r) => r.profiles));
      setMessage({ ok: true, text: t("saved & applied ✓ ({n} names)", { n: res.profile.count }) });
    } catch {
      setMessage({ ok: false, text: t("save failed") });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Create an empty profile and load it into the editor without activating it
   * (same shape as Avatar Skin's "+ new name"): the sidebar's input + button.
   */
  const create = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await saveEggFilter(trimmed, [], false);
      const res = await fetchEggFilter();
      setProfiles(res.profiles);
      setEditing(trimmed);
      setContent("");
      setNewName("");
      setMessage({ ok: true, text: t("created \"{name}\" — edit names, then Apply", { name: trimmed }) });
    } catch {
      setMessage({ ok: false, text: t("create failed") });
    } finally {
      setBusy(false);
    }
  };

  const openProfile = async (profileName: string) => {
    try {
      const res = await activateEggFilter(profileName);
      setActive(res.active);
      setContent((res.current ?? []).join("\n"));
      setMessage({ ok: true, text: t("activated \"{name}\"", { name: profileName }) });
    } catch {
      setMessage({ ok: false, text: t("activate failed") });
    }
  };

  const remove = async (profileName: string) => {
    if (!window.confirm(t("Delete profile \"{name}\"?", { name: profileName }))) return;
    try {
      await deleteEggFilter(profileName);
      const res = await fetchEggFilter();
      setProfiles(res.profiles);
      if (active === profileName) {
        setActive(res.active);
        setContent((res.current ?? []).join("\n"));
      }
      setMessage({ ok: true, text: t("deleted \"{name}\"", { name: profileName }) });
    } catch {
      setMessage({ ok: false, text: t("delete failed") });
    }
  };

  return (
    <div className="flex min-w-0 flex-1 basis-0 flex-col p-4">
      <h2 className="mb-1 font-mono text-sm tracking-widest text-desk-ink">{t("EGGS FILTER")}</h2>
      <p className="mb-3 shrink-0 text-[11px] leading-snug text-desk-dim">
        {t(
          "Command names the classifier treats as helpers, one per line. Profiles live in <dir> Create a profile with the sidebar's <+> (an empty file lands in the editor), fill it in, then Apply saves and activates it. Same name overwrites.",
        )
          .replace("<dir>", "")
          .replace("<+>", "+")}
        <span className="mx-1 break-all font-mono text-[10px] text-desk-ink/70">{dir || "…"}</span>
      </p>

      {/* The profile list + editor scroll; the header above and the toggles +
          Apply row below stay put — same three-band layout as Avatar Skin. */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Sidebar: saved profiles + new-profile input, like Avatar Skin's. */}
        <div className="flex w-32 shrink-0 flex-col">
          <p className="mb-1 shrink-0 font-mono text-[10px] uppercase tracking-wide text-desk-dim">{t("saved")}</p>
          <ul className="mb-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            {!loaded ? (
              <li className="font-mono text-[10px] text-desk-dim/70">{t("loading…")}</li>
            ) : profiles.length === 0 ? (
              <li className="font-mono text-[10px] text-desk-dim/70">{t("none yet")}</li>
            ) : (
              profiles.map((p) => (
                <li key={p.name} className="group flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void openProfile(p.name)}
                    title={`${p.count} names · saved ${new Date(p.savedAt).toLocaleString()}`}
                    className={[
                      "min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left font-mono text-[10px]",
                      editing === p.name
                        ? "bg-desk-amber/15 text-desk-amber"
                        : "text-desk-dim hover:bg-desk-amber/10 hover:text-desk-amber",
                    ].join(" ")}
                  >
                    {p.name === active ? "● " : ""}
                    {p.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(p.name)}
                    className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim opacity-0 hover:text-desk-ember group-hover:opacity-100"
                    title={`✕ ${p.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className="flex shrink-0 gap-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
              placeholder={t("new name")}
              className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
            />
            <button
              type="button"
              disabled={busy || !newName.trim()}
              onClick={() => void create()}
              className="shrink-0 rounded border border-desk-line px-1.5 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
              title={t("Create an empty profile and load it into the editor")}
            >
              +
            </button>
          </div>
        </div>

        {/* Editor: the profile being edited (chosen in the sidebar), then the
            whole rest of the band goes to the content. The name lives with the
            sidebar selection; there is no separate name field. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <p className="mb-1 shrink-0 font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            {t("editing:")} <span className="text-desk-amber">{editing || "—"}</span>
          </p>
          <label className="mb-1 shrink-0 font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            {t("content (one command name per line)")}
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder={"conhost\nsleep\ntail"}
            className="min-h-0 w-full flex-1 resize-none rounded border border-desk-line bg-desk-panel2 px-2 py-1 font-mono text-[11px] leading-snug text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
          />
        </div>
      </div>

      {/* Bottom band: the two toggles compressed onto one line, then Apply —
          so the content textarea above keeps as much height as possible. */}
      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1">
        <label
          className="flex items-center gap-1.5 text-[11px] text-desk-dim"
          title={t(
            "Also filter a listed name when it is the command's declared subject (e.g. node ticker.mjs). A process that outlived its command stays visible either way.",
          )}
        >
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="accent-[rgb(var(--desk-accent))]"
          />
          <span className="font-mono text-[10px] uppercase tracking-wide text-desk-ink">{t("force")}</span>
          <span className="hidden text-[10px] xl:inline">
            {" — "}
            {t("also filter a listed name when it is the command's declared subject")}
          </span>
        </label>
        <label
          className="flex items-center gap-1.5 text-[11px] text-desk-dim"
          title={t(
            "Show LAID / DIED process events in the Activity panel. Off hides them so the panel reads as actions only; the eggs stay visible in the Agent Eggs panel either way.",
          )}
        >
          <input
            type="checkbox"
            checked={displayInActivity}
            onChange={(e) => setDisplayInActivity(e.target.checked)}
            className="accent-[rgb(var(--desk-accent))]"
          />
          <span className="font-mono text-[10px] uppercase tracking-wide text-desk-ink">
            {t("display in activity")}
          </span>
          <span className="hidden text-[10px] 2xl:inline">{" — "}{t("show LAID / DIED process events in Activity")}</span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          {message ? (
            <span
              className={["font-mono text-[10px]", message.ok ? "text-desk-teal" : "text-desk-ember"].join(" ")}
            >
              {message.text}
            </span>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void apply()}
            className="rounded border border-desk-amber/60 bg-desk-amber/10 px-3 py-1 font-mono text-[11px] text-desk-amber transition-colors hover:bg-desk-amber/20 disabled:cursor-not-allowed disabled:opacity-40"
            title={t("Save the profile (overwrite if the name exists, create otherwise) and activate it")}
          >
            {busy ? t("saving…") : t("Apply")}
          </button>
        </div>
      </div>
    </div>
  );
}
