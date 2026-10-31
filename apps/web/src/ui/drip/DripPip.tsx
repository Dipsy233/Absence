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
 * At rest the window is exactly the ball. A hover cannot resize a PiP window
 * (`resizeTo` needs a click's gesture), so the sentence only appears once the
 * card is opened and the window has grown; closing returns it to the ball. The
 * widget is pinned to the window's top-left so growing never moves it.
 */

/**
 * The resting size. The open size is measured from the card itself — see
 * DripUI's layout effect — so a short reply gets a short window instead of a
 * guessed 548px box.
 */
const BALL: [number, number] = [100, 100];

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
      .requestWindow({ width: BALL[0], height: BALL[1], disallowReturnToOpener: true })
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
  /**
   * The window's own chrome — the title strip Chrome draws above the document.
   * `requestWindow`'s width/height describe the whole window, and `innerHeight`
   * is what the document actually gets, so every window size has to be that
   * much larger than the layout it has to show.
   */
  const padRef = useRef({ w: 0, h: 0 });

  /** Measured by the face, applied while the click's gesture is still live. */
  const resize = useCallback((size: { width: number; height: number } | null) => {
    const win = winRef.current;
    if (!win) return;
    const [width, height] = size ? [size.width, size.height] : BALL;
    try {
      win.resizeTo(width + padRef.current.w, height + padRef.current.h);
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
      // Chrome's title strip is part of the window, not of the document: the
      // document only gets `innerHeight`, which can be smaller than the height
      // we asked for. Learn that difference once and add it to every resize, or
      // the ball and the card are both cut off at the bottom.
      //
      // It must be measured against what we *asked for*, not against
      // `outerHeight`: the outer size can be a remembered size from a previous
      // PiP window, and subtracting it produced a nonsense 4x padding.
      const innerW = Math.round(win.innerWidth);
      const innerH = Math.round(win.innerHeight);
      padRef.current = {
        w: innerW > 0 ? Math.max(0, BALL[0] - innerW) : 0,
        h: innerH > 0 ? Math.max(0, BALL[1] - innerH) : 0,
      };
      copyStyles(win.document);
      // Without a title the PiP window's title bar shows the page's origin
      // ("localhost:5173"); the app's own name replaces it.
      win.document.title = document.title || "Absence";
      // Chrome reuses the previous PiP window's size, so the request above is
      // only a hint; state the ball's size outright while the click's gesture
      // is still alive.
      try {
        win.resizeTo(BALL[0] + padRef.current.w, BALL[1] + padRef.current.h);
      } catch {
        // No activation left: the first layout pass will try again.
      }
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
    root.render(<DripUI pip onOpenAbsence={leave} onLayout={resize} />);
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
