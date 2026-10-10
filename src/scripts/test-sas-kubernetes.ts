import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { address, lamports, type Address, type EncodedAccount } from "gill";
import { getAttestationEncoder, getCredentialEncoder, getSchemaEncoder, SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS } from "sas-lib";
import type { V1Deployment, V1Pod, V1ReplicaSet } from "@kubernetes/client-node";
import type { SasAccountReader } from "../attestations/sas-reader.js";
import { demoApiAttestationAddress } from "../attestations/sas-approval.js";
import { deploymentSasSchema, serializeDeploymentSasAttestation } from "../attestations/sas.js";
import { expectedCredential, expectedIdentity, schemaAccountDiscriminator } from "./devnet-schema-verification.js";
import { attestationAccountDiscriminator, createDemoExecution, demoNonce, expectedSchema } from "./devnet-attestation-demo.js";
import { createDemoApiExecution, demoApiNonce } from "./devnet-demo-api.js";
import { verifySasKubernetesDeployment, validateSasBindingPolicy, type SasBindingPolicy } from "../runtime/sas-verification.js";
import { verificationExitCode, type KubernetesReader } from "../runtime/kubernetes.js";
import { parseVerificationArgs, formatSasKubernetesReport } from "../runtime/kubernetes-output.js";

const now = Date.parse("2026-10-09T12:00:00.123Z");
const { deployment, expiry } = createDemoApiExecution(now);
const digest = "sha256:3190be029b3730939206615819911fac3d6c5285d48eadd5c363826c950c9fee";
const reference = `ghcr.io/dariovjed/demo-api@${digest}`;
const other = `ghcr.io/dariovjed/demo-api@sha256:${"a".repeat(64)}`;
const policy: SasBindingPolicy = { namespace: "attenode-demo", workload: "demo-api", container: "demo-api", imageRepository: "ghcr.io/dariovjed/demo-api" };
const authority: Address = address(expectedIdentity), credential: Address = address(expectedCredential), schema: Address = address(expectedSchema);
const attestation: Address = address(demoApiAttestationAddress);
const attestationFields = { discriminator: attestationAccountDiscriminator, credential, schema, nonce: demoApiNonce,
  signer: authority, expiry, data: serializeDeploymentSasAttestation(deployment), tokenAccount: address("11111111111111111111111111111111") as Address };
