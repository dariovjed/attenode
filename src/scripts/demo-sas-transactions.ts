import assert from "node:assert/strict";
import { blockhash, compileTransaction, generateKeyPairSigner } from "gill";
import { parseCreateAttestationInstruction } from "sas-lib";
import { buildDeploymentV1TransactionSequence } from "../attestations/sas-transactions.js";
import { deriveDeploymentSchemaPda } from "../attestations/sas-onchain.js";

const authority = await generateKeyPairSigner();
const payer = await generateKeyPairSigner();
// Validly encoded offline fixture, not a live Devnet blockhash.
const latestBlockhash = {
  blockhash: blockhash("11111111111111111111111111111111"),
  lastValidBlockHeight: 123n,
};
const sequence = await buildDeploymentV1TransactionSequence({ authority, payer, latestBlockhash }, {
  nonce: authority.address,
  expiry: 2_000_000_000n,
  deployment: {
    version: 1,
    repository: "attenode/offline-demo",
    commitSha: "a".repeat(40),
    artifact: { type: "container", digest: `sha256:${"b".repeat(64)}` },
    environment: "development",
    deployedBy: authority.address,
    deployedAt: "2026-10-04T00:00:00.000Z",
  },
});

const [schemaV1] = await deriveDeploymentSchemaPda({ credential: sequence.credential.credential, version: 1 });
assert.equal(sequence.schema.schema, schemaV1);
const parsed = parseCreateAttestationInstruction(sequence.attestation.instruction);
assert.equal(parsed.accounts.credential.address, sequence.credential.credential);
assert.equal(parsed.accounts.schema.address, schemaV1);
assert.equal(parsed.accounts.authority.address, authority.address);
assert.equal(parsed.accounts.payer.address, payer.address);
assert.equal(parsed.data.nonce, authority.address);
assert.equal(parsed.data.expiry, 2_000_000_000n);

for (const [name, built] of Object.entries(sequence)) {
  const message = built.transaction;
  assert.equal(message.version, "legacy");
  assert.equal(message.feePayer.address, payer.address);
  assert.deepEqual(message.lifetimeConstraint, latestBlockhash);
  assert.equal(message.instructions.length, 1);
  assert.deepEqual(message.instructions[0], built.instruction);
  const compiled = compileTransaction(message);
  assert.deepEqual(Object.keys(compiled.signatures).sort(), [authority.address, payer.address].sort());
  assert.ok(Object.values(compiled.signatures).every((signature) => signature === null));
  assert.ok(compiled.messageBytes.length > 0);
  console.log(`${name}: unsigned transaction compiled (${compiled.messageBytes.length} message bytes)`);
}

// Verify the single-signer MVP default as well as the separate-payer case above.
const singleSigner = await buildDeploymentV1TransactionSequence({ authority, latestBlockhash }, {
  nonce: authority.address,
  expiry: parsed.data.expiry,
  deployment: {
    version: 1, repository: "attenode/offline-demo", commitSha: "a".repeat(40),
    artifact: { type: "container", digest: `sha256:${"b".repeat(64)}` },
    environment: "development", deployedBy: authority.address, deployedAt: "2026-10-04T00:00:00.000Z",
  },
});
for (const built of Object.values(singleSigner)) {
  assert.deepEqual(Object.keys(compileTransaction(built.transaction).signatures), [authority.address]);
}
console.log("Offline transaction assertions: PASS; no RPC, signing, or submission performed.");
