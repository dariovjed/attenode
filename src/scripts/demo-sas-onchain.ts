import assert from "node:assert/strict";
import { AccountRole, generateKeyPairSigner } from "gill";
import {
  parseCreateAttestationInstruction,
  parseCreateCredentialInstruction,
  parseCreateSchemaInstruction,
} from "sas-lib";

import type { DeploymentAttestation } from "../attestations/deployment.js";
import {
  attenodeCredentialName,
  buildAttenodeCredentialInstruction,
  buildDeploymentAttestationInstruction,
  buildDeploymentSchemaInstruction,
  deriveDeploymentAttestationPda,
  deriveDeploymentSchemaPda,
} from "../attestations/sas-onchain.js";
import {
  deploymentSasFieldNames,
  deploymentSasSchema,
  serializeDeploymentSasAttestation,
} from "../attestations/sas.js";

// Ephemeral signer only: never read, export, or persist any key material.
const signer = await generateKeyPairSigner();
const nonce = signer.address;
// Explicit demo choices, not claims about the program's accepted version/expiry.
const schemaVersion = 1;
const expiry = 2_000_000_000n;
const deployment: DeploymentAttestation = {
  version: 1,
  repository: "attenode/offline-demo",
  commitSha: "0123456789abcdef0123456789abcdef01234567",
  artifact: { type: "container", digest: `sha256:${"a".repeat(64)}` },
  environment: "development",
  provenance: { provider: "github" },
  deployedBy: signer.address,
  deployedAt: "2026-10-04T00:00:00.000Z",
};

const credential = await buildAttenodeCredentialInstruction({ authority: signer });
const schema = await buildDeploymentSchemaInstruction({
  authority: signer,
  credential: credential.credential,
  version: schemaVersion,
});
const attestation = await buildDeploymentAttestationInstruction({
  authority: signer,
  credential: credential.credential,
  schema: schema.schema,
  nonce,
  expiry,
  deployment,
});

const parsedCredential = parseCreateCredentialInstruction(credential.instruction);
assert.equal(parsedCredential.data.name, attenodeCredentialName);
assert.deepEqual(parsedCredential.data.signers, [signer.address]);
const parsedSchema = parseCreateSchemaInstruction(schema.instruction);
assert.deepEqual(parsedSchema.data.fieldNames, [...deploymentSasFieldNames]);
assert.deepEqual(parsedSchema.data.layout, deploymentSasSchema.layout);
const parsedAttestation = parseCreateAttestationInstruction(attestation.instruction);
assert.deepEqual(parsedAttestation.data.data, Uint8Array.from(serializeDeploymentSasAttestation(deployment)));
assert.equal(parsedAttestation.data.nonce, nonce);
assert.equal(parsedAttestation.data.expiry, expiry);
assert.equal(parsedAttestation.accounts.credential.address, credential.credential);
assert.equal(parsedAttestation.accounts.schema.address, schema.schema);
assert.equal(parsedAttestation.accounts.attestation.address, attestation.attestation);
assert.equal(parsedAttestation.accounts.payer.role, AccountRole.WRITABLE_SIGNER);
assert.equal(parsedAttestation.accounts.authority.role, AccountRole.READONLY_SIGNER);
const [repeatedPda] = await deriveDeploymentAttestationPda({
  credential: credential.credential, schema: schema.schema, nonce,
});
assert.equal(repeatedPda, attestation.attestation);
const [otherVersionPda] = await deriveDeploymentSchemaPda({
  credential: credential.credential, version: 2,
});
assert.notEqual(otherVersionPda, schema.schema);
for (const version of [-1, 256, 1.5, NaN]) {
  assert.throws(() => deriveDeploymentSchemaPda({ credential: credential.credential, version }), RangeError);
}

console.log("Attenode offline SAS construction demo (no transactions sent)");
console.log(`Ephemeral signer / nonce: ${signer.address}`);
console.log(`Credential PDA: ${credential.credential}`);
console.log(`Schema PDA (explicit demo version ${schemaVersion}): ${schema.schema}`);
console.log(`Attestation PDA: ${attestation.attestation}`);
console.log(`Explicit demo expiry: ${expiry} (semantics unverified)`);
console.log(`Instruction bytes: ${[credential, schema, attestation].map(({ instruction }) => instruction.data.length).join(", ")}`);
console.log("Offline assertions: PASS");
