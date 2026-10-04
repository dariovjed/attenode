import { parseArgs } from "node:util";
import type { KubernetesVerification } from "./kubernetes.js";

export function parseVerificationArgs(args: string[]) {
  return parseArgs({ args, options: {
    kubeconfig: { type: "string" }, context: { type: "string" }, namespace: { type: "string" },
    deployment: { type: "string" }, container: { type: "string" }, "approved-image": { type: "string" },
    "approved-runtime-image-id": { type: "string" }, json: { type: "boolean", default: false },
  }, strict: true, allowPositionals: false }).values;
}
// Keep terminal control characters out of human display; JSON retains all data.
const display = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

export function formatKubernetesReport(report: KubernetesVerification, json = false): string {
  if (json) return JSON.stringify(report, null, 2);
  const { approved, observations, result } = report;
  const lines = ["Attenode Runtime Verification", "", "Target",
    `  ${display(approved.namespace)}/${display(approved.workload)}`, `  container: ${display(approved.container)}`,
    "", "Approved", `  image: ${display(approved.imageReference)}`,
    `  runtime: ${approved.runtimeImageID ? display(approved.runtimeImageID) : "not supplied"}`, "", "Observed"];
  if (!observations.length) lines.push("  no Pod/runtime observations available");
  // Group consistent replicas to avoid repeating full digests for each Pod.
  const groups = new Map<string, typeof observations>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.imageReference, observation.runtimeImageID, observation.ready]);
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }
  for (const group of [...groups.values()].slice(0, 5)) {
    const first = group[0]!;
    const names = group.slice(0, 3).map(o => display(o.pod)).join(", ");
    const extra = group.length > 3 ? ` (+${group.length - 3} more)` : "";
    lines.push(`  ${group.length === 1 ? "pod" : `pods (${group.length})`}: ${names}${extra}`,
      `  image: ${display(first.imageReference)}`, `  runtime: ${first.runtimeImageID ? display(first.runtimeImageID) : "missing"}`,
      `  ready: ${first.ready}`, "");
  }
  if (groups.size > 5) lines.push(`  ${groups.size - 5} additional observation groups omitted; use --json for all Pods.`, "");
  if (report.collectionIssues.length) {
    lines.push("Collection issues");
    const issues = [...new Set(report.collectionIssues)];
    for (const issue of issues.slice(0, 5)) lines.push(`  ${display(issue)}`);
    if (issues.length > 5) lines.push(`  ${issues.length - 5} additional issues; use --json for details.`);
    lines.push("");
  }
  const symbol = result.status === "VERIFIED" ? "✓" : result.status === "TRUST_BROKEN" ? "✗" : "?";
  lines.push(`${symbol} ${result.status}`);
  for (const reason of result.reasons) lines.push(`  ${reason.code}: ${display(reason.message)}`);
  // Ambiguous aggregate reports retain visible per-Pod drift explanations.
  if (result.status === "INDETERMINATE") {
    const drift = new Set(report.perPod.filter(p => p.result.status === "TRUST_BROKEN")
      .flatMap(p => p.result.reasons.map(r => r.code)));
    if (drift.size) lines.push(`  Pod drift reasons: ${[...drift].join(", ")}`);
  }
  return lines.join("\n");
}
