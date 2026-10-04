import assert from "node:assert/strict";
import { address, blockhash, createNoopSigner, lamports, type EncodedAccount } from "gill";
import { getCredentialEncoder, getSchemaEncoder, parseCreateSchemaInstruction, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS, SolanaAttestationServiceAccount } from "sas-lib";
import { deploymentSasSchema, deploymentSasFieldNames } from "../attestations/sas.js";
import { deriveAttenodeCredentialPda, deriveDeploymentSchemaPda } from "../attestations/sas-onchain.js";
import { buildCreateDeploymentSchemaTransaction } from "../attestations/sas-transactions.js";
import { expectedIdentity, expectedCredential, schemaAccountDiscriminator, verifyCredential, verifySchema } from "./devnet-schema-verification.js";

const authority = address(expectedIdentity);
const credential = address(expectedCredential);
assert.equal((await deriveAttenodeCredentialPda(authority))[0], credential);
const [schema] = await deriveDeploymentSchemaPda({ credential, version: 1 });
function account(data: EncodedAccount["data"]): EncodedAccount {
  return { address: schema, data, executable: false, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    lamports: lamports(1n), space: BigInt(data.length) };
}
const validSchema = { ...deploymentSasSchema, discriminator: schemaAccountDiscriminator, credential };
const encoded = account(getSchemaEncoder().encode(validSchema));
verifySchema(encoded);
assert.notEqual(schemaAccountDiscriminator, SolanaAttestationServiceAccount.Schema);
for (const field of ["name", "description", "layout", "fieldNames"] as const) {
  const changed = Uint8Array.from(validSchema[field]);
  changed[0] = changed[0]! ^ 1;
  assert.throws(() => verifySchema(account(getSchemaEncoder().encode({ ...validSchema, [field]: changed }))));
}
for (const patch of [ { discriminator: 2 }, { credential: authority }, { version: 2 }, { isPaused: true } ]) {
  assert.throws(() => verifySchema(account(getSchemaEncoder().encode({ ...validSchema, ...patch }))));
}
assert.throws(() => verifySchema({ ...encoded, programAddress: authority }));
assert.throws(() => verifySchema({ ...encoded, executable: true }));
for (const length of [0, 1, 32, encoded.data.length - 1]) {
  assert.throws(() => verifySchema(account(encoded.data.slice(0, length))));
}
const validCredential = { discriminator: 0, authority, name: Buffer.from("Attenode"), authorizedSigners: [authority] };
verifyCredential(account(getCredentialEncoder().encode(validCredential)));
for (const patch of [ { discriminator: 1 }, { authority: credential }, { name: Buffer.from("Other") },
  { authorizedSigners: [] }, { authorizedSigners: [credential] }, { authorizedSigners: [authority, credential] } ]) {
  assert.throws(() => verifyCredential(account(getCredentialEncoder().encode({ ...validCredential, ...patch }))));
}
assert.throws(() => verifyCredential({ ...account(getCredentialEncoder().encode(validCredential)), programAddress: authority }));
assert.throws(() => verifyCredential(account(new Uint8Array())));
// A noop signer only supplies account metadata; no key or signing is involved.
const signer = createNoopSigner(authority);
const built = await buildCreateDeploymentSchemaTransaction({ authority: signer, latestBlockhash: {
  blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n,
} }, { credential });
assert.equal(built.schema, schema);
assert.equal(built.transaction.instructions.length, 1);
const parsed = parseCreateSchemaInstruction(built.instruction);
assert.equal(parsed.accounts.credential.address, credential);
assert.equal(parsed.accounts.schema.address, schema);
assert.equal(parsed.accounts.authority.address, authority);
assert.equal(parsed.data.name, "DeploymentAttestationV1");
assert.equal(parsed.data.description, "Attenode deployment attestation v1");
assert.deepEqual([...parsed.data.layout], [...deploymentSasSchema.layout]);
assert.deepEqual(parsed.data.fieldNames, [...deploymentSasFieldNames]);
console.log(`Schema PDA (offline): ${schema}`);
console.log("Devnet Schema offline tests: PASS (account validation, mismatch rejection, malformed data, single Schema instruction)");
