import assert from "node:assert/strict";
import { blockhash, generateKeyPairSigner, signature, type Address } from "gill";
import { executeDeploymentV1, SasExecutionError, type SasExecutionTransport } from "../attestations/sas-executor.js";
import { deriveAttenodeCredentialPda, deriveDeploymentSchemaPda, deriveDeploymentAttestationPda } from "../attestations/sas-onchain.js";

const authority = await generateKeyPairSigner();
const [credential] = await deriveAttenodeCredentialPda(authority.address);
const [schema] = await deriveDeploymentSchemaPda({ credential, version: 1 });
const input = {
  nonce: authority.address, expiry: 2_000_000_000n,
  deployment: {
    version: 1 as const, repository: "attenode/offline-test", commitSha: "a".repeat(40),
    artifact: { type: "container" as const, digest: `sha256:${"b".repeat(64)}` },
    environment: "development" as const, deployedBy: authority.address, deployedAt: "2026-10-04T00:00:00.000Z",
  },
};
const [attestation] = await deriveDeploymentAttestationPda({ credential, schema, nonce: input.nonce });
const fakeSignature = signature("1".repeat(64));
function fake(existing: Address[], failure?: "submission" | "confirmation" | "blockhash") {
  const events: string[] = [];
  let blockhashCalls = 0;
  const transport: SasExecutionTransport = {
    async accountExists(address) { events.push(`exists:${address}`); return existing.includes(address); },
    async getLatestBlockhash() {
      events.push("blockhash");
      if (failure === "blockhash") throw new Error("blockhash failed");
      return { blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: BigInt(++blockhashCalls) };
    },
    async submitAndConfirm(message, onAttempt) {
      events.push("submit");
      assert.equal(message.lifetimeConstraint.lastValidBlockHeight, BigInt(blockhashCalls));
      if (failure === "submission") throw new Error("submission failed");
      onAttempt(fakeSignature);
      await Promise.resolve();
      if (failure === "confirmation") throw new Error("confirmation failed");
      events.push("confirmed");
      return fakeSignature;
    },
  };
  return { events, transport };
}
for (const existing of [[], [credential], [credential, schema]]) {
  const stub = fake(existing);
  const result = await executeDeploymentV1({ authority, transport: stub.transport }, input);
  assert.equal(result.credential.status, existing.includes(credential) ? "already-existed" : "created");
  assert.equal(result.schema.status, existing.includes(schema) ? "already-existed" : "created");
  assert.equal(result.attestation.status, "created");
  const execution = stub.events.filter(e => ["blockhash", "submit", "confirmed"].includes(e));
  assert.deepEqual(execution, Array.from({ length: 3 - existing.length }, () => ["blockhash", "submit", "confirmed"]).flat());
  assert.deepEqual(stub.events, [
    `exists:${attestation}`,
    ...[credential, schema, attestation].flatMap(pda => [
      `exists:${pda}`, ...(existing.includes(pda) ? [] : ["blockhash", "submit", "confirmed"]),
    ]),
  ]);
  for (const operation of Object.values(result)) {
    assert.equal(operation.confirmation, operation.status === "created" ? "confirmed" : "not-submitted");
    assert.equal(operation.signature, operation.status === "created" ? fakeSignature : undefined);
  }
}
const collision = fake([attestation]);
await assert.rejects(executeDeploymentV1({ authority, transport: collision.transport }, input), (error: unknown) => {
  assert.ok(error instanceof SasExecutionError);
  assert.equal(error.results.attestation.status, "collision");
  return true;
});
assert.deepEqual(collision.events, [`exists:${attestation}`]);
for (const failure of ["submission", "confirmation", "blockhash"] as const) {
  const stub = fake([credential], failure);
  await assert.rejects(executeDeploymentV1({ authority, transport: stub.transport }, input), (error: unknown) => {
    assert.ok(error instanceof SasExecutionError);
    assert.equal(error.operation, "schema");
    assert.equal(error.results.credential.status, "already-existed");
    assert.equal(error.results.schema.status, "failed");
    assert.equal(error.results.attestation.status, "pending");
    assert.equal(error.results.schema.confirmation, failure === "confirmation" ? "unknown" : "not-submitted");
    assert.equal(error.results.schema.signature, failure === "confirmation" ? fakeSignature : undefined);
    assert.ok(error.cause instanceof Error);
    return true;
  });
  assert.equal(stub.events.filter(event => event === `exists:${attestation}`).length, 1);
}
console.log("SAS executor offline tests: PASS (fresh, bootstrap skips, collision, submission/confirmation/blockhash failures)");
