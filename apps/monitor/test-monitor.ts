import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mock } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { address, lamports, type Address, type EncodedAccount } from "gill";
import { getAttestationEncoder, getCredentialEncoder, getSchemaEncoder, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import { expectedCredential, expectedIdentity, schemaAccountDiscriminator } from "../../src/scripts/devnet-schema-verification.js";
import { expectedSchema, attestationAccountDiscriminator } from "../../src/scripts/devnet-attestation-demo.js";
import { createDemoApiExecution, demoApiNonce } from "../../src/scripts/devnet-demo-api.js";
import { demoApiAttestationAddress } from "../../src/attestations/sas-approval.js";
import { deploymentSasSchema, serializeDeploymentSasAttestation } from "../../src/attestations/sas.js";
import type { KubernetesReader } from "../../src/runtime/kubernetes.js";
import type { SasKubernetesReport } from "../../src/runtime/sas-verification.js";
import { monitorVerifier, TrustMonitor, freshnessMs, intervalMs } from "./monitor.js";
import { readMonitorConfig } from "./config.js";
import { monitorHandler } from "./http.js";
import { diagnostic, VerificationDiagnosticError } from "../../src/runtime/diagnostics.js";

const secret = "SYNTHETIC_MONITOR_SECRET";
const config = readMonitorConfig({ ATTENODE_KUBECONFIG: secret, ATTENODE_CONTEXT: "mock-context", ATTENODE_NAMESPACE: "attenode-demo",
  ATTENODE_DEPLOYMENT: "demo-api", ATTENODE_CONTAINER: "demo-api", ATTENODE_IMAGE_REPOSITORY: "ghcr.io/dariovjed/demo-api" });
assert.equal(config.port, 3001);
for (const env of [{}, { ATTENODE_MONITOR_PORT: "0" }, { ATTENODE_MONITOR_ORIGIN: "https://example.invalid" }]) {
  assert.throws(() => readMonitorConfig(env));
}
const baseEnv = { ATTENODE_KUBECONFIG: secret, ATTENODE_CONTEXT: "mock-context", ATTENODE_NAMESPACE: "attenode-demo",
  ATTENODE_DEPLOYMENT: "demo-api", ATTENODE_CONTAINER: "demo-api", ATTENODE_IMAGE_REPOSITORY: "ghcr.io/dariovjed/demo-api" };
for (const patch of [{ ATTENODE_NAMESPACE: "other" }, { ATTENODE_MONITOR_PORT: "1e3" },
  { ATTENODE_SAS_MAX_AGE_MS: "999" }, { ATTENODE_SAS_MAX_AGE_MS: "3600001" },
  { ATTENODE_MONITOR_ORIGIN: "http://127.0.0.1:5173/path" }, { ATTENODE_MONITOR_ORIGIN: "http://user:pass@localhost:5173" }]) {
  assert.throws(() => readMonitorConfig({ ...baseEnv, ...patch }));
}
const { deployment, expiry } = createDemoApiExecution(Date.now());
const authority = address(expectedIdentity), credential = address(expectedCredential), schema = address(expectedSchema), attestation = address(demoApiAttestationAddress);
const encoded = (accountAddress: Address, data: EncodedAccount["data"]): EncodedAccount => ({ address: accountAddress,
  data, executable: false, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS, lamports: lamports(1n), space: BigInt(data.length) });
const accounts = new Map<Address, EncodedAccount>([
  [credential, encoded(credential, getCredentialEncoder().encode({ discriminator: 0, authority, name: Buffer.from("Attenode"), authorizedSigners: [authority] }))],
  [schema, encoded(schema, getSchemaEncoder().encode({ ...deploymentSasSchema, credential, discriminator: schemaAccountDiscriminator }))],
  [attestation, encoded(attestation, getAttestationEncoder().encode({ discriminator: attestationAccountDiscriminator, credential, schema, nonce: demoApiNonce,
    signer: authority, expiry, data: serializeDeploymentSasAttestation(deployment), tokenAccount: address("11111111111111111111111111111111") }))],
]);
const approvedImage = `${config.policy.imageRepository}@${deployment.artifact.digest}`;
let image = approvedImage, solanaFailure = false, rejectSas = false, kubeFailure = false, clientFailure = false, kubeCalls = 0, sasCalls = 0;
const owner = (kind: string, name: string, uid: string) => ({ apiVersion: "apps/v1", kind, name, uid, controller: true });
const kube: KubernetesReader = {
  async deployment() {
    if (kubeFailure) throw Object.assign(new Error(secret), { statusCode: 403 });
    return { metadata: { namespace: "attenode-demo", name: "demo-api", uid: "dep", resourceVersion: "1" } };
  },
  async replicaSets() { return [{ metadata: { namespace: "attenode-demo", name: "rs", uid: "rs", ownerReferences: [owner("Deployment", "demo-api", "dep")] } }]; },
  async pods() { return [{ metadata: { namespace: "attenode-demo", name: "pod", uid: "pod", ownerReferences: [owner("ReplicaSet", "rs", "rs")] },
    spec: { containers: [{ name: "demo-api", image }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ name: "demo-api", image, imageID: image, ready: true, restartCount: 0, state: { running: {} } }] } }]; },
};
const verify = monitorVerifier(config, {
  sasReader: () => { sasCalls++; return { async account(accountAddress) { if (solanaFailure) throw new Error(secret); if (rejectSas && accountAddress === credential) return null; return accounts.get(accountAddress) ?? null; } }; },
  async kubernetesReader(path, context) {
    assert.equal(path, secret); assert.equal(context, config.context); kubeCalls++;
    if (clientFailure) throw new Error(secret);
    return kube;
  },
});
let now = Date.now();
const initialTime = now;
const monitor = new TrustMonitor(verify, config, () => now);
const transitions: string[] = [], updates: string[] = [];
monitor.subscribe(event => { if (event.type === "transition") transitions.push(event.snapshot.status); else updates.push(event.snapshot.status); });
assert.equal(monitor.snapshot().status, "INDETERMINATE");
await monitor.tick();
assert.equal(monitor.snapshot().status, "VERIFIED");
assert.equal(monitor.snapshot().freshness.evidenceCurrent, true);
assert.equal(sasCalls, 1);
now += intervalMs;
image = `${config.policy.imageRepository}@sha256:${"a".repeat(64)}`;
await monitor.tick();
assert.equal(monitor.snapshot().status, "TRUST_BROKEN");
assert.equal(sasCalls, 1);
now += intervalMs;
image = approvedImage;
await monitor.tick();
assert.equal(monitor.snapshot().status, "VERIFIED");
assert.deepEqual(transitions, ["VERIFIED", "TRUST_BROKEN", "VERIFIED"]);
assert.ok(updates.length >= 3);
assert.equal(kubeCalls, 3);
const report = monitor.snapshot().report!;
const evidence = await verify.kubernetes();
// Availability failure keeps only bounded validated SAS, while NEW Kubernetes drift is evaluated.
now = initialTime + 60_000;
solanaFailure = true;
image = `${config.policy.imageRepository}@sha256:${"b".repeat(64)}`;
await monitor.tick();
assert.equal(sasCalls, 2);
assert.equal(monitor.snapshot().status, "TRUST_BROKEN");
assert.equal(monitor.snapshot().freshness.sas.checkedAt, new Date(initialTime).toISOString());
assert.equal(monitor.snapshot().freshness.kubernetes.checkedAt, new Date(now).toISOString());
assert.equal(monitor.snapshot().diagnostic?.stage, "SAS_RPC");
assert.equal(monitor.snapshot().freshness.sas.fresh, true);
assert.ok(!JSON.stringify(monitor.snapshot()).includes(secret));
image = approvedImage; now += intervalMs;
await monitor.tick();
assert.equal(monitor.snapshot().status, "VERIFIED");
assert.equal(sasCalls, 2);
const prior = monitor.snapshot().lastObtainedReport;
kubeFailure = true; now += intervalMs;
await monitor.tick();
assert.equal(monitor.snapshot().status, "INDETERMINATE");
assert.equal(monitor.snapshot().diagnostic?.stage, "SAS_RPC");
assert.equal(monitor.snapshot().freshness.kubernetes.diagnostic?.code, "KUBERNETES_AUTHORIZATION_FAILED");
assert.equal(monitor.snapshot().freshness.kubernetes.fresh, false);
assert.deepEqual(monitor.snapshot().lastObtainedReport, prior);
kubeFailure = false; clientFailure = true; now += intervalMs;
await monitor.tick();
assert.equal(monitor.snapshot().freshness.kubernetes.diagnostic?.stage, "KUBERNETES_CLIENT");
clientFailure = false;
now = initialTime + config.sasMaxAgeMs;
await monitor.tick();
assert.equal(monitor.snapshot().status, "INDETERMINATE");
assert.equal(monitor.snapshot().report, null);
assert.equal(monitor.snapshot().freshness.sas.fresh, false);
assert.equal(monitor.snapshot().freshness.kubernetes.fresh, true);
// Recovery requires a new successful validation, not resurrection of an overall cache.
solanaFailure = false; now += 60_000;
await monitor.tick();
assert.equal(monitor.snapshot().status, "VERIFIED");
rejectSas = true; now += 60_000;
await monitor.tick();
assert.equal(monitor.snapshot().status, "INDETERMINATE");
assert.equal(monitor.snapshot().diagnostic?.code, "SAS_ACCOUNT_MISSING");
rejectSas = false; solanaFailure = true; now += 60_000;
await monitor.tick();
assert.equal(monitor.snapshot().status, "INDETERMINATE");
assert.equal(monitor.snapshot().freshness.sas.fresh, false);
solanaFailure = false; now += 60_000;
await monitor.tick();
assert.equal(monitor.snapshot().status, "VERIFIED");

