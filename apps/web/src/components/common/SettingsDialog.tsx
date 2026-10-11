import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { THEMES, type ThemeId } from "../../lib/theme";
import { useSettingsStore, type LeftPanelId, type RailPanelId } from "../../stores/settingsStore";
import { AvatarSkinPane } from "./AvatarSkinPane";
import { SoundPane } from "./SoundPane";
import {
  activateEggFilter,
  deleteEggFilter,
  fetchEggFilter,
  saveEggFilter,
  type EggFilterProfileMeta,
} from "../../lib/api";

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

/**
 * The Settings dialog, opened from the gear button in the session bar. Split
 * into two halves:
 *
 *   left   — appearance & layout (theme, rail orders) (see AppearancePane)
 *   middle — avatar skin: upload animation files per status (see AvatarSkinPane)
 *   middle — sound sets: upload chimes per event (see SoundPane)
 *   right  — Agent Eggs filter profiles: a small file manager over the server's
 *            profile directory (name on top, content below, saved files in a
 *            sidebar; same name overwrites, a new name creates a file)
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
      <div className="flex max-h-[85vh] w-[1500px] max-w-[96vw] overflow-hidden rounded-lg border border-desk-line bg-desk-panel shadow-[0_8px_40px_rgba(0,0,0,.5)]">
        {/* ════ Left: appearance & layout ═══════════════════ */}
        <AppearancePane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Avatar skin: upload animations per status ═══ */}
        <AvatarSkinPane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Sound sets: upload chimes per event ═════════ */}
        <SoundPane />

        <div className="w-px shrink-0 bg-desk-line" />

        {/* ════ Right: egg filter profiles ══════════════════ */}
        <EggFilterPane />
      </div>
    </div>,
    document.body,
  );
}

/* ════════════════════════════════════════════════════════════════════════
   Appearance & layout (the left pane): theme and the two rails' panel order.
   Same sections the dialog had when it was a single column.
   ════════════════════════════════════════════════════════════════════════ */
