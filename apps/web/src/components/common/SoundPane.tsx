import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  activateSoundSet,
  createSoundSet,
  deleteSoundSet,
  deleteSoundFile,
  fetchSounds,
  uploadSoundFile,
  type SoundSetMeta,
} from "../../lib/api";

/** The events the app rings a chime for (see lib/sounds.ts).
 *
 *  `attention` takes two level-specific files: `attention-medium` and
 *  `attention-high`. Upload either (or both); a level without its own file
 *  falls back to the other level's file, then to the synthesised tone.
 */
const EVENTS = ["attention-medium", "attention-high", "complete", "approval"] as const;

const EVENT_LABELS: Record<string, string> = {
  "attention-medium": "attention · med",
  "attention-high": "attention · high",
};

const AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|mp4)$/i;

/** Which events ring, and how loudly — independent of which set is active. */
function ChimeSwitches() {
  const t = useT();
  const soundEnabled = useSettingsStore((s) => s.soundEnabled);
  const setSoundEnabled = useSettingsStore((s) => s.setSoundEnabled);
  const volume = useSettingsStore((s) => s.soundVolume);
  const setVolume = useSettingsStore((s) => s.setSoundVolume);
  const lowAttention = useSettingsStore((s) => s.soundLowAttention);
  const setLowAttention = useSettingsStore((s) => s.setSoundLowAttention);
  const complete = useSettingsStore((s) => s.soundComplete);
  const setComplete = useSettingsStore((s) => s.setSoundComplete);
  const approval = useSettingsStore((s) => s.soundApproval);
  const setApproval = useSettingsStore((s) => s.setSoundApproval);

  const box = "accent-[rgb(var(--desk-accent))]";
  const off = soundEnabled ? "" : " opacity-40";

  return (
    <div className="mt-2 shrink-0 rounded border border-desk-line/70 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1.5 text-[11px] text-desk-dim">
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={(e) => setSoundEnabled(e.target.checked)}
            className={box}
          />
          <span className="font-mono text-[10px] uppercase tracking-wide text-desk-ink">{t("chimes")}</span>
        </label>
        <label className={`flex items-center gap-1.5 text-[11px] text-desk-dim${off}`}>
          <span className="font-mono text-[10px] uppercase tracking-wide">{t("volume")}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            disabled={!soundEnabled}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-24 accent-[rgb(var(--desk-accent))]"
            title={t("Chime volume")}
          />
          <span className="w-8 shrink-0 text-right font-mono text-[10px] text-desk-dim">{volume}</span>
        </label>
      </div>
      <div className={`mt-1 flex flex-wrap items-center gap-x-3 gap-y-1${off}`}>
        <Switch label={t("run finished")} checked={complete} disabled={!soundEnabled} onChange={setComplete} />
        <Switch label={t("approval waiting")} checked={approval} disabled={!soundEnabled} onChange={setApproval} />
        <Switch
          label={t("also at low")}
          title={t("Low is where most runs sit for harmless reasons, so a step into low is silent by default.")}
          checked={lowAttention}
          disabled={!soundEnabled}
          onChange={setLowAttention}
        />
      </div>
    </div>
  );
}

function Switch({
  label,
  title,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  title?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[11px] text-desk-dim" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[rgb(var(--desk-accent))] disabled:opacity-40"
      />
      <span className="font-mono text-[10px] uppercase tracking-wide text-desk-ink">{label}</span>
    </label>
  );
}

/**
 * The sound-set manager (a pane of the Settings dialog), shaped like the
 * avatar-skin manager next to it.
 *
 *   sidebar — sound sets; click a name to load it, ✕ to delete the folder
 *   main    — one row per event: upload an audio file and it becomes that
 *             event's chime; ▶ previews it, ✕ clears it back to the synth tone
 *   bottom  — Apply activates the loaded set (Default = synthesised chimes)
 *
 * No URLs: the user picks an event and uploads a file. Files land in
 * <server>/sound-sets/<set name>/<event>.<ext>.
 */
