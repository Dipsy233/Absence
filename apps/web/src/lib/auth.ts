/**
 * The access token for a server bound beyond loopback (see ABSENCE_TOKEN).
 *
 * A remote monitor prints its board URL with `?token=<secret>`; the app keeps
 * that token (URL first, then sessionStorage for the rest of the browsing
 * session) and attaches it to every API call and session socket. On a loopback
 * server no token exists and every helper is a no-op, so local use is unchanged.
 *
 * The token is carried in the query string because a WebSocket handshake cannot
 * set a custom header from the browser; the same query param covers fetch, so
 * one mechanism serves both.
 */

const STORAGE_KEY = "absence.token";

function readToken(): string | undefined {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("token");
    if (fromUrl) {
      try {
        window.sessionStorage.setItem(STORAGE_KEY, fromUrl);
      } catch {
        // Storage can be blocked (private mode); the URL token still works for
        // this load, which is enough to reach the socket.
      }
      return fromUrl;
    }
    return window.sessionStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export const AUTH_TOKEN: string | undefined = readToken();

/** Append the token to a relative API path, when one exists. */
export function authUrl(url: string): string {
  if (!AUTH_TOKEN) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(AUTH_TOKEN)}`;
}

/** Append the token to a ws:// or wss:// URL, when one exists. */
export function authWsUrl(url: string): string {
  return authUrl(url);
}