function encoded(accountAddress: Address, data: EncodedAccount["data"]): EncodedAccount {
  return { address: accountAddress, data, executable: false, programAddress: SOLANA_ATTESTATION_SERVICE_PROGRAM_ADDRESS,
    lamports: lamports(1n), space: BigInt(data.length) };
}
const accounts = new Map<Address, EncodedAccount>([
  [credential, encoded(credential, getCredentialEncoder().encode({ discriminator: 0, authority, name: Buffer.from("Attenode"), authorizedSigners: [authority] }))],
  [schema, encoded(schema, getSchemaEncoder().encode({ ...deploymentSasSchema, discriminator: schemaAccountDiscriminator, credential }))],
  [attestation, encoded(attestation, getAttestationEncoder().encode(attestationFields))],
]);
function sasReader(changed = accounts): SasAccountReader {
  return { async account(accountAddress) { assert.ok(accounts.has(accountAddress)); return changed.get(accountAddress) ?? null; } };
}
function changedAccount(accountAddress: Address, account: EncodedAccount | null) {
  const changed = new Map(accounts);
  if (account) changed.set(accountAddress, account); else changed.delete(accountAddress);
  return sasReader(changed);
}
const owner = (kind: string, name: string, uid: string) => ({ apiVersion: "apps/v1", kind, name, uid, controller: true });
const kubeDeployment: V1Deployment = { metadata: { namespace: policy.namespace, name: policy.workload, uid: "deployment-uid", resourceVersion: "1" } };
const replicaSet: V1ReplicaSet = { metadata: { namespace: policy.namespace, name: "demo-rs", uid: "rs-uid", ownerReferences: [owner("Deployment", policy.workload, "deployment-uid")] } };
function pod(image = reference, imageID: string | null = reference, ready = true, name = "demo-pod"): V1Pod {
  return { metadata: { namespace: policy.namespace, name, uid: name, ownerReferences: [owner("ReplicaSet", "demo-rs", "rs-uid")] },
    spec: { containers: [{ name: policy.container, image }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: ready ? "True" : "False" }],
      containerStatuses: [{ name: policy.container, image, imageID: imageID ?? "", ready, restartCount: 0, state: { running: {} } }] } };
}
function kubeReader(pods: V1Pod[]): KubernetesReader {
  return { async deployment() { return kubeDeployment; }, async replicaSets() { return [replicaSet]; }, async pods() { return pods; } };
}
let cases = 0;
async function check(pods: V1Pod[], expected: string, reader = sasReader()) {
  const report = await verifySasKubernetesDeployment(reader, () => kubeReader(pods), policy, () => now);
  assert.equal(report.result.status, expected);
  assert.equal(verificationExitCode(report.result), expected === "VERIFIED" ? 0 : expected === "TRUST_BROKEN" ? 2 : 3);
  cases++;
  return report;
}
const approved = await check([pod()], "VERIFIED");
assert.equal(approved.sas.status, "VERIFIED");
assert.equal(approved.sas.payload?.artifactDigest, digest);
assert.equal(approved.kubernetes?.approved.imageReference, `${policy.imageRepository}@${approved.sas.payload!.artifactDigest}`);
assert.equal(approved.kubernetes?.approved.runtimeImageID, undefined);
assert.equal(approved.kubernetes?.result.status, "VERIFIED");
assert.equal(approved.artifact.status, "VERIFIED");
const drift = await check([pod(other, other)], "TRUST_BROKEN");
assert.equal(drift.sas.status, "VERIFIED");
assert.equal(drift.kubernetes?.result.status, "TRUST_BROKEN");
assert.equal(drift.artifact.status, "TRUST_BROKEN");
await check([pod()], "VERIFIED"); // rollback
const hiddenDrift = await check([pod(reference, other)], "TRUST_BROKEN");
assert.equal(hiddenDrift.kubernetes?.result.status, "VERIFIED");
assert.equal(hiddenDrift.artifact.status, "TRUST_BROKEN");
const configuredDrift = await check([pod(other, reference)], "TRUST_BROKEN");
assert.equal(configuredDrift.artifact.status, "VERIFIED");
for (const imageID of [null, "", digest, `containerd://${digest}`, `docker://${digest}`, `docker-pullable://${reference}`,
  `containerd://${reference}`, `unknown://${reference}`, "sha256:bad", "not-an-image-id"]) {
  await check([pod(reference, imageID)], "INDETERMINATE");
}
const unsupportedDrift = await check([pod("attenode/demo-api:v2", digest)], "TRUST_BROKEN");
assert.equal(unsupportedDrift.sas.status, "VERIFIED");
assert.equal(unsupportedDrift.kubernetes?.result.status, "TRUST_BROKEN");
assert.equal(unsupportedDrift.artifact.status, "INDETERMINATE");
await check([pod(other, null)], "INDETERMINATE");
await check([pod(other, "sha256:bad")], "INDETERMINATE");
await check([pod(other, digest, false)], "INDETERMINATE");
await check([pod(other, digest, true, "a"), pod(other, digest, true, "b")], "TRUST_BROKEN");
await check([pod(other, digest, true, "a"), pod(other, other, true, "b")], "INDETERMINATE");
await check([pod(reference, reference, true, "a"), pod(reference, digest, true, "b")], "INDETERMINATE");
let collectionReads = 0;
const failedCollection = await verifySasKubernetesDeployment(sasReader(), () => ({ ...kubeReader([pod(other, digest)]),
  async deployment() { if (++collectionReads === 2) throw new Error("synthetic collection failure"); return kubeDeployment; },
}), policy, () => now);
assert.equal(failedCollection.result.status, "INDETERMINATE");
assert.equal(failedCollection.artifact.status, "INDETERMINATE");
await check([pod(reference, reference, false)], "INDETERMINATE");
await check([pod(other, other, false)], "INDETERMINATE");
await check([], "INDETERMINATE");
await check([pod(reference, reference, true, "a"), pod(reference, reference, true, "b")], "VERIFIED");
const rollout = await check([pod(reference, reference, true, "old"), pod(other, other, true, "new")], "INDETERMINATE");
assert.deepEqual(rollout.artifact.perPod.map(p => p.result.status), ["VERIFIED", "TRUST_BROKEN"]);
const orphan = pod(); orphan.metadata!.ownerReferences = [];
await check([orphan], "INDETERMINATE");
const noStatus = pod(); noStatus.status!.containerStatuses = [];
await check([noStatus], "INDETERMINATE");
const duplicate = pod(); duplicate.status!.containerStatuses!.push(duplicate.status!.containerStatuses![0]!);
await check([duplicate], "INDETERMINATE");
const deleting = pod(); deleting.metadata!.deletionTimestamp = new Date(now);
await check([deleting], "INDETERMINATE");

