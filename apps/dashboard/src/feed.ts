import { initialState, parseHistory, parseSnapshot, type DashboardState, type Health } from "./model.js";

export interface Stream {
  addEventListener(name: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}
export interface FeedTransport {
  get(path: string, signal: AbortSignal): Promise<unknown>;
  stream(): Stream;
  now(): number;
}
export const browserTransport: FeedTransport = {
  async get(path, signal) {
    const response = await fetch(path, { signal, cache: "no-store", credentials: "omit" });
    if (!response.ok) throw new Error("Monitor request failed");
    return response.json();
  },
  stream: () => new EventSource("/api/events"), now: () => performance.now(),
};

/** Requests/SSE race safely. History is authoritative: transitions trigger a history
 * refresh, never a synthesized timeline entry based on browser observations.
 */
export class DashboardFeed {
  state = initialState();
  private stopped = false;
  private sequence = 0;
  private historySequence = 0;
  private stream?: Stream;
  private timer?: ReturnType<typeof setInterval>;
  private controllers = new Set<AbortController>();
  constructor(private transport: FeedTransport, private changed: (state: DashboardState) => void) {}
  private publish() { if (!this.stopped) this.changed({ ...this.state, errors: { ...this.state.errors } }); }
  private async get(path: string) {
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 8000);
    try { return await this.transport.get(path, controller.signal); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  private accept(value: unknown) {
    this.state.snapshot = parseSnapshot(value); this.state.receivedAt = this.transport.now();
    delete this.state.errors.status; this.sequence++; this.publish();
  }
  async status() {
    const sequence = this.sequence;
    try { const value = await this.get("/api/status"); if (!this.stopped && sequence === this.sequence) this.accept(value); }
    catch { if (!this.stopped && sequence === this.sequence) { this.state.errors.status = "Current monitor snapshot unavailable."; this.publish(); } }
  }
  async history() {
    const sequence = ++this.historySequence;
    try {
      const value = await this.get("/api/history");
      if (!this.stopped && sequence === this.historySequence) { this.state.history = parseHistory(value); delete this.state.errors.history; this.publish(); }
    } catch { if (!this.stopped && sequence === this.historySequence) { this.state.errors.history = "Transition history unavailable."; this.publish(); } }
  }
  async health() {
    try {
      const value = await this.get("/api/health") as Health;
      if (!value || typeof value.operational !== "boolean" || !["MONITORING", "DEGRADED", "STOPPED"].includes(value.state)) throw new Error();
      if (!this.stopped) { this.state.health = value; this.state.healthAt = this.transport.now(); delete this.state.errors.health; this.publish(); }
    } catch { if (!this.stopped) { this.state.health = null; this.state.errors.health = "Operational health unavailable."; this.publish(); } }
  }
  start() {
    void this.status(); void this.history(); void this.health();
    this.stream = this.transport.stream();
    this.stream.addEventListener("open", () => {
      if (this.stopped) return;
      this.state.connection = "live"; this.publish();
      // Includes server restart/ID reset: replace from the authoritative history endpoint.
      void this.history(); void this.health();
    });
    this.stream.addEventListener("error", () => {
      if (this.stopped) return;
      this.state.connection = "reconnecting";
      this.state.snapshot = null; this.sequence++; this.publish();
      // Native EventSource reconnects; never create duplicate streams here.
    });
    const evidence = (event: MessageEvent) => {
      if (this.stopped) return;
      try { this.accept(JSON.parse(event.data)); }
      catch { this.state.snapshot = null; this.state.errors.status = "Invalid monitor evidence received."; this.publish(); }
    };
    this.stream.addEventListener("evidence", evidence);
    this.stream.addEventListener("transition", event => { evidence(event); void this.history(); });
    this.timer = setInterval(() => { void this.health(); }, 10_000);
  }
  stop() {
    this.stopped = true; clearInterval(this.timer); this.stream?.close();
    for (const controller of this.controllers) controller.abort();
  }
}
