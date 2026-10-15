import type { Agent } from "https";
let agent: Agent | undefined;
// Keep Node loading lazy: mobile builds may import the adapters but must never
// load desktop HTTPS. Agents pool sockets, not request credentials or headers.
export function nativeHttpsAgent(): Agent {
  return agent ??= new (require("node:https").Agent)({
    keepAlive: true, maxSockets: 4, maxFreeSockets: 2, scheduling: "lifo",
  });
}
export function closeNativeConnections() {
  agent?.destroy();
  agent = undefined;
}
export function nativeTransferTimeout(bytes: number): number {
  return Math.max(60000, Math.min(600000, 30000 + Math.ceil(bytes / (128 * 1024)) * 1000));
}
// Aliyun's file CDN can sustain only ~30 KiB/s on constrained networks.
// Keep a separate total deadline for reads; the transport's 30s socket-idle
// timeout still terminates connections that stop making progress.
export function nativeDownloadTimeout(bytes: number): number {
  return Math.max(60000, Math.min(30 * 60 * 1000, 30000 + Math.ceil(bytes / (24 * 1024)) * 1000));
}