async function rejected(reader: SasAccountReader) {
  let kubeAccess = 0;
  const report = await verifySasKubernetesDeployment(reader, () => { kubeAccess++; return kubeReader([pod()]); }, policy, () => now);
  assert.equal(report.sas.status, "INDETERMINATE");
  assert.equal(report.result.status, "INDETERMINATE");
  assert.equal(report.kubernetes, null);
  assert.equal(kubeAccess, 0);
  assert.equal(report.sas.payload, undefined); // No locally substituted approval after rejection.
  cases++;
}
for (const accountAddress of [credential, schema, attestation]) {
  await rejected(changedAccount(accountAddress, null));
  for (const patch of [ { programAddress: authority }, { executable: true }, { address: authority },
    { data: new Uint8Array() }, { data: accounts.get(accountAddress)!.data.slice(0, -1) } ]) {
    await rejected(changedAccount(accountAddress, { ...accounts.get(accountAddress)!, ...patch }));
  }
}
for (const patch of [ { nonce: demoNonce }, { credential: authority }, { schema: authority }, { signer: credential },
  { expiry: BigInt(Math.floor(now / 1000)) }, { expiry: expiry + 1n }, { discriminator: 0 }, { tokenAccount: authority },
  { data: serializeDeploymentSasAttestation(createDemoExecution(now).deployment) } ]) {
  await rejected(changedAccount(attestation, encoded(attestation, getAttestationEncoder().encode({ ...attestationFields, ...patch }))));
}
for (const patch of [ { repository: "other/repository" }, { commitSha: "a".repeat(40) },
  { environment: "production" as const }, { artifact: { type: "container" as const, digest: `sha256:${"b".repeat(64)}` } },
  { provenance: { provider: "github" as const } } ]) {
  const data = serializeDeploymentSasAttestation({ ...deployment, ...patch });
  await rejected(changedAccount(attestation, encoded(attestation, getAttestationEncoder().encode({ ...attestationFields, data }))));
}
for (const patch of [ { discriminator: 2 }, { version: 2 }, { isPaused: true }, { credential: authority },
  { layout: Uint8Array.of(12) }, { fieldNames: Uint8Array.of(0) } ]) {
  await rejected(changedAccount(schema, encoded(schema, getSchemaEncoder().encode({ ...deploymentSasSchema, discriminator: schemaAccountDiscriminator, credential, ...patch }))));
}
for (const patch of [ { authority: credential }, { authorizedSigners: [credential] }, { authorizedSigners: [] } ]) {
  await rejected(changedAccount(credential, encoded(credential, getCredentialEncoder().encode({ discriminator: 0, authority, name: Buffer.from("Attenode"), authorizedSigners: [authority], ...patch }))));
}
let ticks = 0;
const expiresDuringRead = await verifySasKubernetesDeployment(sasReader(), () => kubeReader([pod()]), policy,
  () => ticks++ === 0 ? now : Number(expiry) * 1000);
assert.equal(expiresDuringRead.sas.status, "INDETERMINATE");
assert.equal(expiresDuringRead.result.status, "INDETERMINATE");
ticks = 0;
const driftExpiresDuringRead = await verifySasKubernetesDeployment(sasReader(), () => kubeReader([pod(other, digest)]), policy,
  () => ticks++ === 0 ? now : Number(expiry) * 1000);
assert.equal(driftExpiresDuringRead.sas.status, "INDETERMINATE");
assert.equal(driftExpiresDuringRead.result.status, "INDETERMINATE");
await assert.rejects(verifySasKubernetesDeployment({ async account() { throw new Error("sensitive transport detail"); } }, () => kubeReader([pod()]), policy, () => now));
for (const field of ["namespace", "workload", "container", "imageRepository"] as const) {
  assert.throws(() => validateSasBindingPolicy({ ...policy, [field]: "other" }));
}
assert.equal(parseVerificationArgs([]).sas, false);
assert.equal(parseVerificationArgs(["--sas"]).sas, true);
for (const args of [["--sas", "--approved-image", reference], ["--sas", "--approved-runtime-image-id", reference],
  ["--image-repository", policy.imageRepository], ["--sas", "--sas"], ["--sas=true"]]) assert.throws(() => parseVerificationArgs(args));
for (const report of [approved, drift, rollout]) {
  const before = JSON.stringify(report);
  assert.deepEqual(JSON.parse(formatSasKubernetesReport(report, true)), report);
  const human = formatSasKubernetesReport(report);
  assert.ok(human.includes(`Overall: ${report.result.status}`));
  assert.ok(human.includes("SAS attestation validation: VERIFIED"));
  assert.ok(human.includes("Runtime artifact identity evidence:"));
  assert.ok(human.includes("Kubernetes baseline agreement"));
  assert.ok(human.includes("Local binding policy (not on-chain claims)"));
  assert.equal(JSON.stringify(report), before);
}
// Invalid CLI combinations fail before reader construction; no kubeconfig or RPC is accessed.
const invalidCli = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/verify-k8s.ts", "--sas", "--approved-image", reference], { encoding: "utf8" });
assert.equal(invalidCli.status, 1);
assert.equal(invalidCli.stdout, "");
assert.ok(!invalidCli.stderr.includes("sensitive transport detail"));
console.log(`SAS + Kubernetes offline tests: PASS (${cases} scenarios; approval -> VERIFIED, drift -> TRUST_BROKEN, rollback -> VERIFIED; no live access)`);
