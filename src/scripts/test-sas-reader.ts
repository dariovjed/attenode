import assert from "node:assert/strict";
import { mock } from "node:test";
import { address, lamports, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT } from "gill";
import { createDevnetSasReader, type DevnetReaderDependencies } from "../attestations/sas-reader.js";
import { devnetRpcUrl, fetchDevnetEncodedAccount } from "../attestations/devnet-rpc.js";
import { readDemoApiApproval, demoApiAttestationAddress } from "../attestations/sas-approval.js";
import { expectedCredential } from "./devnet-schema-verification.js";
import { expectedSchema } from "./devnet-attestation-demo.js";
import { safeDiagnostic, formatDiagnostic, VerificationDiagnosticError, type DiagnosticCode, type DiagnosticContext } from "../runtime/diagnostics.js";
import { runVerificationCli } from "../runtime/verification-cli.js";

const requested = address(expectedCredential);
const secret = "SYNTHETIC_READER_SECRET";
const rawError = () => Object.assign(new Error(secret), { url: `https://user:${secret}@example.invalid`, headers: { Authorization: secret }, body: secret });
const calls: { address: string; commitment: string; encoding: string }[] = [];
// Real Gill base64 account parsing over a fake RPC: no network or client configuration.
const rpc = { getAccountInfo(accountAddress: string, config: { commitment: string; encoding: string }) {
  calls.push({ address: accountAddress, commitment: config.commitment, encoding: config.encoding });
  return { async send() { return { value: { executable: false, lamports: 1n, owner: expectedCredential, space: 3n, data: [Buffer.from([0, 1, 2]).toString("base64"), "base64"] } }; } };
} } as unknown as ReturnType<typeof import("../attestations/devnet-rpc.js").createDevnetSolanaClient>["rpc"];
const dependencies: DevnetReaderDependencies = { createClient: () => ({ rpc }), fetchAccount: fetchDevnetEncodedAccount };
assert.equal(devnetRpcUrl, "https://api.devnet.solana.com");
const confirmed = await fetchDevnetEncodedAccount(rpc, requested, { commitment: "confirmed" });
assert.equal(confirmed.exists, true);
const finalized = await createDevnetSasReader(dependencies).account(requested);
assert.deepEqual(finalized, confirmed);
assert.ok(finalized?.data instanceof Uint8Array);
assert.deepEqual(calls, [ { address: requested, commitment: "confirmed", encoding: "base64" }, { address: requested, commitment: "finalized", encoding: "base64" } ]);

