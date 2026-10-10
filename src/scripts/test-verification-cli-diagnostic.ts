import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { address, lamports, type Address, type EncodedAccount } from "gill";
import { getAttestationEncoder, getCredentialEncoder, getSchemaEncoder, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import { createDevnetSasReader, type DevnetReaderDependencies } from "../attestations/sas-reader.js";
import { demoApiAttestationAddress } from "../attestations/sas-approval.js";
import { deploymentSasSchema, serializeDeploymentSasAttestation } from "../attestations/sas.js";
import { expectedCredential, expectedIdentity, schemaAccountDiscriminator } from "./devnet-schema-verification.js";
import { expectedSchema, attestationAccountDiscriminator } from "./devnet-attestation-demo.js";
import { createDemoApiExecution, demoApiNonce } from "./devnet-demo-api.js";
import { diagnoseVerificationCli, formatVerificationCliDiagnostic } from "../runtime/verification-cli-diagnostic.js";
import { atDiagnosticStage } from "../runtime/diagnostics.js";

const { deployment, expiry } = createDemoApiExecution(Date.now());
const authority = address(expectedIdentity), credential = address(expectedCredential), schema = address(expectedSchema);
const attestation = address(demoApiAttestationAddress);
function encoded(accountAddress: Address, data: EncodedAccount["data"]): EncodedAccount {
  return { address: accountAddress, data, executable: false, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    lamports: lamports(1n), space: BigInt(data.length) };
}
const accounts = new Map<Address, EncodedAccount>([
  [credential, encoded(credential, getCredentialEncoder().encode({ discriminator: 0, authority, name: Buffer.from("Attenode"), authorizedSigners: [authority] }))],
  [schema, encoded(schema, getSchemaEncoder().encode({ ...deploymentSasSchema, discriminator: schemaAccountDiscriminator, credential }))],
  [attestation, encoded(attestation, getAttestationEncoder().encode({ discriminator: attestationAccountDiscriminator, credential, schema,
    nonce: demoApiNonce, signer: authority, expiry, data: serializeDeploymentSasAttestation(deployment), tokenAccount: address("11111111111111111111111111111111") }))],
]);
const calls: Address[] = [];
const dependencies: DevnetReaderDependencies = {
  createClient: () => ({ rpc: { getAccountInfo() { assert.fail("No actual RPC permitted"); } } }) as unknown as ReturnType<DevnetReaderDependencies["createClient"]>,
  async fetchAccount(_rpc, accountAddress, config) {
    assert.equal(config.commitment, "finalized"); calls.push(accountAddress);
    const account = accounts.get(accountAddress);
    return account ? { ...account, exists: true } : { address: accountAddress, exists: false };
  },
};
const success = await diagnoseVerificationCli(function () {
  assert.equal(arguments.length, 0);
  return createDevnetSasReader(dependencies);
});
assert.equal(success.sasApproval, "SUCCEEDED");
assert.equal(success.sasFactoryInvoked, true);
assert.equal(success.reachedKubernetesAdapter, true);
assert.equal(success.mockObservationInvoked, true);
assert.deepEqual(success.mockCalls, { deployment: 2, replicaSets: 1, pods: 1 });
assert.deepEqual(calls, [credential, schema, attestation]);
assert.equal(success.cliExitCode, 3);
assert.equal(success.diagnosticPassed, true);
assert.equal(success.runtimeVerification, "NOT_EVALUATED_MOCK_KUBERNETES");
assert.equal(success.sanitizedError, null);
assert.deepEqual(JSON.parse(formatVerificationCliDiagnostic(success, true)), success);
assert.ok(formatVerificationCliDiagnostic(success).includes("No runtime VERIFIED claim"));
const secret = "SYNTHETIC_DIAGNOSTIC_SECRET";
for (const [factory, code, operation] of [
  [() => createDevnetSasReader({ ...dependencies, createClient() { throw new Error(secret); } }), "SAS_RPC_INITIALIZATION_FAILED", "RPC_INITIALIZATION"],
  [() => createDevnetSasReader({ ...dependencies, async fetchAccount() { throw new Error(secret); } }), "SAS_RPC_ACCOUNT_FETCH_FAILED", "ACCOUNT_FETCH"],
  [() => createDevnetSasReader({ ...dependencies, async fetchAccount() { return { value: secret }; } }), "SAS_RPC_RESPONSE_INVALID", "RESPONSE_DECODING"],
] as const) {
  const failure = await diagnoseVerificationCli(factory);
  assert.equal(failure.sasApproval, "NOT_COMPLETED");
  assert.equal(failure.cliExitCode, 1);
  assert.equal(failure.sanitizedError?.code, code);
  assert.equal(failure.sanitizedError?.operation, operation);
  if (operation !== "RPC_INITIALIZATION") assert.equal(failure.sanitizedError?.accountKind, "CREDENTIAL");
  assert.equal(failure.reachedKubernetesAdapter, false);
  assert.equal(failure.mockObservationInvoked, false);
  assert.equal(failure.diagnosticPassed, false);
  assert.ok(!formatVerificationCliDiagnostic(failure).includes(secret));
  assert.ok(!formatVerificationCliDiagnostic(failure, true).includes(secret));
}
for (const badAccount of [null, { ...accounts.get(credential)!, programAddress: authority }]) {
  const rejected = await diagnoseVerificationCli(() => createDevnetSasReader({ ...dependencies, async fetchAccount(_rpc, accountAddress) {
    if (accountAddress !== credential) return { ...accounts.get(accountAddress)!, exists: true };
    return badAccount ? { ...badAccount, exists: true } : { address: accountAddress, exists: false };
  } }));
  assert.equal(rejected.sasApproval, "REJECTED");
  assert.equal(rejected.reachedKubernetesAdapter, false);
  assert.equal(rejected.mockObservationInvoked, false);
  assert.equal(rejected.diagnosticPassed, false);
  assert.ok(rejected.sanitizedError);
}
const value = {};
assert.equal(await atDiagnosticStage("SAS_RPC", function () { assert.equal(arguments.length, 0); return value; }), value);
// Argument errors must fail before the default real factory can perform any account reads.
const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/diagnose-verification-cli.ts", "--json", "--unknown", secret], { encoding: "utf8" });
assert.equal(invalid.status, 1);
assert.equal(invalid.stdout, "");
assert.equal(JSON.parse(invalid.stderr).error.stage, "CLI_ARGUMENTS");
assert.ok(!invalid.stderr.includes(secret));
console.log("CLI diagnostic offline tests: PASS (real runner and reader with mocked accounts; success, initialization/fetch/decoding failures, rejected accounts, sanitization, no runtime approval, argument preflight)");