function AppearancePane() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const railOrder = useSettingsStore((s) => s.railOrder);
  const moveRailPanel = useSettingsStore((s) => s.moveRailPanel);
  const leftOrder = useSettingsStore((s) => s.leftOrder);
  const moveLeftPanel = useSettingsStore((s) => s.moveLeftPanel);

  return (
    <div className="min-w-0 flex-1 basis-0 overflow-y-auto p-4">
      <h2 className="mb-3 font-mono text-sm tracking-widest text-desk-ink">APPEARANCE</h2>

      {/* ── Theme ──────────────────────────────────────────── */}
      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">Color theme</h3>
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

      {/* ── Left rail order ──────────────────────────────── */}
      <section className="mb-4">
        <h3 className="mb-1.5 font-mono text-[11px] uppercase tracking-wide text-desk-dim">
          Left rail panel order
        </h3>
        <ul className="space-y-1">
          {leftOrder.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
              <span className="flex-1 font-mono text-[11px] text-desk-ink">
                {i + 1}. {LEFT_LABELS[id]}
              </span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveLeftPanel(id, "up")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === leftOrder.length - 1}
                onClick={() => moveLeftPanel(id, "down")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title="Move down"
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
          Right rail panel order
        </h3>
        <ul className="space-y-1">
          {railOrder.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
              <span className="flex-1 font-mono text-[11px] text-desk-ink">
                {i + 1}. {RAIL_LABELS[id]}
              </span>
              <button
                type="button"
                disabled={i === 0}
                onClick={() => moveRailPanel(id, "up")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title="Move up"
              >
                ▲
              </button>
              <button
                type="button"
                disabled={i === railOrder.length - 1}
                onClick={() => moveRailPanel(id, "down")}
                className="rounded px-1 font-mono text-[11px] text-desk-dim hover:text-desk-amber disabled:opacity-30"
                title="Move down"
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
  const [profiles, setProfiles] = useState<EggFilterProfileMeta[]>([]);
  const [active, setActive] = useState("");
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
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
        setName(res.active);
        setContent((res.current ?? []).join("\n"));
        setLoaded(true);
        setMessage(undefined);
      })
      .catch(() => setMessage({ ok: false, text: "failed to load profiles" }));
  }, []);

  /** Save: same name overwrites the profile file, a new name creates one. */
  const apply = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setMessage({ ok: false, text: "file name is required" });
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
      setProfiles(await fetchEggFilter().then((r) => r.profiles));
      setMessage({ ok: true, text: `saved & applied ✓ (${res.profile.count} names)` });
    } catch {
      setMessage({ ok: false, text: "save failed" });
    } finally {
      setBusy(false);
    }
  };

  const openProfile = async (profileName: string) => {
    try {
      const res = await activateEggFilter(profileName);
      setActive(res.active);
      setName(profileName);
      setContent((res.current ?? []).join("\n"));
      setMessage({ ok: true, text: `activated "${profileName}"` });
    } catch {
      setMessage({ ok: false, text: "activate failed" });
    }
  };

  const remove = async (profileName: string) => {
    if (!window.confirm(`Delete profile "${profileName}"?`)) return;
    try {
      await deleteEggFilter(profileName);
      const res = await fetchEggFilter();
      setProfiles(res.profiles);
      if (active === profileName) {
        setActive(res.active);
        setName(res.active);
        setContent((res.current ?? []).join("\n"));
      }
      setMessage({ ok: true, text: `deleted "${profileName}"` });
    } catch {
      setMessage({ ok: false, text: "delete failed" });
    }
  };

  return (
    <div className="min-w-0 flex-1 basis-0 overflow-y-auto p-4">
      <h2 className="mb-1 font-mono text-sm tracking-widest text-desk-ink">EGGS FILTER</h2>
      <p className="mb-3 text-[11px] leading-snug text-desk-dim">
        Command names the classifier treats as helpers, one per line. Profiles live in
        <span className="mx-1 break-all font-mono text-[10px] text-desk-ink/70">{dir || "…"}</span>
        Same name saves over the file; a new name creates one. Saving activates it at once.
      </p>

      <div className="flex min-h-0 flex-1 gap-2">
        {/* Sidebar: saved profiles, newest first. */}
        <div className="w-32 shrink-0">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">saved</p>
          <ul className="max-h-52 space-y-0.5 overflow-y-auto">
            {!loaded ? (
              <li className="font-mono text-[10px] text-desk-dim/70">loading…</li>
            ) : profiles.length === 0 ? (
              <li className="font-mono text-[10px] text-desk-dim/70">none yet</li>
            ) : (
              profiles.map((p) => (
                <li key={p.name} className="group flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => void openProfile(p.name)}
                    title={`${p.count} names · saved ${new Date(p.savedAt).toLocaleString()}`}
                    className={[
                      "min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left font-mono text-[10px]",
                      p.name === active
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
                    title={`Delete ${p.name}`}
                  >
                    ✕
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>

        {/* Editor: file name on top, content below. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <label className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">file name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            placeholder="my-helpers"
            className="mb-2 w-full rounded border border-desk-line bg-desk-panel2 px-2 py-1 font-mono text-[11px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
          />
          <label className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            content (one command name per line)
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            rows={10}
            placeholder={"conhost\nsleep\ntail"}
            className="min-h-32 w-full flex-1 resize-y rounded border border-desk-line bg-desk-panel2 px-2 py-1 font-mono text-[11px] leading-snug text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
          />
        </div>
      </div>

      <label className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-desk-dim">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
          className="mt-0.5 accent-[rgb(var(--desk-accent))]"
        />
        <span>
          <span className="font-mono text-[10px] uppercase tracking-wide text-desk-ink">force</span>
          {" — also filter a listed name when it is the command's declared subject (e.g. "}
          <span className="font-mono">node ticker.mjs</span>
          {"). A process that outlived its command stays visible either way."}
        </span>
      </label>

      <div className="mt-2 flex items-center justify-end gap-2">
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
          title="Save the profile (overwrite if the name exists, create otherwise) and activate it"
        >
          {busy ? "saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
