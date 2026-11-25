/**
 * The session deep link: `/s/<sessionId>`.
 *
 * The board is the app's front door, and a session panel is a *place*, not a
 * transient state: the address bar must name it so a refresh keeps the panel,
 * a link can be pasted into another browser (or printed by the CLI for a
 * headless server), and the back button returns to the board without tearing
 * the observation down.
 *
 * The app is served from the origin root (see apps/server/src/index.ts), so
 * the path is absolute. Nothing here talks to the server: the stores own the
 * session, this only keeps the address bar honest.
 */

const SESSION_PATH = /^\/s\/([^/]+)\/?$/;

/** The session id the current URL names, or undefined for the board. */
export function sessionIdFromPath(pathname: string = window.location.pathname): string | undefined {
  const match = SESSION_PATH.exec(pathname);
  if (!match) return undefined;
  try {
    const id = decodeURIComponent(match[1]!);
    return id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Put a session in the address bar without reloading the app. */
export function pushSessionRoute(sessionId: string): void {
  const target = `/s/${encodeURIComponent(sessionId)}`;
  if (window.location.pathname === target) return;
  window.history.pushState({ sessionId }, "", target);
}

/** Back to the board: the address bar drops the session, the app keeps running. */
export function clearSessionRoute(): void {
  if (window.location.pathname === "/") return;
  window.history.pushState({}, "", "/");
}