let cases = 0;
async function rejects(operation: () => unknown | Promise<unknown>, code: DiagnosticCode, context: DiagnosticContext) {
  try { await operation(); assert.fail("Expected diagnostic failure"); }
  catch (error) {
    assert.ok(error instanceof VerificationDiagnosticError);
    const safe = safeDiagnostic(error, "SAS_RPC");
    assert.equal(safe.code, code);
    for (const [key, value] of Object.entries(context)) assert.equal(safe[key as keyof DiagnosticContext], value);
    assert.ok(!formatDiagnostic(safe).includes(secret));
    assert.ok(!formatDiagnostic(safe, true).includes(secret));
    assert.deepEqual(JSON.parse(formatDiagnostic(safe, true)).error, safe);
    cases++;
  }
}
await rejects(() => createDevnetSasReader({ ...dependencies, createClient() { throw rawError(); } }), "SAS_RPC_INITIALIZATION_FAILED", { operation: "RPC_INITIALIZATION" });
await rejects(() => createDevnetSasReader({ ...dependencies, createClient() { return { rpc: undefined } as unknown as ReturnType<DevnetReaderDependencies["createClient"]>; } }), "SAS_RPC_INITIALIZATION_FAILED", { operation: "RPC_INITIALIZATION" });
let attempts = 0;
await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount(_rpc, _address, config) {
  attempts++; assert.equal(config.commitment, "finalized"); throw rawError();
} }).account(requested), "SAS_RPC_ACCOUNT_FETCH_FAILED", { operation: "ACCOUNT_FETCH" });
assert.equal(attempts, 1); // Never silently fall back to confirmed or a different approval.
await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() { throw Object.assign(rawError(), { statusCode: 429 }); } }).account(requested), "SAS_RPC_RATE_LIMITED", { operation: "ACCOUNT_FETCH" });
await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() {
  throw Object.assign(rawError(), { context: { __code: SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT, body: secret } });
} }).account(requested), "SAS_RPC_RESPONSE_DECODE_FAILED", { operation: "RESPONSE_DECODING" });
await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() {
  throw Object.defineProperty(rawError(), "context", { get() { throw rawError(); } });
} }).account(requested), "SAS_RPC_ACCOUNT_FETCH_FAILED", { operation: "ACCOUNT_FETCH" });
const valid = { ...finalized!, exists: true };
for (const response of [undefined, null, {}, { value: valid }, { ...valid, exists: undefined }, { ...valid, address: expectedSchema },
  { ...valid, data: [secret, "base64"] }, { ...valid, data: { parsed: secret } }, { ...valid, lamports: 1 }, { ...valid, space: "3" },
  { ...valid, executable: "false" }, Object.defineProperty({}, "exists", { get() { throw rawError(); } })]) {
  await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() { return response; } }).account(requested), "SAS_RPC_RESPONSE_INVALID", { operation: "RESPONSE_DECODING" });
}
assert.equal(await createDevnetSasReader({ ...dependencies, async fetchAccount() { return { address: requested, exists: false }; } }).account(requested), null);
// Empty bytes/wrong owner are not accepted as approval, but remain the validators' responsibility.
const empty = { ...valid, data: new Uint8Array(), space: 0n };
assert.equal((await createDevnetSasReader({ ...dependencies, async fetchAccount() { return empty; } }).account(requested))?.data.length, 0);
for (const [failedAddress, accountKind] of [[expectedCredential, "CREDENTIAL"], [expectedSchema, "SCHEMA"], [demoApiAttestationAddress, "ATTESTATION"]] as const) {
  const reader = createDevnetSasReader({ ...dependencies, async fetchAccount(_rpc, accountAddress) {
    if (accountAddress === failedAddress) throw rawError();
    return { ...valid, address: accountAddress };
  } });
  await rejects(() => readDemoApiApproval(reader, Date.now()), "SAS_RPC_ACCOUNT_FETCH_FAILED", { operation: "ACCOUNT_FETCH", accountKind });
}
const sanitized = new VerificationDiagnosticError("SAS_RPC_ACCOUNT_FETCH_FAILED", { operation: secret, accountKind: secret } as unknown as DiagnosticContext);
assert.equal(sanitized.diagnostic.operation, undefined);
assert.equal(sanitized.diagnostic.accountKind, undefined);
assert.equal(finalized?.lamports, lamports(1n));
const cliArgs = ["--sas", "--json", "--kubeconfig", "not-read-by-tests", "--context", "kind-attenode", "--namespace", "attenode-demo",
  "--deployment", "demo-api", "--container", "demo-api", "--image-repository", "ghcr.io/dariovjed/demo-api"];
