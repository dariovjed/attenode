import assert from "node:assert/strict";
import { approvedDemo, observedV1, observedV2 } from "../runtime/fixtures.js";
import { verifyRuntimeIdentity, type VerificationStatus, type ReasonCode } from "../runtime/verification.js";

let cases = 0;
function check(approved: unknown, observed: unknown, status: VerificationStatus, codes: ReasonCode[]) {
  const result = verifyRuntimeIdentity(approved, observed);
  assert.equal(result.status, status);
  assert.deepEqual(result.reasons.map(reason => reason.code), codes);
  assert.ok(result.reasons.every(reason => reason.message.length > 0));
  cases++;
  return result;
}
check(approvedDemo, observedV1, "VERIFIED", ["BASELINE_MATCH"]);
check(approvedDemo, observedV2, "TRUST_BROKEN", ["IMAGE_REFERENCE_MISMATCH", "RUNTIME_IMAGE_ID_MISMATCH"]);
check(approvedDemo, { ...observedV1, imageReference: observedV2.imageReference }, "TRUST_BROKEN", ["IMAGE_REFERENCE_MISMATCH"]);
check(approvedDemo, { ...observedV1, runtimeImageID: observedV2.runtimeImageID }, "TRUST_BROKEN", ["RUNTIME_IMAGE_ID_MISMATCH"]);
const { runtimeImageID: _, ...referenceOnly } = approvedDemo;
assert.equal(check(referenceOnly, observedV1, "VERIFIED", ["BASELINE_MATCH"]).basis, "image-reference");
check(referenceOnly, observedV2, "TRUST_BROKEN", ["IMAGE_REFERENCE_MISMATCH"]);
for (const missing of [undefined, null, ""]) {
  check(approvedDemo, { ...observedV1, runtimeImageID: missing }, "INDETERMINATE", ["MISSING_RUNTIME_IMAGE_ID"]);
}
for (const ready of [false, undefined]) check(approvedDemo, { ...observedV1, ready }, "INDETERMINATE", ["CONTAINER_NOT_READY"]);
check(approvedDemo, { ...observedV1, runtimeImageID: null, ready: false }, "INDETERMINATE", ["MISSING_RUNTIME_IMAGE_ID", "CONTAINER_NOT_READY"]);
check(approvedDemo, { ...observedV2, runtimeImageID: null, ready: false }, "TRUST_BROKEN", ["IMAGE_REFERENCE_MISMATCH", "MISSING_RUNTIME_IMAGE_ID", "CONTAINER_NOT_READY"]);
for (const missing of [null, undefined]) check(approvedDemo, missing, "INDETERMINATE", ["MISSING_OBSERVATION"]);
for (const ambiguous of [[], [observedV1], [observedV1, observedV2]]) check(approvedDemo, ambiguous, "INDETERMINATE", ["AMBIGUOUS_OBSERVATION"]);
for (const field of ["namespace", "workload", "container"]) {
  check(approvedDemo, { ...observedV1, [field]: "other" }, "INDETERMINATE", ["TARGET_MISMATCH"]);
}
for (const bad of [42, "v1", {}, { ...observedV1, pod: "" }, { ...observedV1, ready: "true" },
  { ...observedV1, imageReference: " v1" }, { ...observedV1, imageReference: "repo@sha256:bad" },
  { ...observedV1, runtimeImageID: "sha256:bad" }, { ...observedV1, runtimeImageID: 42 }]) {
  check(approvedDemo, bad, "INDETERMINATE", ["MALFORMED_OBSERVATION"]);
}
for (const bad of [null, [], {}, { ...approvedDemo, namespace: "" }, { ...approvedDemo, runtimeImageID: "" },
  { ...approvedDemo, runtimeImageID: "sha256:bad" }, { ...approvedDemo, imageReference: "repo@sha256:bad" }]) {
  check(bad, observedV1, "INDETERMINATE", ["INVALID_APPROVAL"]);
}
const prefixed = `containerd://${approvedDemo.runtimeImageID}`;
check({ ...approvedDemo, runtimeImageID: prefixed }, { ...observedV1, runtimeImageID: prefixed }, "VERIFIED", ["BASELINE_MATCH"]);
check(approvedDemo, { ...observedV1, runtimeImageID: prefixed }, "TRUST_BROKEN", ["RUNTIME_IMAGE_ID_MISMATCH"]);
const immutable = `registry.example/attenode/demo-api@${approvedDemo.runtimeImageID}`;
check({ ...referenceOnly, imageReference: immutable }, { ...observedV1, imageReference: immutable }, "VERIFIED", ["BASELINE_MATCH"]);
const before = JSON.stringify({ approvedDemo, observedV1 });
assert.deepEqual(verifyRuntimeIdentity(approvedDemo, observedV1), verifyRuntimeIdentity(approvedDemo, observedV1));
assert.equal(JSON.stringify({ approvedDemo, observedV1 }), before);
console.log(`Runtime verification offline tests: PASS (${cases} cases; deterministic and non-mutating)`);
