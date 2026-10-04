import assert from "node:assert/strict";
import { formatKubernetesReport, parseVerificationArgs } from "../runtime/kubernetes-output.js";
import { approvedDemo, observedV1, observedV2 } from "../runtime/fixtures.js";
import { verifyRuntimeIdentity } from "../runtime/verification.js";
import { verificationExitCode, type KubernetesVerification } from "../runtime/kubernetes.js";

function report(observations = [observedV1], issues: string[] = []): KubernetesVerification {
  return { approved: approvedDemo, observations, collectionIssues: issues,
    perPod: observations.map(observation => ({ observation, result: verifyRuntimeIdentity(approvedDemo, observation) })),
    result: verifyRuntimeIdentity(approvedDemo, issues.length || observations.length > 1 ? observations : observations[0] ?? null) };
}
assert.equal(parseVerificationArgs([]).json, false);
assert.equal(parseVerificationArgs(["--json"]).json, true);
assert.equal(parseVerificationArgs(["--namespace", "attenode-demo", "--json"]).namespace, "attenode-demo");
assert.throws(() => parseVerificationArgs(["--json=true"]));
assert.throws(() => parseVerificationArgs(["--unknown"]));
for (const [fixture, symbol, exit] of [[report(), "✓ VERIFIED", 0], [report([observedV2]), "✗ TRUST_BROKEN", 2], [report([]), "? INDETERMINATE", 3]] as const) {
  const before = JSON.stringify(fixture);
  const human = formatKubernetesReport(fixture);
  assert.ok(human.startsWith("Attenode Runtime Verification\n"));
  assert.ok(human.includes("attenode-demo/demo-api"));
  assert.ok(human.includes("container: demo-api"));
  assert.ok(human.includes(approvedDemo.runtimeImageID!));
  assert.ok(human.includes(symbol));
  for (const reason of fixture.result.reasons) assert.ok(human.includes(`${reason.code}: ${reason.message}`));
  const json = formatKubernetesReport(fixture, parseVerificationArgs(["--json"]).json);
  assert.deepEqual(JSON.parse(json), fixture);
  assert.ok(!json.includes("Attenode Runtime Verification"));
  assert.equal(verificationExitCode(fixture.result), exit);
  assert.equal(JSON.stringify(fixture), before);
}
const drift = formatKubernetesReport(report([observedV2]));
assert.ok(drift.includes(observedV2.runtimeImageID!));
assert.ok(drift.includes("ready: true"));
const large = report(Array.from({ length: 100 }, (_, i) => ({ ...observedV1, pod: `pod-${i}` })));
const human = formatKubernetesReport(large);
assert.ok(human.includes("pods (100): pod-0, pod-1, pod-2 (+97 more)"));
assert.ok(human.split("\n").length < 30);
assert.equal(JSON.parse(formatKubernetesReport(large, true)).observations.length, 100);
const overlap = formatKubernetesReport(report([observedV1, observedV2], ["Ownership uncertain."]));
assert.ok(overlap.includes("Collection issues\n  Ownership uncertain."));
assert.ok(overlap.includes("? INDETERMINATE"));
assert.ok(overlap.includes("Pod drift reasons: IMAGE_REFERENCE_MISMATCH, RUNTIME_IMAGE_ID_MISMATCH"));
const missing = formatKubernetesReport(report([{ ...observedV1, runtimeImageID: null, ready: false }]));
assert.ok(missing.includes("runtime: missing"));
assert.ok(missing.includes("ready: false"));
console.log("Kubernetes CLI presentation offline tests: PASS (human, --json parsing/full output, multiple Pods, issues, exit codes)");
