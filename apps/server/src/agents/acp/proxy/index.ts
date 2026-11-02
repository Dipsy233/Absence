/** The transparent ACP proxy: line transports, read-only tap and sessions. */

export { AcpProxy, type AcpProxyExit, type AcpProxyOptions, type AcpProxySide } from "./proxy";
export {
  AcpProxyTap,
  type AcpProxyTapOptions,
  type AcpProxyTapStats,
  type ProxyDiagnostic,
  type ProxyDirection,
} from "./tap";
export {
  createAgentTransport,
  createProcessTransport,
  createStreamTransport,
  type AcpProxyTransport,
  type StreamTransportOptions,
} from "./transport";
export {
  proxySessions,
  ProxySessions,
  type ProxyEndpoint,
  type ProxyLaunchRequest,
  type ProxySessionHandle,
  type ProxySessionInfo,
  type ProxySessionStatus,
} from "./registry";
