import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { address, SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS } from "gill";
import { getCredentialEncoder, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import { diagnoseCredentialFetch, formatCredentialFetchReport, type CredentialDiagnosticDependencies } from "../attestations/sas-fetch-diagnostic.js";
import { fetchDevnetEncodedAccount } from "../attestations/devnet-rpc.js";
import { expectedCredential, expectedIdentity } from "./devnet-schema-verification.js";

const secret = "SYNTHETIC_DIAGNOSTIC_SECRET";
const rawError = () => Object.assign(new Error(secret), { headers: { Authorization: secret }, response: { body: secret }, url: `https://user:${secret}@example.invalid` });
const bytes = getCredentialEncoder().encode({ discriminator: 0, authority: address(expectedIdentity), name: Buffer.from("Attenode"), authorizedSigners: [address(expectedIdentity)] });
const requests: { key: string; commitment: string; encoding: string }[] = [];
const rpc = { getAccountInfo(key: string, config: { commitment: string; encoding: string }) {
  assert.equal(typeof key, "string");
  assert.equal(key, expectedCredential);
  requests.push({ key, ...config });
  return { async send() { return { value: { executable: false, lamports: 1n, owner: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    space: BigInt(bytes.length), data: [Buffer.from(bytes).toString("base64"), "base64"] } }; } };
} } as unknown as ReturnType<CredentialDiagnosticDependencies["createClient"]>["rpc"];
const dependencies: CredentialDiagnosticDependencies = { createClient: () => ({ rpc }), convertAddress: address, fetchAccount: fetchDevnetEncodedAccount };
const valid = await diagnoseCredentialFetch(dependencies);
for (const step of [valid.clientInitialization, valid.publicKeyConversion, valid.confirmedFetch, valid.finalizedFetch,
  ...Object.values(valid.responseShapeValidation), ...Object.values(valid.credentialValidation)]) assert.equal(step.status, "PASS");
assert.deepEqual(requests, [{ key: expectedCredential, commitment: "confirmed", encoding: "base64" }, { key: expectedCredential, commitment: "finalized", encoding: "base64" }]);
assert.deepEqual(JSON.parse(formatCredentialFetchReport(valid, true)), valid);
for (const label of ["Client initialization", "Public key conversion", "Confirmed fetch", "Finalized fetch", "Confirmed response shape", "Finalized response shape"]) assert.ok(formatCredentialFetchReport(valid).includes(label));

let cases = 1;
for (const failedCommitment of ["confirmed", "finalized"] as const) {
  const calls: string[] = [];
  const report = await diagnoseCredentialFetch({ ...dependencies, async fetchAccount(client, key, config) {
    calls.push(config.commitment);
    if (config.commitment === failedCommitment) throw rawError();
    return fetchDevnetEncodedAccount(client, key, config);
  } });
  assert.deepEqual(calls, ["confirmed", "finalized"]);
  assert.equal(report[failedCommitment === "confirmed" ? "confirmedFetch" : "finalizedFetch"].status, "FAIL");
  assert.equal(report[failedCommitment === "confirmed" ? "finalizedFetch" : "confirmedFetch"].status, "PASS");
  assert.equal(report.responseShapeValidation[failedCommitment].status, "SKIPPED");
  assert.ok(!formatCredentialFetchReport(report).includes(secret));
  assert.ok(!formatCredentialFetchReport(report, true).includes(secret));
  cases++;
}
for (const kind of ["initialization", "key"] as const) {
  let fetches = 0;
  const report = await diagnoseCredentialFetch({ ...dependencies,
    createClient() { if (kind === "initialization") throw rawError(); return { rpc }; },
    convertAddress(key) { if (kind === "key") throw rawError(); return address(key); },
    async fetchAccount() { fetches++; throw rawError(); },
  });
  assert.equal(fetches, 0);
  assert.equal(report.confirmedFetch.status, "SKIPPED");
  assert.equal(report.finalizedFetch.status, "SKIPPED");
  assert.equal(kind === "initialization" ? report.clientInitialization.status : report.publicKeyConversion.status, "FAIL");
  assert.ok(!JSON.stringify(report).includes(secret));
  cases++;
}
const localSdk = await diagnoseCredentialFetch({ ...dependencies, async fetchAccount() {
  throw Object.assign(rawError(), { context: { __code: SOLANA_ERROR__ADDRESSES__INVALID_BASE58_ENCODED_ADDRESS, data: secret } });
} });
assert.equal(localSdk.confirmedFetch.diagnostic?.code, "SAS_SDK_ADDRESS_INVALID");
assert.equal(localSdk.finalizedFetch.diagnostic?.code, "SAS_SDK_ADDRESS_INVALID");
assert.ok(!JSON.stringify(localSdk).includes(secret));
cases++;
const malformed = await diagnoseCredentialFetch({ ...dependencies, async fetchAccount() { return { value: secret }; } });
assert.equal(malformed.confirmedFetch.status, "PASS");
assert.equal(malformed.responseShapeValidation.confirmed.status, "FAIL");
assert.equal(malformed.responseShapeValidation.confirmed.diagnostic?.code, "SAS_RPC_RESPONSE_INVALID");
assert.equal(malformed.credentialValidation.confirmed.status, "SKIPPED");
cases++;
const missing = await diagnoseCredentialFetch({ ...dependencies, async fetchAccount(_rpc, key) { return { exists: false, address: key }; } });
assert.equal(missing.responseShapeValidation.finalized.status, "PASS");
assert.equal(missing.credentialValidation.finalized.status, "FAIL");
cases++;
const invalidOwner = await diagnoseCredentialFetch({ ...dependencies, async fetchAccount(client, key, config) {
  return { ...await fetchDevnetEncodedAccount(client, key, config), programAddress: expectedCredential };
} });
assert.equal(invalidOwner.responseShapeValidation.finalized.status, "PASS");
assert.equal(invalidOwner.credentialValidation.finalized.diagnostic?.code, "SAS_CREDENTIAL_REJECTED");
cases++;
// An invalid flag exits before the diagnostic is invoked; no network or file access.
const invalidCli = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/diagnose-sas-credential.ts", "--json", "--unknown", secret], { encoding: "utf8" });
assert.equal(invalidCli.status, 1);
assert.equal(invalidCli.stdout, "");
assert.equal(JSON.parse(invalidCli.stderr).error.code, "CLI_ARGUMENTS_INVALID");
assert.ok(!invalidCli.stderr.includes(secret));
console.log(`Credential dual-commitment diagnostic offline tests: PASS (${cases} scenarios; shared SDK parsing, typed keys, independent commitments, validation and sanitized failures)`);