export function SoundPane() {
  const t = useT();
  const [sets, setSets] = useState<SoundSetMeta[]>([]);
  const [active, setActive] = useState("");
  const [builtin, setBuiltin] = useState("Default");
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<Partial<Record<string, string>>>({});
  const [loadedName, setLoadedName] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingEvent = useRef<string | null>(null);

  const load = () =>
    fetchSounds()
      .then((res) => {
        setSets(res.sets);
        setActive(res.active);
        setBuiltin(res.builtin);
        setDir(res.dir);
        setLoadedName((prev) => prev || res.active || res.builtin);
        setFiles((prev) => {
          if (loadedName === res.active) return res.activeFiles ?? {};
          if (loadedName && loadedName !== res.builtin) {
            const own = res.sets.find((s) => s.name === loadedName)?.files;
            if (own) return own;
          }
          return prev;
        });
        setMessage(undefined);
      })
      .catch(() => setMessage({ ok: false, text: t("failed to load sound sets") }));

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createSoundSet(name);
      await load();
      await loadIntoEditor(name);
      setNewName("");
      setMessage({ ok: true, text: t('created "{name}" — upload files below', { name }) });
    } catch {
      setMessage({ ok: false, text: t("create failed") });
    } finally {
      setBusy(false);
    }
  };

  /** Load a set's files into the editor without switching the active one. */
  const loadIntoEditor = async (name: string) => {
    const res = await fetchSounds();
    setSets(res.sets);
    setDir(res.dir);
    setLoadedName(name);
    setFiles(
      name === res.active ? res.activeFiles ?? {} : res.sets.find((s) => s.name === name)?.files ?? {},
    );
  };

  const apply = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const res = await activateSoundSet(loadedName === builtin ? "" : loadedName);
      setActive(res.active);
      setMessage({
        ok: true,
        text: res.active ? t('applied "{name}" ✓', { name: res.active }) : t("restored the default chimes ✓"),
      });
    } catch {
      setMessage({ ok: false, text: t("apply failed") });
    } finally {
      setBusy(false);
    }
  };

  const pickUpload = (event: string) => {
    pendingEvent.current = event;
    fileInput.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const event = pendingEvent.current;
    pendingEvent.current = null;
    if (!file || !event) return;
    if (!AUDIO_RE.test(file.name)) {
      setMessage({ ok: false, text: t("unsupported file type (use mp3/wav/ogg/m4a/flac/webm)") });
      return;
    }
    setUploading(event);
    setMessage(undefined);
    try {
      // Ensure the set folder exists (uploading into Default creates a real folder).
      const target = loadedName === builtin ? await promptNewName() : loadedName;
      if (!target) return;
      await uploadSoundFile(target, event, file);
      const res = await fetchSounds();
      setSets(res.sets);
      setLoadedName(target);
      setFiles(res.sets.find((s) => s.name === target)?.files ?? {});
      setMessage({ ok: true, text: `${event} ← ${file.name}` });
    } catch {
      setMessage({ ok: false, text: t("upload failed") });
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  /** Uploading "into Default" really creates a new set folder named after it. */
  const promptNewName = async (): Promise<string> => {
    const name = window.prompt(t("A name for the new sound set (files go into <sound-sets>/<name>/):"), "MyChimes");
    if (!name?.trim()) return "";
    await createSoundSet(name.trim());
    return name.trim();
  };

  const clearEvent = async (event: string) => {
    if (loadedName === builtin) return; // nothing stored for the builtin
    try {
      await deleteSoundFile(loadedName, event);
      const res = await fetchSounds();
      setFiles(res.sets.find((s) => s.name === loadedName)?.files ?? {});
      setMessage({ ok: true, text: t("cleared {event}", { event }) });
    } catch {
      setMessage({ ok: false, text: t("clear failed") });
    }
  };

  /** Preview a row: the uploaded file for this set, or the synthesised tone. */
  const preview = (event: string) => {
    const file = files[event];
    if (file && loadedName !== builtin) {
      // Audition the loaded set's file directly (?set=), so an unapplied set
      // can be heard before Apply.
      const el = new Audio(
        `/sound/${event}?set=${encodeURIComponent(loadedName)}&p=${Date.now()}`,
      );
      void el.play().catch(() => setMessage({ ok: false, text: t("preview failed (unsupported audio?)") }));
    } else {
      setMessage({ ok: false, text: t("no custom file — the default chime rings") });
    }
  };

  const removeSet = async (name: string) => {
    if (!window.confirm(t('Delete sound set "{name}" and its files?', { name }))) return;
    try {
      await deleteSoundSet(name);
      await load();
      setMessage({ ok: true, text: t('deleted "{name}"', { name }) });
    } catch {
      setMessage({ ok: false, text: t("delete failed") });
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 basis-0 flex-col p-4">
      <h2 className="mb-1 font-mono text-sm tracking-widest text-desk-ink">{t("SOUND SETS")}</h2>
      <p className="mb-3 shrink-0 text-[11px] leading-snug text-desk-dim">
        {t("Pick an event, upload an audio file (mp3 / wav / ogg / m4a) and it replaces that chime. Events without a file keep the built-in tone. Files are stored in")}
        <span className="mx-1 break-all font-mono text-[10px] text-desk-ink/70">{dir || "…"}</span>
      </p>

      {/* The event list scrolls; the header above and the Apply row below stay put. */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Sidebar: sound sets + new-set input. */}
        <div className="flex w-32 shrink-0 flex-col">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">{t("sets")}</p>
          <ul className="mb-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => void loadIntoEditor(builtin)}
                className={[
                  "w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[10px]",
                  loadedName === builtin
                    ? "bg-desk-amber/15 text-desk-amber"
                    : "text-desk-dim hover:bg-desk-amber/10 hover:text-desk-amber",
                ].join(" ")}
                title={t("The built-in synthesised chimes")}
              >
                {active === "" ? "● " : ""}
                {builtin}
              </button>
            </li>
            {sets.map((s) => (
              <li key={s.name} className="group flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void loadIntoEditor(s.name)}
                  title={`${Object.keys(s.files).length} files${s.complete ? " · complete" : ""}`}
                  className={[
                    "min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-left font-mono text-[10px]",
                    loadedName === s.name
                      ? "bg-desk-amber/15 text-desk-amber"
                      : "text-desk-dim hover:bg-desk-amber/10 hover:text-desk-amber",
                  ].join(" ")}
                >
                  {active === s.name ? "● " : ""}
                  {s.name}
                </button>
                <button
                  type="button"
                  onClick={() => void removeSet(s.name)}
                  className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim opacity-0 hover:text-desk-ember group-hover:opacity-100"
                  title={`Delete ${s.name}`}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
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
              title={t("Create a sound-set folder")}
            >
              +
            </button>
          </div>
        </div>

        {/* Main: one upload row per event. Scrollable so the Apply button below
            is never pushed out of view. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            {t("editing:")} <span className="text-desk-amber">{loadedName}</span>
          </p>
          <ul className="space-y-0.5">
            {EVENTS.map((event) => {
              const file = files[event];
              return (
                <li key={event} className="flex items-center gap-1.5 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
                  <span className="w-16 shrink-0 font-mono text-[10px] text-desk-ink">
                    {t(EVENT_LABELS[event] ?? event)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-desk-dim" title={file}>
                    {uploading === event ? t("uploading…") : (file ?? "—")}
                  </span>
                  {file ? (
                    <>
                      <button
                        type="button"
                        onClick={() => preview(event)}
                        className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim hover:text-desk-amber"
                        title={t("Preview {event}", { event })}
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        onClick={() => void clearEvent(event)}
                        className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim hover:text-desk-ember"
                        title={t("Clear {event}", { event })}
                      >
                        ✕
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    disabled={uploading !== null}
                    onClick={() => pickUpload(event)}
                    className="shrink-0 rounded border border-desk-line px-1.5 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
                    title={t("Upload a file for {event}", { event })}
                  >
                    {t("upload")}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.webm,.mp4"
        className="hidden"
        onChange={(e) => void onFileChosen(e.target.files?.[0])}
      />

      <ChimeSwitches />

      <div className="mt-3 flex shrink-0 items-center justify-end gap-2">
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
          title={t('Use "{name}" as the app’s chimes', { name: loadedName })}
        >
          {busy ? t("applying…") : t("Apply")}
        </button>
      </div>
    </div>
  );
}
