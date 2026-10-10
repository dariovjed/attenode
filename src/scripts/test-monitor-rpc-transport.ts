import assert from "node:assert/strict";
import { address, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from "gill";
import { createDevnetSolanaClient, fetchDevnetEncodedAccount } from "../attestations/devnet-rpc.js";
import { createMonitorDevnetRpc } from "../attestations/monitor-rpc.js";
import { accountFetchDiagnostic } from "../attestations/sas-reader.js";

// A compatible legacy dispatcher produces an offline fixture: no socket or network.
const symbol = Symbol.for("undici.globalDispatcher.1");
const original = (globalThis as Record<symbol, unknown>)[symbol];
const encodedResponse = JSON.stringify({ jsonrpc: "2.0", id: "fixture", result: { context: { slot: 1 }, value: {
  data: ["AAEC", "base64"], executable: false, lamports: 1, owner: "11111111111111111111111111111111", space: 3,
} } });
const account = address("11111111111111111111111111111111");
const legacy = { dispatch(_options: unknown, handler: { onConnect(fn: () => void): void; onHeaders(status: number, headers: string[], resume: () => void, message: string): void;
  onData(bytes: Uint8Array): void; onComplete(trailers: string[]): void }) {
  handler.onConnect(() => {}); handler.onHeaders(200, ["content-type", "application/json"], () => {}, "OK");
  handler.onData(Buffer.from(encodedResponse)); handler.onComplete([]); return true;
} };
(globalThis as Record<symbol, unknown>)[symbol] = legacy;
const reused = createDevnetSolanaClient();
assert.equal((await fetchDevnetEncodedAccount(reused.rpc, account, { commitment: "finalized" })).exists, true);
for (let index = 0; index < 5; index++) assert.equal((await fetchDevnetEncodedAccount(reused.rpc, account, { commitment: "finalized" })).exists, true);

// Kubernetes imports installed Undici, whose initialization replaces the legacy
// process-wide dispatcher. Use a real Agent validator, but prohibit all connects.
await import("@kubernetes/client-node"); // module initialization only: no kubeconfig or API access
assert.notEqual((globalThis as Record<symbol, unknown>)[symbol], legacy);
const { Agent, setGlobalDispatcher } = await import("undici");
let connects = 0;
const agent = new Agent({ connect(_options, callback) {
  connects++; callback(Object.assign(new Error("OFFLINE_CONNECT_BLOCKED"), { code: "OFFLINE_CONNECT_BLOCKED" }), null);
} });
setGlobalDispatcher(agent);
try {
  for (const rpc of [reused.rpc, createDevnetSolanaClient().rpc]) {
    await assert.rejects(fetchDevnetEncodedAccount(rpc, account, { commitment: "finalized" }), error => {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      assert.equal(cause?.code, "UND_ERR_INVALID_ARG");
      assert.equal(cause?.message, "invalid content-length header"); // exact known constant, never logged
      assert.equal(accountFetchDiagnostic(error).code, "SAS_RPC_LOCAL_REQUEST_REJECTED");
      return true;
    });
  }
  assert.equal(connects, 0); // failure happens before any connector/network activity
  await assert.rejects(fetchDevnetEncodedAccount(createMonitorDevnetRpc(), account, { commitment: "finalized" }), error => {
    assert.equal((error as { cause?: { code?: string } }).cause?.code, "OFFLINE_CONNECT_BLOCKED"); return true;
  });
  assert.equal(connects, 1); // corrected request passes actual Undici header validation
} finally {
  await agent.destroy();
  (globalThis as Record<symbol, unknown>)[symbol] = original;
}

let signalSeen: AbortSignal | undefined;
const controller = new AbortController();
const rpc = createMonitorDevnetRpc(async (_url, options) => {
  const headers = options?.headers as Record<string, string>;
  assert.equal(headers["content-length"], undefined);
  assert.equal(headers["content-type"], "application/json; charset=utf-8");
  const request = JSON.parse(options!.body as string);
  // The SDK omits its default finalized value on the wire, as it does for the CLI.
  assert.equal(request.params[1].commitment ?? "finalized", "finalized");
  assert.equal(request.params[1].encoding, "base64");
  signalSeen = options?.signal as AbortSignal;
  return new Response(encodedResponse, { status: 200 });
});
const parsed = await fetchDevnetEncodedAccount(rpc, account, { commitment: "finalized", abortSignal: controller.signal });
assert.equal(parsed.exists, true);
if (parsed.exists) { assert.deepEqual([...parsed.data], [0, 1, 2]); assert.equal(parsed.lamports, 1n); }
assert.equal(signalSeen, controller.signal);
const unavailable = createMonitorDevnetRpc(async () => new Response("not logged", { status: 503 }));
await assert.rejects(fetchDevnetEncodedAccount(unavailable, account, { commitment: "finalized" }), error => {
  assert.equal((error as { context?: { __code?: number } }).context?.__code, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR);
  assert.equal(accountFetchDiagnostic(error).code, "SAS_RPC_HTTP_UNAVAILABLE"); return true;
});
console.log("Monitor RPC transport offline regression: PASS (legacy success -> persistent fresh/reused Gill failure before connect after Undici dispatcher change; fixed transport passes validator; SDK decoding, finalized, AbortSignal and HTTP classification preserved)");