// Exercise HTTP and SSE with fake transports, without opening sockets or accessing a network.
class Response extends EventEmitter {
  headers: Record<string, unknown> = {}; status = 0; body = ""; writable = true;
  setHeader(name: string, value: unknown) { this.headers[name] = value; }
  writeHead(status: number, headers: Record<string, unknown>) { this.status = status; Object.assign(this.headers, headers); }
  flushHeaders() {}
  write(value: string) { this.body += value; return this.writable; }
  end(value: string) { this.body += value; }
  destroy() { this.emit("close"); }
}
const handler = monitorHandler(monitor, config.allowedOrigin);
function request(url: string, method = "GET", origin?: string, host = "127.0.0.1:3001") {
  const res = new Response();
  handler({ url, method, headers: { host, ...(origin ? { origin } : {}) } } as IncomingMessage, res as unknown as ServerResponse);
  return res;
}
const status = request("/api/status", "GET", config.allowedOrigin);
assert.equal(status.status, 200);
assert.equal(JSON.parse(status.body).status, "VERIFIED");
assert.equal(status.headers["Access-Control-Allow-Origin"], config.allowedOrigin);
assert.equal(request("/api/status", "GET", "http://example.invalid").status, 403);
assert.equal(request("/api/status", "GET", undefined, "evil.invalid").status, 403);
assert.equal(request("/api/status", "POST").status, 405);
assert.equal(request("/api/status?file=anything").status, 404);
assert.equal(request("/api/health").status, 200);
assert.equal(request("/api/history").status, 200);
const sse = request("/api/events");
assert.equal(sse.headers["Content-Type"], "text/event-stream");
assert.ok(sse.body.includes("event: evidence"));
image = `${config.policy.imageRepository}@sha256:${"b".repeat(64)}`;
await monitor.tick();
assert.ok(sse.body.includes("event: transition"));
assert.ok(sse.body.includes('"status":"TRUST_BROKEN"'));
assert.ok(!sse.body.includes(secret));
const transitionCount = sse.body.split("event: transition").length;
const evidenceCount = sse.body.split("event: evidence").length;
await monitor.tick();
assert.equal(sse.body.split("event: transition").length, transitionCount);
assert.ok(sse.body.split("event: evidence").length > evidenceCount);
const history = JSON.parse(request("/api/history").body);
assert.equal(history.at(-1).to, "TRUST_BROKEN");
assert.ok(!JSON.stringify(history).includes(secret));
const clone = monitor.history(); clone[0]!.to = "INDETERMINATE";
assert.equal(monitor.history()[0]!.to, "VERIFIED");
sse.destroy();
const stoppedLength = sse.body.length;
await monitor.tick();
assert.equal(sse.body.length, stoppedLength);
const slow = request("/api/events"); slow.writable = false;
await monitor.tick();
const slowLength = slow.body.length;
await monitor.tick();
assert.equal(slow.body.length, slowLength);

