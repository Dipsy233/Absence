import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import {
  activateAvatarSkin,
  createAvatarSkin,
  deleteAvatarSkin,
  deleteAvatarSkinFile,
  fetchAvatarSkins,
  uploadAvatarSkinFile,
  type AvatarSkinMeta,
} from "../../lib/api";

const STATUSES = [
  "default", "listening", "thinking", "speaking", "reading",
  "searching", "editing", "running", "waiting", "error",
];

const MEDIA_RE = /\.(png|gif|jpe?g|webp|svg|mp4|webm|mov)$/i;

/**
 * The avatar-skin manager (the left half of the Settings dialog).
 *
 *   sidebar — skins; click a name to load it, ✕ to delete the folder
 *   main    — one row per status: upload a file (mp4/gif/png/webp…) and it
 *             becomes that status's animation; ✕ clears the status
 *   bottom  — Apply activates the loaded skin (WhaleBun = builtin character)
 *
 * No URLs: the user picks a status and uploads a file. Files land in
 * <server>/avatar-skins/<skin name>/<status>.<ext>.
 */
export function AvatarSkinPane() {
  const t = useT();
  const [skins, setSkins] = useState<AvatarSkinMeta[]>([]);
  const [active, setActive] = useState("");
  const [builtin, setBuiltin] = useState("WhaleBun");
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<Partial<Record<string, string>>>({});
  const [loadedName, setLoadedName] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>();
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingStatus = useRef<string | null>(null);

  const load = () =>
    fetchAvatarSkins()
      .then((res) => {
        setSkins(res.skins);
        setActive(res.active);
        setBuiltin(res.builtin);
        setDir(res.dir);
        // Follow the active skin on background refreshes, but never clobber
        // what the user is currently editing if it is a different skin.
        setLoadedName((prev) => prev || res.active || res.builtin);
        setFiles((prev) => {
          if (loadedName === res.active) return res.activeFiles ?? {};
          if (loadedName && loadedName !== res.builtin) {
            const own = res.skins.find((s) => s.name === loadedName)?.files;
            if (own) return own;
          }
          return prev;
        });
        setMessage(undefined);
      })
      .catch(() => setMessage({ ok: false, text: t("failed to load skins") }));

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      await createAvatarSkin(name);
      await load();
      // Newly created folders are not active yet; load it into the editor.
      await activateIntoEditor(name);
      setNewName("");
      setMessage({ ok: true, text: t('created "{name}" — upload files below', { name }) });
    } catch {
      setMessage({ ok: false, text: t("create failed") });
    } finally {
      setBusy(false);
    }
  };

  /** Load a skin's files into the editor without switching the active one. */
  const activateIntoEditor = async (name: string) => {
    const res = await fetchAvatarSkins();
    setSkins(res.skins);
    setDir(res.dir);
    setLoadedName(name);
    // Only the *active* skin reports activeFiles; any other skin (including
    // the builtin) reads its own folder, so switching never shows leftovers.
    setFiles(
      name === res.active
        ? res.activeFiles ?? {}
        : res.skins.find((s) => s.name === name)?.files ?? {},
    );
  };

  const apply = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const res = await activateAvatarSkin(loadedName === builtin ? "" : loadedName);
      setActive(res.active);
      setMessage({
        ok: true,
        text: res.active ? t('applied "{name}" ✓', { name: res.active }) : t("restored {name} ✓", { name: builtin }),
      });
    } catch {
      setMessage({ ok: false, text: t("apply failed") });
    } finally {
      setBusy(false);
    }
  };

  const pickUpload = (status: string) => {
    pendingStatus.current = status;
    fileInput.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const status = pendingStatus.current;
    pendingStatus.current = null;
    if (!file || !status) return;
    if (!MEDIA_RE.test(file.name)) {
      setMessage({ ok: false, text: t("unsupported file type (use png/gif/jpg/webp/svg/mp4/webm/mov)") });
      return;
    }
    setUploading(status);
    setMessage(undefined);
    try {
      // Ensure the skin folder exists (uploading into the builtin name creates a real folder).
      const target = loadedName === builtin ? await promptNewName() : loadedName;
      if (!target) return;
      await uploadAvatarSkinFile(target, status, file);
      // The upload activates nothing; switch the editor to the skin just touched.
      const res = await fetchAvatarSkins();
      setSkins(res.skins);
      setLoadedName(target);
      setFiles(res.skins.find((s) => s.name === target)?.files ?? {});
      setMessage({ ok: true, text: `${status} ← ${file.name}` });
    } catch {
      setMessage({ ok: false, text: t("upload failed") });
    } finally {
      setUploading(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  /** Uploading "into WhaleBun" really creates a new skin folder named after it. */
  const promptNewName = async (): Promise<string> => {
    const name = window.prompt(t("A name for the new skin (files go into <avatar-skins>/<name>/):"), "MyAvatar");
    if (!name?.trim()) return "";
    await createAvatarSkin(name.trim());
    return name.trim();
  };

  const clearStatus = async (status: string) => {
    if (loadedName === builtin) return; // nothing stored for the builtin
    try {
      await deleteAvatarSkinFile(loadedName, status);
      const res = await fetchAvatarSkins();
      setFiles(res.skins.find((s) => s.name === loadedName)?.files ?? {});
      setMessage({ ok: true, text: t("cleared {event}", { event: status }) });
    } catch {
      setMessage({ ok: false, text: t("clear failed") });
    }
  };

  const removeSkin = async (name: string) => {
    if (!window.confirm(t('Delete skin "{name}" and its files?', { name }))) return;
    try {
      await deleteAvatarSkin(name);
      await load();
      setMessage({ ok: true, text: t('deleted "{name}"', { name }) });
    } catch {
      setMessage({ ok: false, text: t("delete failed") });
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-1 basis-0 flex-col p-4">
      <h2 className="mb-1 font-mono text-sm tracking-widest text-desk-ink">{t("AVATAR SKIN")}</h2>
      <p className="mb-3 shrink-0 text-[11px] leading-snug text-desk-dim">
        {t("Pick a status, upload a file (mp4 / gif / png / webp / svg) and it becomes that status's animation. Files are stored in")}
        <span className="mx-1 break-all font-mono text-[10px] text-desk-ink/70">{dir || "…"}</span>
      </p>

      {/* The status list scrolls; the header above and the Apply row below stay put. */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* Sidebar: skins + new-skin input. */}
        <div className="flex w-36 shrink-0 flex-col">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">{t("skins")}</p>
          <ul className="mb-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
            <li>
              <button
                type="button"
                onClick={() => void activateIntoEditor(builtin)}
                className={[
                  "w-full truncate rounded px-1.5 py-0.5 text-left font-mono text-[10px]",
                  loadedName === builtin
                    ? "bg-desk-amber/15 text-desk-amber"
                    : "text-desk-dim hover:bg-desk-amber/10 hover:text-desk-amber",
                ].join(" ")}
                title={t("The built-in HTML character")}
              >
                {active === "" ? "● " : ""}
                {builtin}
              </button>
            </li>
            {skins.map((s) => (
              <li key={s.name} className="group flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => void activateIntoEditor(s.name)}
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
                  onClick={() => void removeSkin(s.name)}
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
              title={t("Create a skin folder")}
            >
              +
            </button>
          </div>
        </div>

        {/* Main: one upload row per status. Scrollable so the Apply button below
            is never pushed out of view by a tall list. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            {t("editing:")} <span className="text-desk-amber">{loadedName}</span>
          </p>
          <ul className="space-y-0.5">
            {STATUSES.map((status) => {
              const file = files[status];
              return (
                <li key={status} className="flex items-center gap-1.5 rounded border border-desk-line bg-desk-panel2 px-2 py-1">
                  <span className="w-20 shrink-0 font-mono text-[10px] text-desk-ink">{t(status)}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-desk-dim" title={file}>
                    {uploading === status ? t("uploading…") : (file ?? "—")}
                  </span>
                  {file ? (
                    <button
                      type="button"
                      onClick={() => void clearStatus(status)}
                      className="shrink-0 rounded px-1 font-mono text-[10px] text-desk-dim hover:text-desk-ember"
                      title={t("Clear {event}", { event: status })}
                    >
                      ✕
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={uploading !== null}
                    onClick={() => pickUpload(status)}
                    className="shrink-0 rounded border border-desk-line px-1.5 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
                    title={t("Upload a file for {event}", { event: status })}
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
        accept=".png,.gif,.jpg,.jpeg,.webp,.svg,.mp4,.webm,.mov"
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
          title={t('Use "{name}" as the agent’s avatar', { name: loadedName })}
        >
          {busy ? t("applying…") : t("Apply")}
        </button>
      </div>
    </div>
  );
}
