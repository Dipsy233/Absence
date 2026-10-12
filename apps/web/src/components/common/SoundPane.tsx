import { useEffect, useRef, useState } from "react";
import {
  activateSoundSet,
  createSoundSet,
  deleteSoundSet,
  deleteSoundFile,
  fetchSounds,
  uploadSoundFile,
  type SoundSetMeta,
} from "../../lib/api";

/** The events the app rings a chime for (see lib/sounds.ts). */
const EVENTS = ["attention", "complete", "approval"] as const;

const AUDIO_RE = /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|mp4)$/i;

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
      .catch(() => setMessage({ ok: false, text: "failed to load sound sets" }));

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
      setMessage({ ok: true, text: `created "${name}" — upload files below` });
    } catch {
      setMessage({ ok: false, text: "create failed" });
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
        text: res.active ? `applied "${res.active}" ✓` : `restored the default chimes ✓`,
      });
    } catch {
      setMessage({ ok: false, text: "apply failed" });
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
      setMessage({ ok: false, text: "unsupported file type (use mp3/wav/ogg/m4a/flac/webm)" });
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
      setMessage({ ok: false, text: "upload failed" });
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  /** Uploading "into Default" really creates a new set folder named after it. */
  const promptNewName = async (): Promise<string> => {
    const name = window.prompt(`A name for the new sound set (files go into <sound-sets>/<name>/):`, "MyChimes");
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
      setMessage({ ok: true, text: `cleared ${event}` });
    } catch {
      setMessage({ ok: false, text: "clear failed" });
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
      void el.play().catch(() => setMessage({ ok: false, text: "preview failed (unsupported audio?)" }));
    } else {
      setMessage({ ok: false, text: "no custom file — the default chime rings" });
    }
  };

  const removeSet = async (name: string) => {
    if (!window.confirm(`Delete sound set "${name}" and its files?`)) return;
    try {
      await deleteSoundSet(name);
      await load();
      setMessage({ ok: true, text: `deleted "${name}"` });
    } catch {
      setMessage({ ok: false, text: "delete failed" });
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 basis-0 flex-col p-4">
      <h2 className="mb-1 font-mono text-sm tracking-widest text-desk-ink">SOUND SETS</h2>
      <p className="mb-3 shrink-0 text-[11px] leading-snug text-desk-dim">
        Pick an event, upload an audio file (mp3 / wav / ogg / m4a) and it replaces that chime.
        Events without a file keep the built-in tone. Files are stored in
        <span className="mx-1 break-all font-mono text-[10px] text-desk-ink/70">{dir || "…"}</span>
      </p>

      {/* The event list scrolls; the header above and the Apply row below stay put. */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Sidebar: sound sets + new-set input. */}
        <div className="flex w-32 shrink-0 flex-col">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">sets</p>
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
                title="The built-in synthesised chimes"
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
              placeholder="new name"
              className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-1.5 py-1 font-mono text-[10px] text-desk-ink placeholder:text-desk-dim/60 focus:border-desk-amber/60 focus:outline-none"
            />
            <button
              type="button"
              disabled={busy || !newName.trim()}
              onClick={() => void create()}
              className="shrink-0 rounded border border-desk-line px-1.5 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
              title="Create a sound-set folder"
            >
              +
            </button>
          </div>
        </div>

        {/* Main: one upload row per event. Scrollable so the Apply button below
            is never pushed out of view. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            editing: <span className="text-desk-amber">{loadedName}</span>
          </p>
          <ul className="space-y-0.5">
            {EVENTS.map((event) => {
              const file = files[event];
              return (
                <li key={event} className="flex items-center gap-1.5 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
                  <span className="w-16 shrink-0 font-mono text-[10px] text-desk-ink">{event}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-desk-dim" title={file}>
                    {uploading === event ? "uploading…" : file ?? "—"}
                  </span>
                  {file ? (
                    <>
                      <button
                        type="button"
                        onClick={() => preview(event)}
                        className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim hover:text-desk-amber"
                        title={`Preview ${event}`}
                      >
                        ▶
                      </button>
                      <button
                        type="button"
                        onClick={() => void clearEvent(event)}
                        className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim hover:text-desk-ember"
                        title={`Clear ${event}`}
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
                    title={`Upload a file for ${event}`}
                  >
                    upload
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
          title={`Use "${loadedName}" as the app's chimes`}
        >
          {busy ? "applying…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