// Fake timers: timeout resolves the tick but keeps the transport lock and consumes late settlement.
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
let resolveSas!: (value: SasKubernetesReport["sas"]) => void;
let rejectLate!: (value: Error) => void;
let sasAttempts = 0, kubeAttempts = 0;
const blocked = new TrustMonitor({
  sas() { sasAttempts++; return new Promise((done, fail) => { resolveSas = done; rejectLate = fail; }); },
  async kubernetes() { kubeAttempts++; return evidence; },
}, config, () => now);
const pending = blocked.tick();
await Promise.resolve(); await Promise.resolve();
assert.equal(sasAttempts, 1);
now += freshnessMs; mock.timers.tick(freshnessMs);
await pending; // effective timeout, not an indefinitely blocked tick
assert.equal(blocked.snapshot().freshness.sas.timedOut, true);
assert.equal(blocked.snapshot().freshness.sas.inFlight, true);
assert.equal(blocked.snapshot().status, "INDETERMINATE");
now += 60_000;
await blocked.tick();
assert.equal(sasAttempts, 1);
assert.ok(kubeAttempts >= 2); // one blocked source does not stop the other
resolveSas(report.sas);
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(blocked.snapshot().freshness.sas.inFlight, false);
assert.equal(blocked.snapshot().freshness.sas.fresh, false);
assert.equal(blocked.snapshot().report, null); // late approval discarded
const secondPending = blocked.tick();
await Promise.resolve(); await Promise.resolve();
assert.equal(sasAttempts, 2);
now += freshnessMs; mock.timers.tick(freshnessMs); await secondPending;
rejectLate(new Error(secret));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(blocked.snapshot().freshness.sas.inFlight, false);
assert.ok(!JSON.stringify(blocked.snapshot()).includes(secret));
// After late settlement, the next due attempt can safely recover.
const recoveredSources = { async sas() { return report.sas; }, async kubernetes() { return evidence; } };
let blockKube = false, releaseKube!: (value: typeof evidence) => void, observations = 0;
const kubeBlocked = new TrustMonitor({ ...recoveredSources,
  kubernetes() { observations++; return blockKube ? new Promise(done => { releaseKube = done; }) : Promise.resolve(evidence); },
}, config, () => now);
await kubeBlocked.tick();
assert.equal(kubeBlocked.snapshot().status, "VERIFIED");
blockKube = true; now += intervalMs;
const kubePending = kubeBlocked.tick(); await Promise.resolve(); await Promise.resolve();
now += freshnessMs; mock.timers.tick(freshnessMs); await kubePending;
assert.equal(kubeBlocked.snapshot().status, "INDETERMINATE");
assert.equal(kubeBlocked.snapshot().freshness.kubernetes.inFlight, true);
await kubeBlocked.tick();
assert.equal(observations, 2);
releaseKube(evidence); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(kubeBlocked.snapshot().status, "INDETERMINATE");
blockKube = false; await kubeBlocked.tick();
assert.equal(kubeBlocked.snapshot().status, "VERIFIED");
// Timed-out SAS can retain a bounded previous VALIDATED approval while fresh Kubernetes detects drift.
let failRefresh = false;
const grace = new TrustMonitor({
  sas: () => failRefresh ? new Promise(done => { resolveSas = done; }) : Promise.resolve(report.sas),
  kubernetes: recoveredSources.kubernetes,
}, config, () => now);
await grace.tick();
failRefresh = true; now += 60_000;
const gracePending = grace.tick(); await Promise.resolve(); await Promise.resolve();
now += freshnessMs; mock.timers.tick(freshnessMs); await gracePending;
await grace.tick();
assert.equal(grace.snapshot().status, "VERIFIED");
assert.equal(grace.snapshot().freshness.sas.timedOut, true);
now += config.sasMaxAgeMs;
await grace.tick();
assert.equal(grace.snapshot().status, "INDETERMINATE");
resolveSas(report.sas); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(grace.snapshot().freshness.sas.fresh, false);
// A late explicit negative SAS result invalidates cached approval immediately.
let invalidateRefresh = false;
const lateInvalidation = new TrustMonitor({
  sas: () => invalidateRefresh ? new Promise(done => { resolveSas = done; }) : Promise.resolve(report.sas),
  kubernetes: recoveredSources.kubernetes,
}, config, () => now);
await lateInvalidation.tick();
invalidateRefresh = true; now += 60_000;
const invalidationPending = lateInvalidation.tick(); await Promise.resolve(); await Promise.resolve();
now += freshnessMs; mock.timers.tick(freshnessMs); await invalidationPending; await lateInvalidation.tick();
assert.equal(lateInvalidation.snapshot().status, "VERIFIED");
resolveSas({ ...report.sas, status: "INDETERMINATE", payload: undefined, diagnostic: diagnostic("SAS_SCHEMA_REJECTED") });
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(lateInvalidation.snapshot().status, "INDETERMINATE");
assert.equal(lateInvalidation.snapshot().diagnostic?.code, "SAS_SCHEMA_REJECTED");
// Explicit SDK decoding errors are not classified as transient availability failures.
let decodeFailure = false;
const decoding = new TrustMonitor({ ...recoveredSources, async sas() {
  if (decodeFailure) throw new VerificationDiagnosticError("SAS_RPC_RESPONSE_INVALID");
  return report.sas;
} }, config, () => now);
await decoding.tick(); decodeFailure = true; now += 60_000; await decoding.tick();
assert.equal(decoding.snapshot().status, "INDETERMINATE");
assert.equal(decoding.snapshot().freshness.sas.fresh, false);
// Scheduler starts once, observes Kubernetes every five seconds, and renews SAS at sixty.
let scheduledSas = 0, scheduledKube = 0;
const scheduled = new TrustMonitor({ async sas() { scheduledSas++; return report.sas; },
  async kubernetes() { scheduledKube++; return evidence; } }, config, () => now);
