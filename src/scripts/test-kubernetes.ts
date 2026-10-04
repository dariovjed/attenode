import assert from "node:assert/strict";
import type { V1Deployment, V1ReplicaSet, V1Pod } from "@kubernetes/client-node";
import { approvedDemo, observedV2 } from "../runtime/fixtures.js";
import { verifyKubernetesDeployment, verificationExitCode, type KubernetesReader } from "../runtime/kubernetes.js";

const namespace = "attenode-demo";
const deployment: V1Deployment = { metadata: { name: "demo-api", namespace, uid: "dep-uid", resourceVersion: "1" } };
const owner = (kind: string, name: string, uid: string) => ({ apiVersion: "apps/v1", kind, name, uid, controller: true });
const rs: V1ReplicaSet = { metadata: { name: "demo-rs", namespace, uid: "rs-uid", ownerReferences: [owner("Deployment", "demo-api", "dep-uid")] } };
function pod(name = "demo-pod", v2 = false): V1Pod {
  return { metadata: { name, namespace, uid: name, ownerReferences: [owner("ReplicaSet", "demo-rs", "rs-uid")] },
    spec: { containers: [{ name: "demo-api", image: v2 ? observedV2.imageReference : approvedDemo.imageReference }] },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "demo-api",
      image: v2 ? observedV2.imageReference : approvedDemo.imageReference, imageID: v2 ? observedV2.runtimeImageID! : approvedDemo.runtimeImageID!,
      ready: true, restartCount: 0, state: { running: {} } }] } };
}
let count = 0;
async function test(pods: V1Pod[], expected: string, replicaSets = [rs], dep = deployment) {
  const calls: string[] = [];
  const reader: KubernetesReader = {
    async deployment(ns, name) { assert.equal(ns, namespace); assert.equal(name, "demo-api"); calls.push("deployment"); return dep; },
    async replicaSets(ns) { assert.equal(ns, namespace); calls.push("replicasets"); return replicaSets; },
    async pods(ns) { assert.equal(ns, namespace); calls.push("pods"); return pods; },
  };
  const result = await verifyKubernetesDeployment(reader, approvedDemo);
  assert.equal(result.result.status, expected);
  if (dep.metadata?.uid) assert.deepEqual(calls, ["deployment", "replicasets", "pods", "deployment"]);
  count++;
  return result;
}
assert.equal((await test([pod()], "VERIFIED")).observations[0]?.pod, "demo-pod");
const drift = await test([pod("v2", true)], "TRUST_BROKEN");
assert.deepEqual(drift.result.reasons.map(r => r.code), ["IMAGE_REFERENCE_MISMATCH", "RUNTIME_IMAGE_ID_MISMATCH"]);
const unrelated = pod("unrelated"); unrelated.metadata!.ownerReferences = [owner("ReplicaSet", "other-rs", "other-uid")];
const unrelatedRS: V1ReplicaSet = { metadata: { name: "other-rs", uid: "other-uid", namespace,
  ownerReferences: [owner("Deployment", "other-deployment", "other-deployment-uid")] } };
assert.equal((await test([pod(), unrelated], "VERIFIED", [rs, unrelatedRS])).observations.length, 1);
await test([pod(), unrelated], "INDETERMINATE");
const missing = pod(); missing.status!.containerStatuses = [];
const missingReport = await test([missing], "INDETERMINATE");
assert.ok(missingReport.result.reasons.some(r => r.code === "MISSING_RUNTIME_IMAGE_ID"));
const notReady = pod(); notReady.status!.conditions = [{ type: "Ready", status: "False" }];
await test([notReady], "INDETERMINATE");
const stopped = pod(); stopped.status!.containerStatuses![0]!.state = { waiting: {} };
await test([stopped], "INDETERMINATE");
const deleting = pod(); deleting.metadata!.deletionTimestamp = new Date("2026-10-05T00:00:00Z");
await test([deleting], "INDETERMINATE");
await test([pod("a"), pod("b")], "VERIFIED");
await test([pod("a", true), pod("b", true)], "TRUST_BROKEN");
const overlap = await test([pod("old"), pod("new", true)], "INDETERMINATE");
assert.equal(overlap.result.reasons[0]?.code, "AMBIGUOUS_OBSERVATION");
assert.deepEqual(overlap.perPod.map(p => p.result.status), ["VERIFIED", "TRUST_BROKEN"]);
const rs2 = structuredClone(rs); rs2.metadata!.name = "new-rs"; rs2.metadata!.uid = "new-rs-uid";
const newPod = pod("new", true); newPod.metadata!.ownerReferences = [owner("ReplicaSet", "new-rs", "new-rs-uid")];
await test([pod("old"), newPod], "INDETERMINATE", [rs, rs2]);
for (const owners of [undefined, [], [owner("ReplicaSet", "demo-rs", "rs-uid"), owner("ReplicaSet", "demo-rs", "rs-uid")],
  [{ ...owner("ReplicaSet", "demo-rs", "rs-uid"), controller: false }], [owner("ReplicaSet", "demo-rs", "stale-uid")]]) {
  const malformed = pod(); malformed.metadata!.ownerReferences = owners;
  await test([pod("valid"), malformed], "INDETERMINATE");
}
const badRS = structuredClone(rs); badRS.metadata!.ownerReferences = [];
await test([pod()], "INDETERMINATE", [badRS]);
const staleRS = structuredClone(rs); staleRS.metadata!.ownerReferences![0]!.uid = "old-deployment";
await test([pod()], "INDETERMINATE", [staleRS]);
const duplicate = pod(); duplicate.status!.containerStatuses!.push(duplicate.status!.containerStatuses![0]!);
await test([duplicate], "INDETERMINATE");
const noContainer = pod(); noContainer.spec!.containers = [];
await test([noContainer], "INDETERMINATE");
await test([], "INDETERMINATE");
await test([pod()], "INDETERMINATE", [rs], { metadata: { name: "demo-api", namespace } });
const failed = await verifyKubernetesDeployment({ deployment: async () => { throw new Error("sensitive"); }, replicaSets: async () => [], pods: async () => [] }, approvedDemo);
assert.equal(failed.result.status, "INDETERMINATE");
assert.ok(!JSON.stringify(failed).includes("sensitive"));
let reads = 0;
const changed = await verifyKubernetesDeployment({ deployment: async () => ({ ...deployment, metadata: { ...deployment.metadata, resourceVersion: String(++reads) } }), replicaSets: async () => [rs], pods: async () => [pod()] }, approvedDemo);
assert.equal(changed.result.status, "INDETERMINATE");
assert.equal(verificationExitCode((await test([pod()], "VERIFIED")).result), 0);
assert.equal(verificationExitCode(drift.result), 2);
assert.equal(verificationExitCode(overlap.result), 3);
console.log(`Kubernetes adapter offline tests: PASS (${count + 2} scenarios; only mocked API reads)`);
console.log(`Mock v2: ${drift.result.status}; ${drift.result.reasons.map(r => r.code).join(", ")}; exit ${verificationExitCode(drift.result)}`);
