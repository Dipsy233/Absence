import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useViewModeStore } from "../../stores/viewModeStore";
import { useT } from "../../lib/i18n";
import { DripUI } from "./DripUI";
import "./drip.css";

/**
 * The browser build of Drip.
 *
 * A tab cannot keep a widget on top of the other tabs, but a Document
 * Picture-in-Picture window can: it is a real always-on-top window that shares
 * this document's styles and state. The face is therefore moved into a PiP
 * window and the tab itself is emptied out.
 *
 * The tab cannot literally be closed: the browser closes the PiP window along
 * with the document that opened it, so `window.close()` would take the ball
 * down with the tab. Emptying the tab is the closest a page can get.
 *
 * The window is drawn as a bar rather than a ball: a PiP window cannot be
 * circular, and it cannot be resized by a hover, so it keeps the width the pill
 * needs and grows downwards only when the card is opened. The widget is pinned
 * to the window's top-left so growing never moves the ball.
 */

/**
 * The two window sizes.
 *
 * There is no ball-sized state: `resizeTo` needs a user gesture, and a hover
 * is not one, so the window cannot grow when the pointer enters. It therefore
 * stays at the full bar — ball plus the current event — and only the click
 * (which *is* a gesture) opens the card and grows the window downwards.
 */
const BAR: [number, number] = [352, 100];
const OPENED: [number, number] = [400, 548];

interface PipApi {
  window: Window | null;
  requestWindow?: (options?: {
    width?: number;
    height?: number;
    disallowReturnToOpener?: boolean;
  }) => Promise<Window>;
}

function pipApi(): PipApi | undefined {
  return (window as unknown as { documentPictureInPicture?: PipApi }).documentPictureInPicture;
}

/**
 * One request per opening, shared by every effect run.
 *
 * React Strict Mode mounts an effect twice; two `requestWindow` calls race and
 * one of them is refused, which would leave the face in the tab instead of on
 * top of it. The promise lives at module scope so the second run simply awaits
 * the first run's window.
 */
let pipPromise: Promise<Window> | null = null;

function requestPipWindow(): Promise<Window> | null {
  const api = pipApi();
  if (!api?.requestWindow) return null;
  if (api.window) return Promise.resolve(api.window);
  if (!pipPromise) {
    pipPromise = api
      .requestWindow({ width: BAR[0], height: BAR[1], disallowReturnToOpener: true })
      .finally(() => {
        pipPromise = null;
      });
  }
  return pipPromise;
}

/**
 * Give the PiP document the app's stylesheets.
 *
 * Vite emits one `<style>` per module in dev and `<link>`s in the build; both
 * are same-origin here, so the rules can be copied verbatim. Cross-origin
 * sheets (none today) fall back to a `<link>`, which the PiP document can load
 * because it shares the opener's origin.
 */
function copyStyles(doc: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules, (rule) => rule.cssText).join("");
      const style = doc.createElement("style");
      style.textContent = css;
      doc.head.append(style);
    } catch {
      if (sheet.href) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        doc.head.append(link);
      }
    }
  }
}

export function DripPipHost() {
  const t = useT();
  const exitDrip = useViewModeStore((s) => s.exitDrip);
  const supported = pipApi() !== undefined;

  const [host, setHost] = useState<HTMLDivElement | undefined>();
  const [failed, setFailed] = useState(false);
  const winRef = useRef<Window | undefined>(undefined);
  const rootRef = useRef<Root | undefined>(undefined);

  /** Called from the pill's click, so the gesture is still live. */
  const resize = useCallback((open: boolean) => {
    const win = winRef.current;
    if (!win) return;
    const [width, height] = open ? OPENED : BAR;
    try {
      win.resizeTo(width, height);
    } catch {
      // A browser that refuses resizeTo still shows the widget, just clipped.
    }
  }, []);

  /** Open Absence: hand the tab back, which also takes the PiP window down. */
  const leave = useCallback(() => {
    const win = winRef.current;
    // Closing the window destroys the React root inside it; deferring keeps
    // that teardown out of the button's own event dispatch.
    window.setTimeout(() => {
      win?.close();
      exitDrip();
    }, 0);
  }, [exitDrip]);

  useEffect(() => {
    if (!supported) return;
    let alive = true;

    const onHide = () => {
      // The PiP document is going away: unmount React while its nodes still
      // exist, then restore the face in the tab.
      const root = rootRef.current;
      rootRef.current = undefined;
      root?.unmount();
      setHost(undefined);
      exitDrip();
    };

    void (async () => {
      const promise = requestPipWindow();
      if (!promise) return;
      let win: Window;
      try {
        win = await promise;
      } catch {
        // Pop-ups blocked or the API is not really available: keep Drip in
        // the page, which is what the browser build did before PiP.
        if (alive) setFailed(true);
        return;
      }
      // Strict Mode ran this effect twice; the second run owns the window.
      if (!alive) return;

      winRef.current = win;
      copyStyles(win.document);
      // Without a title the PiP window's title bar shows the page's origin
      // ("localhost:5173"); the app's own name replaces it.
      win.document.title = document.title || "Absence";
      win.document.documentElement.style.height = "100%";
      win.document.body.style.cssText = "margin:0;height:100%;overflow:hidden;background:#121212";
      const el = win.document.createElement("div");
      el.style.height = "100%";
      win.document.body.append(el);
      win.addEventListener("pagehide", onHide);
      setHost(el);
    })();

    return () => {
      alive = false;
    };
  }, [supported, exitDrip]);

  useEffect(() => {
    if (!host) return;
    const root = createRoot(host);
    rootRef.current = root;
    root.render(<DripUI pip onOpenAbsence={leave} onExpand={resize} />);
    return () => {
      // `onHide` may already have unmounted this root while the PiP document
      // was going away; unmounting twice would throw.
      if (rootRef.current === root) {
        rootRef.current = undefined;
        root.unmount();
      }
    };
  }, [host, leave, resize]);

  if (!supported || failed) return <DripUI />;

  return (
    <div className="drip-away">
      <p>{t("Drip is floating outside this tab.")}</p>
      <button type="button" onClick={leave}>
        {t("Bring it back")}
      </button>
    </div>
  );
}