const flush = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };
scheduled.start(); scheduled.start(); await flush();
assert.equal(scheduledSas, 1); assert.equal(scheduledKube, 1);
for (let step = 0; step < 11; step++) { now += intervalMs; mock.timers.tick(intervalMs); await flush(); }
assert.equal(scheduledSas, 1); assert.equal(scheduledKube, 12);
now += intervalMs; mock.timers.tick(intervalMs); await flush();
assert.equal(scheduledSas, 2); assert.equal(scheduledKube, 13);
scheduled.stop(); mock.timers.tick(intervalMs); await flush();
assert.equal(scheduledKube, 13);
blocked.stop(); kubeBlocked.stop(); grace.stop();
lateInvalidation.stop(); decoding.stop();
mock.timers.reset();

const expired = new TrustMonitor(recoveredSources, config, () => Number(expiry) * 1000);
await expired.tick();
assert.equal(expired.snapshot().status, "INDETERMINATE");
assert.equal(expired.snapshot().freshness.sas.diagnostic?.code, "SAS_APPROVAL_EXPIRED");
assert.equal(expired.snapshot().report, null);
// Bounded transition history stores only safe state changes, never report/configuration bodies.
let historyDrift = false;
const bounded = new TrustMonitor({ ...recoveredSources, async kubernetes() {
  const value = structuredClone(evidence);
  if (historyDrift) for (const observation of value.observations) {
    observation.imageReference = `${config.policy.imageRepository}@sha256:${"c".repeat(64)}`;
    observation.runtimeImageID = observation.imageReference;
  }
  return value;
} }, config, () => now);
await bounded.tick();
for (let index = 0; index < 110; index++) {
  historyDrift = !historyDrift;
  await bounded.tick();
}
assert.equal(bounded.history().length, 100);
assert.ok(!JSON.stringify(bounded.history()).includes(secret));
console.log("Monitor offline tests: PASS (independent SAS/Kubernetes schedules, drift during RPC failures, expiry/rejection/recovery, effective timeouts, late success/rejection discard, source single-flight, source freshness, HTTP/CORS/SSE and bounded history; no sockets or network)");
