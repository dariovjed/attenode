import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "./App.js";
import { DashboardFeed, type Stream, type FeedTransport } from "./feed.js";
import { currentReport, explorer, initialState, parseHistory, parseSnapshot, trustLabel, type MonitorSnapshot, type DashboardState } from "./model.js";
import viteConfig from "../vite.config.js";

assert.equal(viteConfig.server?.host, "127.0.0.1");
assert.equal(viteConfig.server?.fs?.allow?.length, 1);
assert.ok(viteConfig.server?.fs?.deny?.includes("**/.local/**"));

// Synthetic UI fixtures only; never included in production or used by verification.
const checked = "2026-10-10T12:00:00.000Z";
const fresh = () => ({ checkedAt: checked, lastAttemptAt: checked, completedAt: checked, ageMs: 0, maxAgeMs: 15000,
  fresh: true, inFlight: false, timedOut: false, diagnostic: null });
function snapshot(status: "VERIFIED" | "TRUST_BROKEN" | "INDETERMINATE"): MonitorSnapshot {
  const image = `ghcr.io/example/demo@sha256:${"a".repeat(64)}`;
  return { status, timestamp: checked, inFlight: false, freshness: { evidenceCurrent: status !== "INDETERMINATE", sas: fresh(), kubernetes: fresh() },
    diagnostic: null, lastObtainedReport: null,
    report: { mode: "sas", localPolicy: { namespace: "demo", workload: "api", container: "api", imageRepository: "ghcr.io/example/demo" },
      sas: { status: "VERIFIED", network: "devnet", attestation: "HVjR8c5iF5mXegmboR54HB3EzRSTadb7j9L5D4uLq9WQ", credential: "", schema: "",
        issuer: "GisnMiKvJUJfjCejzMbVCRpjcWvWWaFNUMokHaJmpr75", checkedAt: checked, expiry: String(Date.parse(checked) / 1000 + 3600), reason: "Fixture",
        payload: { repository: "example/demo", commitSha: "b".repeat(40), artifactDigest: `sha256:${"a".repeat(64)}`, environment: "development", provenanceProvider: "", deployedAt: checked } },
      kubernetes: { approved: { namespace: "demo", workload: "api", container: "api", imageReference: image },
        observations: [{ namespace: "demo", workload: "api", pod: "demo-pod", container: "api", imageReference: image, runtimeImageID: image, ready: true }], perPod: [], collectionIssues: [],
        result: { status, reasons: [], basis: "image-reference" } },
      artifact: { status, reason: "Fixture", perPod: [] }, result: { status, reason: "Fixture" } },
  };
}
const live = (value: MonitorSnapshot): DashboardState => ({ ...initialState(), snapshot: value, receivedAt: 100, connection: "live" });
for (const status of ["VERIFIED", "TRUST_BROKEN", "INDETERMINATE"] as const) {
  const state = live(parseSnapshot(snapshot(status)));
  assert.equal(trustLabel(state, 100), status);
  const html = renderToStaticMarkup(<Dashboard state={state} now={100}/>);
  assert.ok(html.includes(status.replaceAll("_", " ")));
  assert.ok(html.includes("ON-CHAIN CLAIMS")); assert.ok(html.includes("LOCAL BINDING POLICY"));
  assert.ok(html.includes("KUBERNETES-REPORTED OBSERVATIONS"));
  assert.ok(html.includes("cluster=devnet"));
}
const valid = live(snapshot("VERIFIED"));
assert.equal(trustLabel(valid, 15100), "STALE");
assert.equal(currentReport(valid, 15100), null);
const noSas = snapshot("INDETERMINATE");
noSas.lastObtainedReport = { report: noSas.report!, timestamp: checked, diagnosticOnly: true };
noSas.report = null; noSas.freshness.sas.fresh = false;
const unavailableHtml = renderToStaticMarkup(<Dashboard state={live(noSas)} now={100}/>);
assert.ok(unavailableHtml.includes("Kubernetes collection is fresh"));
assert.ok(!unavailableHtml.includes("example/demo")); // never populate from historical diagnostics
assert.ok(unavailableHtml.includes("No current validated SAS payload"));
const healthyButUnknown = live(noSas);
healthyButUnknown.health = { operational: true, state: "MONITORING", inFlight: false, verificationStatus: "INDETERMINATE",
  freshness: noSas.freshness, diagnostic: null };
