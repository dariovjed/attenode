import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { address, blockhash, createNoopSigner, lamports, type Address, type EncodedAccount } from "gill";
import { getAttestationEncoder, deserializeAttestationData, parseCreateAttestationInstruction, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import { serializeDeploymentSasAttestation, deploymentSasSchema, toDeploymentSasPayload } from "../attestations/sas.js";
import { buildCreateDeploymentAttestationTransaction } from "../attestations/sas-transactions.js";
import { deriveDeploymentAttestationPda } from "../attestations/sas-onchain.js";
import { expectedCredential, expectedIdentity } from "./devnet-schema-verification.js";
import { createDemoExecution, demoNonce, expectedSchema, attestationAccountDiscriminator } from "./devnet-attestation-demo.js";
import { createDemoApiExecution, demoApiNonce, parseAttestationArgs, validateDemoApiDeployment, verifyDemoApiAttestation, verifyExistingDemoApiAttestation } from "./devnet-demo-api.js";

const now = Date.parse("2026-10-09T12:00:00.123Z");
const { deployment, expiry } = createDemoApiExecution(now);
const payload = serializeDeploymentSasAttestation(deployment);
// Independent expected values prevent a changed configuration passing unnoticed.
assert.deepEqual(deserializeAttestationData(deploymentSasSchema, payload), {
  repository: "dariovjed/attenode", commitSha: "bb2d3cf15f2b31137e8b5112770587d672458064",
  artifactDigest: "sha256:3190be029b3730939206615819911fac3d6c5285d48eadd5c363826c950c9fee",
  environment: "development", provenanceProvider: "", deployedAt: "2026-10-09T12:00:00.123Z",
});
assert.equal(expiry, BigInt(Math.floor(now / 1000)) + 2_592_000n);
assert.notEqual(demoApiNonce, demoNonce);
for (const patch of [ { repository: "other/repository" }, { commitSha: "a".repeat(40) },
  { artifact: { type: "container" as const, digest: `sha256:${"b".repeat(64)}` } },
  { environment: "production" as const }, { provenance: { provider: "github" as const } },
  { deployedBy: expectedCredential }, { version: 2 }, { deployedAt: "2026-10-09" } ]) {
  assert.throws(() => validateDemoApiDeployment({ ...deployment, ...patch } as typeof deployment));
}
assert.throws(() => createDemoApiExecution(NaN));
assert.throws(() => createDemoApiExecution(-1));
assert.throws(() => validateDemoApiDeployment(createDemoExecution(now).deployment));

const credential: Address = address(expectedCredential), schema: Address = address(expectedSchema), authority: Address = address(expectedIdentity);
const [attestation] = await deriveDeploymentAttestationPda({ credential, schema, nonce: demoApiNonce });
const [fixtureAddress] = await deriveDeploymentAttestationPda({ credential, schema, nonce: demoNonce });
assert.notEqual(attestation, fixtureAddress);
const fields = { discriminator: attestationAccountDiscriminator, credential, schema, nonce: demoApiNonce,
  signer: authority, expiry, data: payload, tokenAccount: address("11111111111111111111111111111111") as Address };
function account(patch: Partial<typeof fields> = {}): EncodedAccount {
  const data = getAttestationEncoder().encode({ ...fields, ...patch });
  return { address: attestation, data, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    executable: false, lamports: lamports(1n), space: BigInt(data.length) };
}
const valid = account();
verifyDemoApiAttestation(valid, expiry, deployment);
// Read-back recovers the original timestamp but still checks every payload byte.
assert.equal(await verifyExistingDemoApiAttestation(valid, now + 60_000), expiry);
await assert.rejects(verifyExistingDemoApiAttestation(valid, Number(expiry) * 1000));
await assert.rejects(verifyExistingDemoApiAttestation(valid, now - 1000));
await assert.rejects(verifyExistingDemoApiAttestation({ ...valid, address: fixtureAddress }, now));
for (const patch of [ { discriminator: 0 }, { credential: authority }, { schema: authority },
  { nonce: demoNonce }, { signer: credential }, { expiry: expiry + 1n }, { tokenAccount: authority },
  { data: serializeDeploymentSasAttestation(createDemoExecution(now).deployment) } ]) {
  assert.throws(() => verifyDemoApiAttestation(account(patch), expiry, deployment));
  await assert.rejects(verifyExistingDemoApiAttestation(account(patch), now));
}
for (const field of ["repository", "commitSha", "artifact", "environment", "provenance"] as const) {
  const changed = { ...deployment, [field]: field === "artifact" ? { type: "container", digest: `sha256:${"b".repeat(64)}` }
    : field === "commitSha" ? "a".repeat(40) : field === "environment" ? "production"
    : field === "provenance" ? { provider: "github" } : "other/repository" } as typeof deployment;
  await assert.rejects(verifyExistingDemoApiAttestation(account({ data: serializeDeploymentSasAttestation(changed) }), now));
}
for (const modified of [ { ...valid, executable: true }, { ...valid, programAddress: authority },
  { ...valid, data: valid.data.slice(0, -1) }, { ...valid, data: new Uint8Array() },
  { ...valid, data: Uint8Array.from([...valid.data, 0]) } ]) {
  await assert.rejects(verifyExistingDemoApiAttestation(modified, now));
}
const built = await buildCreateDeploymentAttestationTransaction({ authority: createNoopSigner(authority), latestBlockhash: {
  blockhash: blockhash("11111111111111111111111111111111"), lastValidBlockHeight: 1n,
} }, { credential, schema, nonce: demoApiNonce, expiry, deployment });
assert.equal(built.attestation, attestation);
assert.equal(built.transaction.instructions.length, 1);
const parsed = parseCreateAttestationInstruction(built.instruction);
assert.equal(parsed.accounts.credential.address, credential);
assert.equal(parsed.accounts.schema.address, schema);
assert.equal(parsed.accounts.attestation.address, attestation);
assert.equal(parsed.accounts.authority.address, authority);
assert.equal(parsed.data.nonce, demoApiNonce);
assert.equal(parsed.data.expiry, expiry);
assert.deepEqual([...parsed.data.data], [...payload]);
assert.equal(toDeploymentSasPayload(deployment).provenanceProvider, "");

assert.equal(parseAttestationArgs([]).payload, "fixture");
assert.equal(parseAttestationArgs([]).execute, false);
assert.equal(parseAttestationArgs(["--payload", "demo-api"]).execute, false);
assert.equal(parseAttestationArgs(["--payload", "demo-api", "--execute"]).execute, true);
assert.equal(parseAttestationArgs(["--verify-only"])["verify-only"], true);
for (const args of [["--payload", "unknown"], ["--execute", "--preview"], ["--execute", "--verify-only"],
  ["--preview", "--verify-only"], ["--execute=true"], ["--unknown"], ["--execute", "--execute"]]) {
  assert.throws(() => parseAttestationArgs(args));
}
// Exercise the real CLI only in its offline mode. No RPC or wallet access occurs.
for (const selected of ["fixture", "demo-api"]) {
  const preview = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/devnet-create-attestation.ts", "--payload", selected, "--preview"], { encoding: "utf8" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.ok(preview.stdout.includes("Offline preview complete"));
  assert.ok(!preview.stdout.includes("OK: Devnet client creation"));
  assert.ok(!preview.stdout.includes("OK: wallet file read"));
  if (selected === "demo-api") assert.ok(preview.stdout.includes(`Attestation PDA: ${attestation}`));
}
console.log(`Real demo-api Attestation PDA (offline): ${attestation}`);
console.log("Real demo-api offline tests: PASS (exact payload, separate PDA, read-back, expiry, mismatch rejection, unsigned instruction, CLI gates and offline previews)");
