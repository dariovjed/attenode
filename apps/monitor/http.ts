import type { IncomingMessage, ServerResponse } from "node:http";
import type { TrustMonitor } from "./monitor.js";

/** Fixed GET routes only. Query parameters, body, host and paths never select files or targets. */
export function monitorHandler(monitor: TrustMonitor, allowedOrigin: string) {
  let clients = 0;
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Vary", "Origin");
    const deny = (status: number, code: string) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: code })); };
    // Block DNS rebinding as well as browser requests from unapproved origins.
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(req.headers.host ?? "")) return deny(403, "HOST_DENIED");
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== allowedOrigin) return deny(403, "ORIGIN_DENIED");
    if (origin) res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    if (req.method !== "GET") { res.setHeader("Allow", "GET"); return deny(405, "METHOD_NOT_ALLOWED"); }
    if (req.url === "/api/status" || req.url === "/api/health" || req.url === "/api/history") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url === "/api/status" ? monitor.snapshot() : req.url === "/api/history" ? monitor.history() : monitor.health()));
      return;
    }
    if (req.url !== "/api/events") return deny(404, "NOT_FOUND");
    if (clients >= 64) return deny(503, "SSE_CAPACITY");
    clients++;
    res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`event: evidence\ndata: ${JSON.stringify(monitor.snapshot())}\n\n`);
    const unsubscribe = monitor.subscribe(event => {
      if (!res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.snapshot)}\n\n`)) res.destroy();
    });
    res.once("close", () => { clients--; unsubscribe(); });
  };
}