healthyButUnknown.healthAt = 100;
assert.equal(trustLabel(healthyButUnknown, 100), "INDETERMINATE");
assert.ok(renderToStaticMarkup(<Dashboard state={healthyButUnknown} now={100}/>).includes("Operational health is not proof"));
const expired = snapshot("VERIFIED"); expired.report!.sas.expiry = String(Date.parse(checked) / 1000);
assert.equal(trustLabel(live(expired), 100), "STALE");
valid.connection = "reconnecting";
assert.equal(trustLabel(valid, 100), "UNAVAILABLE");
assert.ok(renderToStaticMarkup(<Dashboard state={initialState()} now={0}/>).includes("LOADING"));
assert.equal(explorer("javascript:alert(1)"), null);
assert.throws(() => parseSnapshot({ status: "VERIFIED" }));
assert.throws(() => parseHistory([{ id: 1, to: "FAKE" }]));

class FakeStream implements Stream {
  listeners = new Map<string, (event: MessageEvent) => void>(); closed = false;
  addEventListener(name: string, listener: (event: MessageEvent) => void) { this.listeners.set(name, listener); }
  close() { this.closed = true; }
  send(name: string, value?: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(value) } as MessageEvent); }
}
const stream = new FakeStream();
let pendingStatus!: (value: unknown) => void;
let histories = 0, streams = 0, ticks = 100;
let transitions = [{ id: 2, timestamp: checked, from: "VERIFIED", to: "TRUST_BROKEN", diagnostic: null }];
const transport: FeedTransport = {
  now: () => ticks,
  stream: () => { streams++; return stream; },
  async get(path) {
    if (path === "/api/status") return new Promise(done => { pendingStatus = done; });
    if (path === "/api/history") { histories++; return transitions; }
    return { operational: true, state: "MONITORING", inFlight: false };
  },
};
const feed = new DashboardFeed(transport, () => {});
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
feed.start(); stream.send("open"); stream.send("evidence", snapshot("TRUST_BROKEN"));
pendingStatus(snapshot("VERIFIED")); await flush();
assert.equal(feed.state.snapshot?.status, "TRUST_BROKEN"); // initial fetch cannot overwrite newer SSE
assert.equal(feed.state.history.length, 1);
assert.equal(streams, 1);
const before = histories;
stream.send("transition", snapshot("VERIFIED")); await flush();
assert.ok(histories > before);
assert.equal(feed.state.history.length, 1); // never invent a transition from local status changes
stream.send("error");
assert.equal(trustLabel(feed.state, ticks), "UNAVAILABLE");
assert.equal(feed.state.snapshot, null);
stream.send("open"); stream.send("evidence", snapshot("VERIFIED")); await flush();
assert.equal(trustLabel(feed.state, ticks), "VERIFIED");
assert.equal(streams, 1); // native reconnect reuses the stream
transitions = [{ id: 1, timestamp: checked, from: "INDETERMINATE", to: "VERIFIED", diagnostic: null }];
stream.send("error"); stream.send("open"); stream.send("evidence", snapshot("VERIFIED")); await flush();
assert.equal(feed.state.history.length, 1); assert.equal(feed.state.history[0]!.id, 1); // server restart replaces old epoch
ticks += 15000;
assert.equal(trustLabel(feed.state, ticks), "STALE");
stream.send("evidence", { status: "VERIFIED" });
assert.equal(feed.state.snapshot, null);
assert.ok(feed.state.errors.status);
feed.stop(); assert.equal(stream.closed, true);
stream.send("evidence", snapshot("VERIFIED")); assert.equal(feed.state.snapshot, null);

const failure = new DashboardFeed({ now: () => 0, stream: () => new FakeStream(), async get() { throw new Error("SYNTHETIC_SECRET"); } }, () => {});
failure.start(); await flush();
assert.equal(trustLabel(failure.state, 0), "UNAVAILABLE");
assert.ok(!JSON.stringify(failure.state).includes("SYNTHETIC_SECRET")); failure.stop();
console.log("Dashboard offline tests: PASS (SSR rendering for all states, source boundaries, fresh Kubernetes/no SAS, stale/expired/history-only suppression, fetch/SSE ordering, reconnect, authoritative history, malformed evidence, safe failures and cleanup)");
