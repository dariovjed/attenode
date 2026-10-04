import assert from "node:assert/strict";
import { address, blockhash, createNoopSigner, lamports, type EncodedAccount } from "gill";
import { getAttestationEncoder, deserializeAttestationData, parseCreateAttestationInstruction, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS, SolanaAttestationServiceAccount } from "sas-lib";
import { deploymentSasSchema, serializeDeploymentSasAttestation, toDeploymentSasPayload } from "../attestations/sas.js";
import { deriveDeploymentAttestationPda } from "../attestations/sas-onchain.js";
import { buildCreateDeploymentAttestationTransaction } from "../attestations/sas-transactions.js";
import { createDemoExecution, demoNonce, expectedSchema, expiryFromUnixTime, attestationAccountDiscriminator, verifyDemoAttestation, verifyExistingDemoAttestation } from "./devnet-attestation-demo.js";
import { expectedIdentity, expectedCredential } from "./devnet-schema-verification.js";

const { deployment: demoDeployment, expiry } = createDemoExecution(1_791_072_000_123);
assert.equal(demoDeployment.deployedAt, new Date(1_791_072_000_123).toISOString());
assert.equal(demoNonce, "CsnzzDMbNU889KFzup5qGoUGpkJF574B9Hx8TgxjTLot");
assert.equal(expiry, 1_791_072_000n + 2_592_000n);
assert.throws(() => expiryFromUnixTime(NaN));
assert.throws(() => expiryFromUnixTime(0.5));
const payload = serializeDeploymentSasAttestation(demoDeployment);
assert.deepEqual(deserializeAttestationData(deploymentSasSchema, payload), toDeploymentSasPayload(demoDeployment));
assert.equal(toDeploymentSasPayload(demoDeployment).provenanceProvider, "");
assert.equal(demoDeployment.provenance, undefined);
assert.deepEqual(payload, serializeDeploymentSasAttestation(demoDeployment));
const credential = address(expectedCredential), schema = address(expectedSchema), authority = address(expectedIdentity);
const [attestation] = await deriveDeploymentAttestationPda({ credential, schema, nonce: demoNonce });
const fixture = { discriminator: attestationAccountDiscriminator, credential, schema, nonce: demoNonce,
  signer: authority, expiry, data: payload, tokenAccount: address("11111111111111111111111111111111") };
function account(data: EncodedAccount["data"]): EncodedAccount {
  return { address: attestation, data, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    executable: false, lamports: lamports(1n), space: BigInt(data.length) };
}
const valid = account(getAttestationEncoder().encode(fixture));
verifyDemoAttestation(valid, expiry, demoDeployment);
assert.equal(verifyExistingDemoAttestation(valid, expiry + 60n, createDemoExecution(1_791_072_060_456).deployment), expiry);
assert.throws(() => verifyExistingDemoAttestation(valid, expiry - 1n, demoDeployment));
assert.throws(() => verifyExistingDemoAttestation(account(getAttestationEncoder().encode({ ...fixture, expiry: 1n })), expiry, demoDeployment));
assert.notEqual(attestationAccountDiscriminator, SolanaAttestationServiceAccount.Attestation);
for (const patch of [ { discriminator: 0 }, { credential: authority }, { schema: authority }, { nonce: authority },
  { signer: credential }, { expiry: expiry + 1n }, { data: new Uint8Array() }, { tokenAccount: authority } ]) {
  assert.throws(() => verifyDemoAttestation(account(getAttestationEncoder().encode({ ...fixture, ...patch })), expiry, demoDeployment));
}
assert.throws(() => verifyDemoAttestation(valid, expiry, createDemoExecution(1_791_072_001_123).deployment));
assert.throws(() => verifyExistingDemoAttestation(account(getAttestationEncoder().encode({ ...fixture, expiry: expiry + 1n })), expiry + 60n, demoDeployment));
const changed = Uint8Array.from(payload); changed[changed.length - 1] ^= 1;
assert.throws(() => verifyDemoAttestation(account(getAttestationEncoder().encode({ ...fixture, data: changed })), expiry, demoDeployment));
assert.throws(() => verifyDemoAttestation(valid, 0n, demoDeployment));
assert.throws(() => verifyDemoAttestation({ ...valid, executable: true }, expiry, demoDeployment));
assert.throws(() => verifyDemoAttestation({ ...valid, programAddress: authority }, expiry, demoDeployment));
for (const length of [0, 1, 96, valid.data.length - 1]) {
  assert.throws(() => verifyDemoAttestation(account(valid.data.slice(0, length)), expiry, demoDeployment));
}
const built = await buildCreateDeploymentAttestationTransaction({ authority: createNoopSigner(authority), latestBlockhash: {
  blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n,
} }, { credential, schema, nonce: demoNonce, expiry, deployment: demoDeployment });
assert.equal(built.attestation, attestation);
assert.equal(attestation, "3BAjJ6DN3MvWsbH12GHM6RZqvdAB8VPRcDQeAjfFhBaU");
assert.equal(built.transaction.instructions.length, 1);
const parsed = parseCreateAttestationInstruction(built.instruction);
assert.equal(parsed.accounts.attestation.address, attestation);
assert.equal(parsed.accounts.credential.address, credential);
assert.equal(parsed.accounts.schema.address, schema);
assert.equal(parsed.accounts.authority.address, authority);
assert.equal(parsed.data.nonce, demoNonce);
assert.equal(parsed.data.expiry, expiry);
assert.deepEqual([...parsed.data.data], [...payload]);
console.log(`Public demo nonce: ${demoNonce}`);
console.log(`Expected Attestation PDA: ${attestation}`);
console.log("Attestation offline tests: PASS (read-back, mismatch rejection, malformed data, expiry, single unsigned instruction)");