for (const [deps, expectedCode, operation] of [
  [{ ...dependencies, createClient() { throw rawError(); } }, "SAS_RPC_INITIALIZATION_FAILED", "RPC_INITIALIZATION"],
  [{ ...dependencies, async fetchAccount() { throw rawError(); } }, "SAS_RPC_ACCOUNT_FETCH_FAILED", "ACCOUNT_FETCH"],
  [{ ...dependencies, async fetchAccount() { return { value: valid }; } }, "SAS_RPC_RESPONSE_INVALID", "RESPONSE_DECODING"],
] as const) {
  const result = await runVerificationCli(cliArgs, {
    sasReader: () => createDevnetSasReader(deps),
    kubernetesReader() { assert.fail("Kubernetes must not be constructed after an RPC failure"); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, undefined);
  const error = JSON.parse(result.stderr!).error;
  assert.equal(error.code, expectedCode);
  assert.equal(error.operation, operation);
  if (operation !== "RPC_INITIALIZATION") assert.equal(error.accountKind, "CREDENTIAL");
  assert.ok(!result.stderr!.includes(secret));
  cases++;
}
console.log(`SAS reader offline tests: PASS (${cases} failure scenarios; shared Gill fetch/base64 format, finalized commitment, no downgrade, RPC operations/account labels and sanitization)`);

for (const [statusCode, expectedCode] of [[429, "SAS_RPC_RATE_LIMITED"], [503, "SAS_RPC_HTTP_UNAVAILABLE"], [401, "SAS_RPC_HTTP_REJECTED"]] as const) {
  await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() {
    throw Object.assign(rawError(), { context: { __code: SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, statusCode, headers: secret, message: secret } });
  } }).account(requested), expectedCode, { operation: "ACCOUNT_FETCH" });
}
await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() {
  throw Object.assign(rawError(), { cause: { code: "UND_ERR_SOCKET", message: secret } });
} }).account(requested), "SAS_RPC_CONNECTION_RESET", { operation: "ACCOUNT_FETCH" });
let retryCalls = 0, concurrent = 0, maximum = 0;
const recovering = createDevnetSasReader({ ...dependencies, async fetchAccount(_rpc, accountAddress, config) {
  assert.equal(config.commitment, "finalized"); assert.ok(config.abortSignal);
  concurrent++; maximum = Math.max(maximum, concurrent);
  try {
    if (++retryCalls < 3) throw Object.assign(rawError(), { cause: { code: "ECONNRESET" } });
    return { ...valid, address: accountAddress };
  } finally { concurrent--; }
} }, { retryTransient: true });
assert.ok(await recovering.account(requested));
assert.equal(retryCalls, 3); assert.equal(maximum, 1);
retryCalls = 0;
await rejects(() => createDevnetSasReader({ ...dependencies, async fetchAccount() {
  retryCalls++; throw Object.assign(rawError(), { context: { __code: SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, statusCode: 503 } });
} }, { retryTransient: true }).account(requested), "SAS_RPC_HTTP_UNAVAILABLE", { operation: "ACCOUNT_FETCH" });
assert.equal(retryCalls, 3);
for (const error of [rawError(), Object.assign(rawError(), { cause: { code: "CERT_HAS_EXPIRED" } }),
  Object.assign(rawError(), { context: { __code: SOLANA_ERROR__ACCOUNTS__FAILED_TO_DECODE_ACCOUNT } })]) {
  let count = 0;
  await assert.rejects(createDevnetSasReader({ ...dependencies, async fetchAccount() { count++; throw error; } }, { retryTransient: true }).account(requested));
  assert.equal(count, 1);
}
let absentCalls = 0;
assert.equal(await createDevnetSasReader({ ...dependencies, async fetchAccount() {
  absentCalls++; return { address: requested, exists: false };
} }, { retryTransient: true }).account(requested), null);
assert.equal(absentCalls, 1);
console.log("SAS RPC reliability offline tests: PASS (SDK context status, nested transport causes, bounded retry/recovery, finalized-only, no overlap, no retries for unknown/TLS/decode/missing accounts)");

mock.timers.enable({ apis: ["setTimeout"] });
let lateResolve!: (value: unknown) => void;
let firstSignal!: AbortSignal;
let delayedCalls = 0;
const delayedReader = createDevnetSasReader({ ...dependencies, async fetchAccount(_rpc, _address, config) {
  assert.equal(config.commitment, "finalized");
  if (++delayedCalls === 1) {
    firstSignal = config.abortSignal!;
    return new Promise(resolve => { lateResolve = resolve; }); // deliberately ignores abort
  }
  return valid;
} }, { retryTransient: true });
const delayedResult = delayedReader.account(requested);
mock.timers.tick(2000);
assert.equal(firstSignal.aborted, true);
assert.equal(delayedCalls, 1); // never launch a retry while the aborted transport is still pending
lateResolve(valid);
for (let step = 0; step < 5; step++) await Promise.resolve();
mock.timers.tick(250);
assert.ok(await delayedResult);
assert.equal(delayedCalls, 2); // late positive response was discarded, then a fresh request succeeded
mock.timers.reset();
console.log("SAS RPC cancellation offline test: PASS (abort propagation, late response discard and transport-settlement lock)");
