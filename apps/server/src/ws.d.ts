/**
 * Minimal ambient types for `ws`.
 *
 * The server depends on `ws` transitively through `@fastify/websocket`, which
 * ships `@types/ws` only as a dev dependency — so it is not resolvable here.
 * The exec-server uses a very small surface (construct a server, read its
 * address, accept connections), which is declared below rather than pulling in
 * the full upstream typings.
 */
declare module "ws" {
  export class WebSocketServer {
    constructor(options?: { host?: string; port?: number; noServer?: boolean; path?: string });
    address(): { port: number } | string | null;
    on(event: string, listener: (...args: any[]) => void): this;
    close(callback?: (error?: Error) => void): void;
  }
}
